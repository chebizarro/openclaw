import { finalizeEvent, getPublicKey, SimplePool, verifyEvent, type Event } from "nostr-tools";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizePubkey, validatePrivateKey } from "./nostr-key-utils.js";
import {
  readNostrSoulFactoryBridgeState,
  writeNostrSoulFactoryBridgeState,
  type NostrSoulFactoryBridgeState,
} from "./nostr-state-store.js";

export const SOULFACTORY_CAPABILITY_KIND = 30317;
export const SOULFACTORY_CONTROL_REQUEST_KIND = 38384;
export const SOULFACTORY_RUNTIME = "openclaw";
export const SOULFACTORY_CAPABILITY_SCHEMA = "soulfactory-runtime-capability/v1";
export const SOULFACTORY_CONTROL_SCHEMA = "soulfactory-runtime-control/v1";

export const SOULFACTORY_METHODS = [
  "soulfactory.provision",
  "soulfactory.update",
  "soulfactory.suspend",
  "soulfactory.resume",
  "soulfactory.redeploy",
  "soulfactory.revoke",
] as const;

export type SoulFactoryMethod = (typeof SOULFACTORY_METHODS)[number];

export type SoulFactoryValidationCode =
  | "invalid_schema"
  | "unsupported_method"
  | "unsupported_schema_version"
  | "missing_required_tag"
  | "missing_required_param"
  | "invalid_signature"
  | "unauthorized_controller"
  | "misaddressed_request"
  | "stale_request"
  | "duplicate_conflict"
  | "spec_hash_mismatch";

export interface SoulFactoryRelayHints {
  read?: string[];
  write?: string[];
  control?: string[];
}

export interface SoulFactoryBridgeConfig {
  enabled?: boolean;
  controllerPubkeys?: string[];
  staleRequestSeconds?: number;
  relayHints?: SoulFactoryRelayHints;
}

export interface SoulFactoryCapabilityPublishResult {
  eventId: string;
  createdAt: number;
  successes: string[];
  failures: Array<{ relay: string; error: string }>;
}

export interface SoulFactoryRequestEnvelope {
  schema: string;
  method: SoulFactoryMethod;
  idempotency_key: string;
  requested_at?: number;
  operator?: { pubkey?: string; request_event?: string };
  controller: { pubkey: string };
  target: { runtime: string; runtime_pubkey: string; agent_id: string };
  soul: { id?: string; event?: string; draft?: string; spec_hash: string };
  params: Record<string, unknown>;
}

export interface ValidatedSoulFactoryRequest {
  event: Event;
  envelope: SoulFactoryRequestEnvelope;
  method: SoulFactoryMethod;
  idempotencyKey: string;
  operatorRequestEvent: string;
  soul: string;
  agentId: string;
  specHash: string;
}

export type SoulFactoryValidationResult =
  | { ok: true; request: ValidatedSoulFactoryRequest }
  | {
      ok: false;
      code: SoulFactoryValidationCode;
      message: string;
      details?: Record<string, unknown>;
    };

export interface SoulFactoryRequestValidationState {
  seenEventIds: Set<string>;
  idempotencyKeys: Map<string, string>;
}

export interface SoulFactoryBridgeStateStore {
  read: (params: { accountId?: string }) => Promise<NostrSoulFactoryBridgeState | null>;
  write: (params: {
    accountId?: string;
    state: Omit<NostrSoulFactoryBridgeState, "version">;
  }) => Promise<void>;
}

interface SoulFactoryRelayPool {
  publish(relays: string[], event: Event): Iterable<Promise<unknown>>;
  subscribeMany(
    relays: string[],
    filters: unknown,
    handlers: {
      onevent: (event: Event) => void | Promise<void>;
      oneose?: () => void;
      onclose?: (reason: string[]) => void;
    },
  ): { close: () => void };
}

export interface StartSoulFactoryBridgeOptions {
  accountId: string;
  privateKey: string;
  relays: string[];
  config?: SoulFactoryBridgeConfig;
  pool?: SoulFactoryRelayPool;
  stateStore?: SoulFactoryBridgeStateStore;
  onValidatedRequest?: (request: ValidatedSoulFactoryRequest) => void | Promise<void>;
  onRejectedRequest?: (
    event: Event,
    result: Exclude<SoulFactoryValidationResult, { ok: true }>,
  ) => void;
  onError?: (error: Error, context: string) => void;
  onEose?: (relays: string) => void;
  onClosed?: (reason: string) => void;
}

export interface SoulFactoryBridgeHandle {
  publicKey: string;
  capability: SoulFactoryCapabilityPublishResult;
  close: () => void;
}

const DEFAULT_STALE_REQUEST_SECONDS = 10 * 60;
const DEFAULT_FUTURE_SKEW_SECONDS = 10 * 60;
const CAPABILITY_D_TAG = "soulfactory-openclaw";
const MAX_PERSISTED_REQUESTS = 10_000;

const defaultStateStore: SoulFactoryBridgeStateStore = {
  read: readNostrSoulFactoryBridgeState,
  write: writeNostrSoulFactoryBridgeState,
};

function compactStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeControllerPubkeys(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => normalizePubkey(value)))];
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name && typeof tag[1] === "string")?.[1];
}

function reject(
  code: SoulFactoryValidationCode,
  message: string,
  details?: Record<string, unknown>,
): SoulFactoryValidationResult {
  return { ok: false, code, message, details };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMethod(value: string): value is SoulFactoryMethod {
  return SOULFACTORY_METHODS.includes(value as SoulFactoryMethod);
}

function parseEnvelope(content: string): SoulFactoryRequestEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    !isObject(parsed) ||
    !isObject(parsed.controller) ||
    !isObject(parsed.target) ||
    !isObject(parsed.soul)
  ) {
    return null;
  }
  const method = parsed.method;
  if (typeof method !== "string" || !isMethod(method)) {
    return null;
  }
  const params = isObject(parsed.params) ? parsed.params : {};
  return {
    schema: typeof parsed.schema === "string" ? parsed.schema : "",
    method,
    idempotency_key: typeof parsed.idempotency_key === "string" ? parsed.idempotency_key : "",
    requested_at: typeof parsed.requested_at === "number" ? parsed.requested_at : undefined,
    operator: isObject(parsed.operator)
      ? {
          pubkey: typeof parsed.operator.pubkey === "string" ? parsed.operator.pubkey : undefined,
          request_event:
            typeof parsed.operator.request_event === "string"
              ? parsed.operator.request_event
              : undefined,
        }
      : undefined,
    controller: {
      pubkey: typeof parsed.controller.pubkey === "string" ? parsed.controller.pubkey : "",
    },
    target: {
      runtime: typeof parsed.target.runtime === "string" ? parsed.target.runtime : "",
      runtime_pubkey:
        typeof parsed.target.runtime_pubkey === "string" ? parsed.target.runtime_pubkey : "",
      agent_id: typeof parsed.target.agent_id === "string" ? parsed.target.agent_id : "",
    },
    soul: {
      id: typeof parsed.soul.id === "string" ? parsed.soul.id : undefined,
      event: typeof parsed.soul.event === "string" ? parsed.soul.event : undefined,
      draft: typeof parsed.soul.draft === "string" ? parsed.soul.draft : undefined,
      spec_hash: typeof parsed.soul.spec_hash === "string" ? parsed.soul.spec_hash : "",
    },
    params,
  };
}

function hasObjectParam(params: Record<string, unknown>, name: string): boolean {
  return isObject(params[name]);
}

function validateMethodParams(
  envelope: SoulFactoryRequestEnvelope,
): SoulFactoryValidationResult | null {
  const params = envelope.params;
  switch (envelope.method) {
    case "soulfactory.provision":
      for (const name of [
        "identity",
        "runtime",
        "permissions",
        "relay_policy",
        "workspace",
        "assets",
      ]) {
        if (!hasObjectParam(params, name)) {
          return reject(
            "missing_required_param",
            `missing required ${envelope.method} param: ${name}`,
            {
              param: name,
            },
          );
        }
      }
      if ((params.runtime as Record<string, unknown>).target !== SOULFACTORY_RUNTIME) {
        return reject("invalid_schema", "provision runtime target must be openclaw");
      }
      return null;
    case "soulfactory.update":
      if (!isObject(params.patch) && !isObject(params.resolved_spec)) {
        return reject("missing_required_param", "update requires patch or resolved_spec");
      }
      for (const name of ["previous_spec_hash", "new_spec_hash", "update_mode"]) {
        if (typeof params[name] !== "string") {
          return reject(
            "missing_required_param",
            `missing required ${envelope.method} param: ${name}`,
            {
              param: name,
            },
          );
        }
      }
      if (params.update_mode !== "merge" && params.update_mode !== "replace") {
        return reject("invalid_schema", "update_mode must be merge or replace");
      }
      return null;
    case "soulfactory.suspend":
    case "soulfactory.resume":
      if (typeof params.reason !== "string" || !params.reason.trim()) {
        return reject("missing_required_param", `${envelope.method} requires reason`);
      }
      return null;
    case "soulfactory.redeploy":
      if (typeof params.reason !== "string" || !params.reason.trim()) {
        return reject("missing_required_param", "redeploy requires reason");
      }
      if (!["restart", "rebuild", "migrate"].includes(String(params.strategy))) {
        return reject(
          "missing_required_param",
          "redeploy requires strategy restart, rebuild, or migrate",
        );
      }
      return null;
    case "soulfactory.revoke":
      if (typeof params.reason !== "string" || !params.reason.trim()) {
        return reject("missing_required_param", "revoke requires reason");
      }
      if (typeof params.revoke_runtime_credentials !== "boolean") {
        return reject(
          "missing_required_param",
          "revoke requires revoke_runtime_credentials boolean",
        );
      }
      return null;
  }
}

function requestFingerprint(params: {
  event: Event;
  envelope: SoulFactoryRequestEnvelope;
  operatorRequestEvent: string;
  specHash: string;
}): string {
  return JSON.stringify({
    pubkey: params.event.pubkey,
    method: params.envelope.method,
    operatorRequestEvent: params.operatorRequestEvent,
    runtimePubkey: params.envelope.target.runtime_pubkey,
    agentId: params.envelope.target.agent_id,
    specHash: params.specHash,
  });
}

export function createSoulFactoryRequestValidationState(
  seed?: NostrSoulFactoryBridgeState | null,
): SoulFactoryRequestValidationState {
  return {
    seenEventIds: new Set(seed?.recentEventIds ?? []),
    idempotencyKeys: new Map(Object.entries(seed?.idempotencyKeys ?? {})),
  };
}

function serializeSoulFactoryRequestValidationState(
  state: SoulFactoryRequestValidationState,
): Omit<NostrSoulFactoryBridgeState, "version"> {
  return {
    recentEventIds: [...state.seenEventIds].slice(-MAX_PERSISTED_REQUESTS),
    idempotencyKeys: Object.fromEntries([...state.idempotencyKeys].slice(-MAX_PERSISTED_REQUESTS)),
  };
}

export function validateSoulFactoryControlRequest(params: {
  event: Event;
  runtimePubkey: string;
  trustedControllerPubkeys: readonly string[];
  now?: number;
  staleRequestSeconds?: number;
  futureSkewSeconds?: number;
  state?: SoulFactoryRequestValidationState;
}): SoulFactoryValidationResult {
  const { event, runtimePubkey } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const staleRequestSeconds = params.staleRequestSeconds ?? DEFAULT_STALE_REQUEST_SECONDS;
  const futureSkewSeconds = params.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;
  const trusted = new Set(normalizeControllerPubkeys(params.trustedControllerPubkeys));

  if (params.state?.seenEventIds.has(event.id)) {
    return reject("duplicate_conflict", "duplicate request event", { event_id: event.id });
  }
  if (event.kind !== SOULFACTORY_CONTROL_REQUEST_KIND) {
    return reject("invalid_schema", "runtime control request kind must be 38384");
  }
  if (!event.id || !event.sig) {
    return reject("invalid_signature", "request is unsigned");
  }
  if (event.pubkey === runtimePubkey) {
    return reject("unauthorized_controller", "runtime must reject self-authored control requests");
  }
  if (event.created_at < now - staleRequestSeconds || event.created_at > now + futureSkewSeconds) {
    return reject("stale_request", "request timestamp is outside runtime policy", {
      created_at: event.created_at,
      now,
    });
  }
  if (!verifyEvent(event)) {
    return reject("invalid_signature", "request signature is invalid");
  }

  for (const name of [
    "p",
    "method",
    "e",
    "soul",
    "agent-id",
    "controller",
    "idempotency-key",
    "spec-hash",
    "schema",
  ]) {
    if (!tagValue(event, name)) {
      return reject("missing_required_tag", `missing required tag: ${name}`, { tag: name });
    }
  }

  const pTag = tagValue(event, "p") ?? "";
  if (pTag !== runtimePubkey) {
    return reject("misaddressed_request", "request is not addressed to this runtime", {
      target: pTag,
      runtimePubkey,
    });
  }

  const controllerTag = tagValue(event, "controller") ?? "";
  if (controllerTag !== event.pubkey) {
    return reject("unauthorized_controller", "controller tag must match signing pubkey", {
      controller: controllerTag,
      pubkey: event.pubkey,
    });
  }
  if (!trusted.has(event.pubkey)) {
    return reject("unauthorized_controller", "controller pubkey is not trusted by this runtime", {
      controller: event.pubkey,
    });
  }

  const schemaTag = tagValue(event, "schema") ?? "";
  if (schemaTag !== SOULFACTORY_CONTROL_SCHEMA) {
    return reject("unsupported_schema_version", "unsupported runtime control schema", {
      schema: schemaTag,
    });
  }

  const methodTag = tagValue(event, "method") ?? "";
  if (!isMethod(methodTag)) {
    return reject("unsupported_method", "unsupported SoulFactory method", { method: methodTag });
  }

  const envelope = parseEnvelope(event.content);
  if (!envelope) {
    return reject("invalid_schema", "request content must be a valid SoulFactory envelope");
  }
  if (envelope.schema !== SOULFACTORY_CONTROL_SCHEMA || envelope.schema !== schemaTag) {
    return reject("unsupported_schema_version", "content schema must match schema tag");
  }
  if (envelope.method !== methodTag) {
    return reject("invalid_schema", "content method must match method tag");
  }
  if (envelope.controller.pubkey !== event.pubkey) {
    return reject("unauthorized_controller", "content controller must match signing pubkey");
  }
  if (envelope.target.runtime !== SOULFACTORY_RUNTIME) {
    return reject("misaddressed_request", "target runtime must be openclaw");
  }
  if (envelope.target.runtime_pubkey !== runtimePubkey) {
    return reject("misaddressed_request", "content target pubkey must match this runtime");
  }

  const idempotencyKey = tagValue(event, "idempotency-key") ?? "";
  if (!idempotencyKey || envelope.idempotency_key !== idempotencyKey) {
    return reject("invalid_schema", "idempotency-key tag and content must match");
  }

  const operatorRequestEvent = tagValue(event, "e") ?? "";
  if (
    envelope.operator?.request_event &&
    envelope.operator.request_event !== operatorRequestEvent
  ) {
    return reject("invalid_schema", "operator request event must match e tag");
  }

  const agentId = tagValue(event, "agent-id") ?? "";
  if (envelope.target.agent_id !== agentId) {
    return reject("invalid_schema", "agent-id tag and content must match");
  }

  const specHash = tagValue(event, "spec-hash") ?? "";
  if (envelope.soul.spec_hash !== specHash) {
    return reject("spec_hash_mismatch", "spec-hash tag and content must match");
  }

  const paramError = validateMethodParams(envelope);
  if (paramError) {
    return paramError;
  }

  const fingerprint = requestFingerprint({ event, envelope, operatorRequestEvent, specHash });
  const priorFingerprint = params.state?.idempotencyKeys.get(idempotencyKey);
  if (priorFingerprint) {
    return reject("duplicate_conflict", "idempotency key was already used", {
      idempotency_key: idempotencyKey,
    });
  }

  params.state?.seenEventIds.add(event.id);
  params.state?.idempotencyKeys.set(idempotencyKey, fingerprint);

  return {
    ok: true,
    request: {
      event,
      envelope,
      method: envelope.method,
      idempotencyKey,
      operatorRequestEvent,
      soul: tagValue(event, "soul") ?? "",
      agentId,
      specHash,
    },
  };
}

export function createSoulFactoryCapabilityEvent(params: {
  privateKey: string;
  controllerPubkeys?: readonly string[];
  relayHints?: SoulFactoryRelayHints;
  createdAt?: number;
}): Event {
  const sk = validatePrivateKey(params.privateKey);
  const content = {
    schema: SOULFACTORY_CAPABILITY_SCHEMA,
    runtime: SOULFACTORY_RUNTIME,
    methods: SOULFACTORY_METHODS,
    control_schema: SOULFACTORY_CONTROL_SCHEMA,
    controller_pubkeys: normalizeControllerPubkeys(params.controllerPubkeys),
    relay_hints: {
      read: compactStrings(params.relayHints?.read),
      write: compactStrings(params.relayHints?.write),
      control: compactStrings(params.relayHints?.control),
    },
  };

  return finalizeEvent(
    {
      kind: SOULFACTORY_CAPABILITY_KIND,
      content: JSON.stringify(content),
      tags: [
        ["d", CAPABILITY_D_TAG],
        ["runtime", SOULFACTORY_RUNTIME],
        ["schema", SOULFACTORY_CAPABILITY_SCHEMA],
        ["control-schema", SOULFACTORY_CONTROL_SCHEMA],
        ...SOULFACTORY_METHODS.map((method) => ["method", method]),
        ...content.controller_pubkeys.map((pubkey) => ["controller", pubkey]),
      ],
      created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    },
    sk,
  );
}

async function publishCapability(params: {
  pool: SoulFactoryRelayPool;
  relays: string[];
  event: Event;
}): Promise<SoulFactoryCapabilityPublishResult> {
  const successes: string[] = [];
  const failures: Array<{ relay: string; error: string }> = [];

  await Promise.all(
    params.relays.map(async (relay) => {
      try {
        const [publishPromise] = [...params.pool.publish([relay], params.event)];
        if (!publishPromise) {
          throw new Error(`Failed to create publish promise for relay ${relay}`);
        }
        await publishPromise;
        successes.push(relay);
      } catch (error) {
        failures.push({ relay, error: formatErrorMessage(error) });
      }
    }),
  );

  if (successes.length === 0) {
    throw new Error(
      `SoulFactory capability publish failed on all relays: ${JSON.stringify(failures)}`,
    );
  }

  return {
    eventId: params.event.id,
    createdAt: params.event.created_at,
    successes,
    failures,
  };
}

export async function startSoulFactoryBridge(
  options: StartSoulFactoryBridgeOptions,
): Promise<SoulFactoryBridgeHandle> {
  const sk = validatePrivateKey(options.privateKey);
  const runtimePubkey = getPublicKey(sk);
  const config = options.config ?? {};
  const trustedControllerPubkeys = normalizeControllerPubkeys(config.controllerPubkeys);
  const pool: SoulFactoryRelayPool =
    options.pool ?? (new SimplePool() as unknown as SoulFactoryRelayPool);
  const stateStore = options.stateStore ?? defaultStateStore;
  const persistedState = await stateStore.read({ accountId: options.accountId });
  const state = createSoulFactoryRequestValidationState(persistedState);
  const staleRequestSeconds = config.staleRequestSeconds ?? DEFAULT_STALE_REQUEST_SECONDS;
  const capabilityEvent = createSoulFactoryCapabilityEvent({
    privateKey: options.privateKey,
    controllerPubkeys: trustedControllerPubkeys,
    relayHints: config.relayHints ?? {
      read: options.relays,
      write: options.relays,
      control: options.relays,
    },
  });
  const capability = await publishCapability({
    pool,
    relays: options.relays,
    event: capabilityEvent,
  });
  const since = Math.max(0, Math.floor(Date.now() / 1000) - staleRequestSeconds);

  const sub = pool.subscribeMany(
    options.relays,
    [{ kinds: [SOULFACTORY_CONTROL_REQUEST_KIND], "#p": [runtimePubkey], since }],
    {
      onevent: async (event) => {
        const result = validateSoulFactoryControlRequest({
          event,
          runtimePubkey,
          trustedControllerPubkeys,
          staleRequestSeconds,
          state,
        });
        if (!result.ok) {
          options.onRejectedRequest?.(event, result);
          return;
        }
        try {
          await stateStore.write({
            accountId: options.accountId,
            state: serializeSoulFactoryRequestValidationState(state),
          });
        } catch (error) {
          options.onError?.(error as Error, "soulfactory persist state");
          return;
        }
        await options.onValidatedRequest?.(result.request);
      },
      oneose: () => options.onEose?.(options.relays.join(", ")),
      onclose: (reason) => {
        const text = reason.join(", ");
        options.onClosed?.(text);
        options.onError?.(new Error(`SoulFactory subscription closed: ${text}`), "soulfactory");
      },
    },
  );

  return {
    publicKey: runtimePubkey,
    capability,
    close: () => {
      sub.close();
    },
  };
}
