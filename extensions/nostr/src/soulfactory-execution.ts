import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { spawnSessionDirect } from "openclaw/plugin-sdk/sessions-spawn-runtime";
import { getNostrRuntime } from "./runtime.js";
import type {
  SoulFactoryExecutionOutcome,
  SoulFactoryMethod,
  ValidatedSoulFactoryRequest,
} from "./soulfactory-bridge.js";

type ManagedAgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  identity?: { name?: string; avatar?: string };
  soulFactory?: {
    managed?: boolean;
    soulId?: string;
    soulEvent?: string;
    soulDraft?: string;
    ownerPubkey?: string;
    controllerPubkey?: string;
    runtimePubkey?: string;
    capabilityRef?: string;
    controlRelays?: string[];
    specHash?: string;
    lastOperatorRequestEvent?: string;
    lastRuntimeRequestEvent?: string;
    runtimeBinding?: string;
    state?: "running" | "suspended" | "revoked" | "failed";
    session?: { key?: string; runId?: string; spawnedAt?: number };
    updatedAt?: number;
  };
};

type ProvisionParams = {
  identity?: { name?: string; purpose?: string; tier?: string; nip05?: string };
  runtime?: { target?: string; capability_ref?: string };
  relay_policy?: { read?: string[]; write?: string[]; control?: string[] };
  workspace?: { repo?: string; branch?: string; environment?: string };
  assets?: { avatar_ref?: string; voice_ref?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
  );
  return out.length > 0 ? [...new Set(out.map((entry) => entry.trim()))] : undefined;
}

function normalizeAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "soulfactory-agent";
}

function normalizeProvisionParams(params: Record<string, unknown>): ProvisionParams {
  const identity = isRecord(params.identity) ? params.identity : {};
  const runtime = isRecord(params.runtime) ? params.runtime : {};
  const relayPolicy = isRecord(params.relay_policy) ? params.relay_policy : {};
  const workspace = isRecord(params.workspace) ? params.workspace : {};
  const assets = isRecord(params.assets) ? params.assets : {};
  return {
    identity: {
      name: readString(identity.name),
      purpose: readString(identity.purpose),
      tier: readString(identity.tier),
      nip05: readString(identity.nip05),
    },
    runtime: {
      target: readString(runtime.target),
      capability_ref: readString(runtime.capability_ref),
    },
    relay_policy: {
      read: readStringArray(relayPolicy.read),
      write: readStringArray(relayPolicy.write),
      control: readStringArray(relayPolicy.control),
    },
    workspace: {
      repo: readString(workspace.repo),
      branch: readString(workspace.branch),
      environment: readString(workspace.environment),
    },
    assets: {
      avatar_ref: readString(assets.avatar_ref),
      voice_ref: readString(assets.voice_ref),
    },
  };
}

function listAgents(cfg: OpenClawConfig): ManagedAgentEntry[] {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? (agents as ManagedAgentEntry[]) : [];
}

function findAgentEntry(cfg: OpenClawConfig, agentId: string): ManagedAgentEntry | undefined {
  const normalized = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === normalized);
}

function upsertManagedAgent(
  cfg: OpenClawConfig,
  agentId: string,
  patch: Partial<ManagedAgentEntry>,
): ManagedAgentEntry {
  const normalized = normalizeAgentId(agentId);
  cfg.agents ??= {};
  cfg.agents.list ??= [];
  const list = cfg.agents.list as ManagedAgentEntry[];
  const index = list.findIndex((entry) => normalizeAgentId(entry.id) === normalized);
  const existing = index >= 0 ? list[index] : ({ id: normalized } satisfies ManagedAgentEntry);
  const identity =
    existing.identity || patch.identity
      ? {
          ...(existing.identity ?? {}),
          ...(patch.identity ?? {}),
        }
      : undefined;
  const next: ManagedAgentEntry = {
    ...existing,
    ...patch,
    id: normalized,
    ...(identity ? { identity } : {}),
    soulFactory: {
      ...(existing.soulFactory ?? {}),
      ...(patch.soulFactory ?? {}),
      managed: true,
    },
  };
  if (!next.identity?.name) {
    delete next.identity;
  }
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  return next;
}

function resultFor(params: {
  request: ValidatedSoulFactoryRequest;
  state: string;
  capabilityRef?: string;
  session?: { key?: string; runId?: string };
  warnings?: string[];
}): Record<string, unknown> {
  return {
    agent_id: params.request.agentId,
    runtime: "openclaw",
    runtime_binding: `openclaw://agents/${params.request.agentId}`,
    state: params.state,
    spec_hash: params.request.specHash,
    capability_ref: params.capabilityRef,
    observed_at: Math.floor(Date.now() / 1000),
    warnings: params.warnings ?? [],
    ...(params.session ? { session: params.session } : {}),
  };
}

function rejected(
  code: NonNullable<SoulFactoryExecutionOutcome["error"]>["code"],
  message: string,
): SoulFactoryExecutionOutcome {
  return {
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

function failed(message: string, retryable = true): SoulFactoryExecutionOutcome {
  return {
    status: "failed",
    error: { code: "execution_failed", message, retryable },
  };
}

function buildProvisionTask(request: ValidatedSoulFactoryRequest, params: ProvisionParams): string {
  const lines = [
    `SoulFactory provisioned OpenClaw agent ${request.agentId}.`,
    `Soul: ${request.soul}`,
    `Spec hash: ${request.specHash}`,
  ];
  if (params.identity?.purpose) {
    lines.push(`Purpose: ${params.identity.purpose}`);
  }
  if (params.identity?.tier) {
    lines.push(`Tier: ${params.identity.tier}`);
  }
  return lines.join("\n");
}

async function persistManagedAgent(params: {
  request: ValidatedSoulFactoryRequest;
  state: "running" | "suspended" | "revoked" | "failed";
  provision?: ProvisionParams;
  session?: { key?: string; runId?: string; spawnedAt?: number };
  specHash?: string;
}): Promise<ManagedAgentEntry> {
  const runtime = getNostrRuntime();
  const request = params.request;
  const provision = params.provision;
  const name = provision?.identity?.name ?? request.agentId;
  const avatar = provision?.assets?.avatar_ref;
  const controlRelays = provision?.relay_policy?.control;
  const workspace = provision?.workspace?.repo;
  const patch: Partial<ManagedAgentEntry> = {
    soulFactory: {
      managed: true,
      soulId: request.soul,
      soulEvent: request.envelope.soul.event,
      soulDraft: request.envelope.soul.draft,
      ownerPubkey: request.envelope.operator?.pubkey,
      controllerPubkey: request.event.pubkey,
      runtimePubkey: request.envelope.target.runtime_pubkey,
      capabilityRef: provision?.runtime?.capability_ref,
      controlRelays,
      specHash: params.specHash ?? request.specHash,
      lastOperatorRequestEvent: request.operatorRequestEvent,
      lastRuntimeRequestEvent: request.event.id,
      runtimeBinding: `openclaw://agents/${request.agentId}`,
      state: params.state,
      session: params.session,
      updatedAt: Math.floor(Date.now() / 1000),
    },
  };
  if (provision) {
    patch.name = name;
    if (workspace) {
      patch.workspace = workspace;
    }
    patch.identity = {
      name,
      ...(avatar ? { avatar } : {}),
    };
  }
  const result = await runtime.config.mutateConfigFile<ManagedAgentEntry>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => upsertManagedAgent(draft, request.agentId, patch),
  });
  return (
    result.result ?? findAgentEntry(result.nextConfig, request.agentId) ?? { id: request.agentId }
  );
}

async function deleteManagedSessionIfPresent(
  entry: ManagedAgentEntry | undefined,
): Promise<string | undefined> {
  const sessionKey = entry?.soulFactory?.session?.key;
  if (!sessionKey) {
    return undefined;
  }
  await getNostrRuntime().subagent.deleteSession({ sessionKey, deleteTranscript: false });
  return sessionKey;
}

async function executeProvision(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const provision = normalizeProvisionParams(request.envelope.params);
  const agentId = normalizeAgentId(request.agentId);
  if (agentId !== request.agentId) {
    return rejected(
      "invalid_schema",
      `agent-id ${request.agentId} is not a valid OpenClaw agent id`,
    );
  }
  await persistManagedAgent({ request, state: "running", provision });
  const spawn = await spawnSessionDirect(
    {
      runtime: "subagent",
      task: buildProvisionTask(request, provision),
      agentId,
      label: provision.identity?.name ?? agentId,
      mode: "run",
      cleanup: "keep",
      context: "isolated",
      expectsCompletionMessage: false,
    },
    {
      requesterAgentIdOverride: agentId,
      config: getNostrRuntime().config.current() as OpenClawConfig,
    },
  );
  if (spawn.status !== "accepted") {
    await persistManagedAgent({ request, state: "failed", provision });
    return failed(spawn.error ?? "session spawn failed", false);
  }
  const session = {
    key: spawn.childSessionKey,
    runId: spawn.runId,
    spawnedAt: Math.floor(Date.now() / 1000),
  };
  await persistManagedAgent({ request, state: "running", provision, session });
  return {
    status: "success",
    result: resultFor({
      request,
      state: "running",
      capabilityRef: provision.runtime?.capability_ref,
      session: { key: spawn.childSessionKey, runId: spawn.runId },
    }),
    error: null,
  };
}

async function executeUpdate(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const params = request.envelope.params;
  const previous = readString(params.previous_spec_hash);
  const nextHash = readString(params.new_spec_hash) ?? request.specHash;
  const current = findAgentEntry(
    getNostrRuntime().config.current() as OpenClawConfig,
    request.agentId,
  );
  if (!current?.soulFactory?.managed) {
    return rejected("runtime_unavailable", `managed agent ${request.agentId} is not provisioned`);
  }
  if (previous && current.soulFactory.specHash && previous !== current.soulFactory.specHash) {
    return rejected("spec_hash_mismatch", "previous_spec_hash does not match current managed spec");
  }
  await persistManagedAgent({
    request,
    state: current.soulFactory.state ?? "running",
    specHash: nextHash,
  });
  return {
    status: "success",
    result: resultFor({ request, state: current.soulFactory.state ?? "running" }),
    error: null,
  };
}

async function executeStateChange(
  request: ValidatedSoulFactoryRequest,
  state: "running" | "suspended" | "revoked",
): Promise<SoulFactoryExecutionOutcome> {
  const current = findAgentEntry(
    getNostrRuntime().config.current() as OpenClawConfig,
    request.agentId,
  );
  if (!current?.soulFactory?.managed) {
    return rejected("runtime_unavailable", `managed agent ${request.agentId} is not provisioned`);
  }
  const warnings: string[] = [];
  if (state === "suspended" || state === "revoked") {
    try {
      const deleted = await deleteManagedSessionIfPresent(current);
      if (!deleted) {
        warnings.push("no active managed session was recorded");
      }
    } catch (error) {
      warnings.push(`session cleanup failed: ${formatErrorMessage(error)}`);
    }
  }
  await persistManagedAgent({
    request,
    state,
    session: state === "running" ? current.soulFactory.session : undefined,
  });
  return {
    status: "success",
    result: resultFor({ request, state, warnings }),
    error: null,
  };
}

async function executeResumeOrRedeploy(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = findAgentEntry(
    getNostrRuntime().config.current() as OpenClawConfig,
    request.agentId,
  );
  if (!current?.soulFactory?.managed) {
    return rejected("runtime_unavailable", `managed agent ${request.agentId} is not provisioned`);
  }
  const spawn = await spawnSessionDirect(
    {
      runtime: "subagent",
      task: `SoulFactory ${request.method} for managed OpenClaw agent ${request.agentId}.\nSpec hash: ${request.specHash}`,
      agentId: request.agentId,
      label: current.name ?? request.agentId,
      mode: "run",
      cleanup: "keep",
      context: "isolated",
      expectsCompletionMessage: false,
    },
    {
      requesterAgentIdOverride: request.agentId,
      config: getNostrRuntime().config.current() as OpenClawConfig,
    },
  );
  if (spawn.status !== "accepted") {
    return failed(spawn.error ?? "session spawn failed", false);
  }
  await persistManagedAgent({
    request,
    state: "running",
    session: {
      key: spawn.childSessionKey,
      runId: spawn.runId,
      spawnedAt: Math.floor(Date.now() / 1000),
    },
  });
  return {
    status: "success",
    result: resultFor({
      request,
      state: "running",
      session: { key: spawn.childSessionKey, runId: spawn.runId },
    }),
    error: null,
  };
}

export async function executeSoulFactoryRuntimeRequest(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const handlers: Record<SoulFactoryMethod, () => Promise<SoulFactoryExecutionOutcome>> = {
    "soulfactory.provision": () => executeProvision(request),
    "soulfactory.update": () => executeUpdate(request),
    "soulfactory.suspend": () => executeStateChange(request, "suspended"),
    "soulfactory.resume": () => executeResumeOrRedeploy(request),
    "soulfactory.redeploy": () => executeResumeOrRedeploy(request),
    "soulfactory.revoke": () => executeStateChange(request, "revoked"),
  };
  return await handlers[request.method]();
}
