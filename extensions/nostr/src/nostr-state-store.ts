import os from "node:os";
import path from "node:path";
import { safeParseJsonWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
import { z } from "zod";
import { getNostrRuntime } from "./runtime.js";

const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;
const SOULFACTORY_BRIDGE_STATE_VERSION = 1;

type NostrBusState = {
  version: 2;
  /** Unix timestamp (seconds) of the last processed event */
  lastProcessedAt: number | null;
  /** Gateway startup timestamp (seconds) - events before this are old */
  gatewayStartedAt: number | null;
  /** Recent processed event IDs for overlap dedupe across restarts */
  recentEventIds: string[];
};

/** Profile publish state (separate from bus state) */
type NostrProfileState = {
  version: 1;
  /** Unix timestamp (seconds) of last successful profile publish */
  lastPublishedAt: number | null;
  /** Event ID of the last published profile */
  lastPublishedEventId: string | null;
  /** Per-relay publish results from last attempt */
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
};

export type NostrSoulFactoryBridgeState = {
  version: 1;
  recentEventIds: string[];
  idempotencyKeys: Record<string, string>;
};

const NullableFiniteNumberSchema = z.number().finite().nullable().catch(null);
const NostrBusStateV1Schema = z.object({
  version: z.literal(1),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
});

const NostrBusStateSchema = z.object({
  version: z.literal(2),
  lastProcessedAt: NullableFiniteNumberSchema,
  gatewayStartedAt: NullableFiniteNumberSchema,
  recentEventIds: z
    .array(z.unknown())
    .catch([])
    .transform((ids) => ids.filter((id): id is string => typeof id === "string")),
});

const NostrProfileStateSchema = z.object({
  version: z.literal(1),
  lastPublishedAt: NullableFiniteNumberSchema,
  lastPublishedEventId: z.string().nullable().catch(null),
  lastPublishResults: z
    .record(z.string(), z.enum(["ok", "failed", "timeout"]))
    .nullable()
    .catch(null),
});

const NostrSoulFactoryBridgeStateSchema = z.object({
  version: z.literal(1),
  recentEventIds: z
    .array(z.unknown())
    .catch([])
    .transform((ids) => ids.filter((id): id is string => typeof id === "string")),
  idempotencyKeys: z.record(z.string(), z.string()).catch({}),
});

function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveNostrStatePath(accountId?: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `bus-state-${normalized}.json`);
}

function resolveNostrProfileStatePath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `profile-state-${normalized}.json`);
}

function resolveNostrSoulFactoryBridgeStatePath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `soulfactory-bridge-state-${normalized}.json`);
}

function safeParseState(raw: string): NostrBusState | null {
  const parsedV2 = safeParseJsonWithSchema(NostrBusStateSchema, raw);
  if (parsedV2) {
    return parsedV2;
  }

  const parsedV1 = safeParseJsonWithSchema(NostrBusStateV1Schema, raw);
  if (!parsedV1) {
    return null;
  }

  // Back-compat: v1 state files
  return {
    version: 2,
    lastProcessedAt: parsedV1.lastProcessedAt,
    gatewayStartedAt: parsedV1.gatewayStartedAt,
    recentEventIds: [],
  };
}

export async function readNostrBusState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrBusState | null> {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  try {
    const raw = await privateFileStore(path.dirname(filePath)).readTextIfExists(
      path.basename(filePath),
    );
    if (raw === null) {
      return null;
    }
    return safeParseState(raw);
  } catch {
    return null;
  }
}

export async function writeNostrBusState(params: {
  accountId?: string;
  lastProcessedAt: number;
  gatewayStartedAt: number;
  recentEventIds?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  const payload: NostrBusState = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    recentEventIds: (params.recentEventIds ?? []).filter((x): x is string => typeof x === "string"),
  };
  await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), payload, {
    trailingNewline: true,
  });
}

/**
 * Determine the `since` timestamp for subscription.
 * Returns the later of: lastProcessedAt or gatewayStartedAt (both from disk),
 * falling back to `now` for fresh starts.
 */
export function computeSinceTimestamp(
  state: NostrBusState | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  if (!state) {
    return nowSec;
  }

  // Use the most recent timestamp we have
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t): t is number => t !== null && t > 0,
  );

  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}

// ============================================================================
// Profile State Management
// ============================================================================

function safeParseProfileState(raw: string): NostrProfileState | null {
  return safeParseJsonWithSchema(NostrProfileStateSchema, raw);
}

export async function readNostrProfileState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrProfileState | null> {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  try {
    const raw = await privateFileStore(path.dirname(filePath)).readTextIfExists(
      path.basename(filePath),
    );
    if (raw === null) {
      return null;
    }
    return safeParseProfileState(raw);
  } catch {
    return null;
  }
}

export async function writeNostrProfileState(params: {
  accountId?: string;
  lastPublishedAt: number;
  lastPublishedEventId: string;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  const payload: NostrProfileState = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults,
  };
  await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), payload, {
    trailingNewline: true,
  });
}

export async function readNostrSoulFactoryBridgeState(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NostrSoulFactoryBridgeState | null> {
  const filePath = resolveNostrSoulFactoryBridgeStatePath(params.accountId, params.env);
  try {
    const raw = await privateFileStore(path.dirname(filePath)).readTextIfExists(
      path.basename(filePath),
    );
    if (raw === null) {
      return null;
    }
    return safeParseJsonWithSchema(NostrSoulFactoryBridgeStateSchema, raw);
  } catch {
    return null;
  }
}

export async function writeNostrSoulFactoryBridgeState(params: {
  accountId?: string;
  state: Omit<NostrSoulFactoryBridgeState, "version">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveNostrSoulFactoryBridgeStatePath(params.accountId, params.env);
  const payload: NostrSoulFactoryBridgeState = {
    version: SOULFACTORY_BRIDGE_STATE_VERSION,
    recentEventIds: params.state.recentEventIds.filter((x): x is string => typeof x === "string"),
    idempotencyKeys: Object.fromEntries(
      Object.entries(params.state.idempotencyKeys).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    ),
  };
  await privateFileStore(path.dirname(filePath)).writeJson(path.basename(filePath), payload, {
    trailingNewline: true,
  });
}
