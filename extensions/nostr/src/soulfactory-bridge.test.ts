import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { validatePrivateKey } from "./nostr-key-utils.js";
import {
  type SoulFactoryBridgeStateStore,
  SOULFACTORY_CAPABILITY_KIND,
  SOULFACTORY_CAPABILITY_SCHEMA,
  SOULFACTORY_CAPABILITY_SCHEMA_VERSION,
  SOULFACTORY_CUSTOMIZATION_FEATURES,
  SOULFACTORY_CONTROL_REQUEST_KIND,
  SOULFACTORY_CONTROL_RESULT_KIND,
  SOULFACTORY_CONTROL_SCHEMA,
  SOULFACTORY_METHODS,
  SOULFACTORY_METHOD_CAPABILITIES,
  SOULFACTORY_PARITY,
  createSoulFactoryCapabilityEvent,
  createSoulFactoryResultEvent,
  createSoulFactoryRequestValidationState,
  startSoulFactoryBridge,
  validateSoulFactoryControlRequest,
  type ValidatedSoulFactoryRequest,
} from "./soulfactory-bridge.js";
import { TEST_HEX_PRIVATE_KEY, TEST_RELAY_URL } from "./test-fixtures.js";

const RUNTIME_PRIVATE_KEY = TEST_HEX_PRIVATE_KEY;
const CONTROLLER_PRIVATE_KEY = "0202020202020202020202020202020202020202020202020202020202020202";
const UNTRUSTED_PRIVATE_KEY = "0303030303030303030303030303030303030303030303030303030303030303";
const RUNTIME_PUBKEY = getPublicKey(validatePrivateKey(RUNTIME_PRIVATE_KEY));
const CONTROLLER_PUBKEY = getPublicKey(validatePrivateKey(CONTROLLER_PRIVATE_KEY));
const UNTRUSTED_PUBKEY = getPublicKey(validatePrivateKey(UNTRUSTED_PRIVATE_KEY));
const NOW = 1_715_700_000;

function provisionParams() {
  return {
    identity: { name: "Alice", purpose: "test", tier: "dev" },
    runtime: { target: "openclaw", capability_ref: "capability-event" },
    permissions: { allowed_kinds: [], tool_grants: [], approval_policy: "manual" },
    relay_policy: { read: [TEST_RELAY_URL], write: [TEST_RELAY_URL], control: [TEST_RELAY_URL] },
    workspace: {},
    assets: {},
  };
}

function createRequest(
  overrides: {
    privateKey?: string;
    runtimePubkey?: string;
    controllerPubkey?: string;
    createdAt?: number;
    idempotencyKey?: string;
    specHash?: string;
    method?: string;
    params?: Record<string, unknown>;
    content?: Record<string, unknown>;
    tags?: string[][];
  } = {},
): Event {
  const privateKey = overrides.privateKey ?? CONTROLLER_PRIVATE_KEY;
  const controllerPubkey =
    overrides.controllerPubkey ?? getPublicKey(validatePrivateKey(privateKey));
  const runtimePubkey = overrides.runtimePubkey ?? RUNTIME_PUBKEY;
  const method = overrides.method ?? "soulfactory.provision";
  const idempotencyKey = overrides.idempotencyKey ?? "idem-1";
  const specHash = overrides.specHash ?? "sha256:spec";
  const operatorRequest = "operator-request-event";
  const agentId = "agent-alice";
  const content = {
    schema: SOULFACTORY_CONTROL_SCHEMA,
    method,
    idempotency_key: idempotencyKey,
    requested_at: NOW,
    operator: { pubkey: "operator-pubkey", request_event: operatorRequest },
    controller: { pubkey: controllerPubkey },
    target: { runtime: "openclaw", runtime_pubkey: runtimePubkey, agent_id: agentId },
    soul: { id: "soul-alice", draft: "draft-event", spec_hash: specHash },
    params: overrides.params ?? provisionParams(),
    ...overrides.content,
  };

  return finalizeEvent(
    {
      kind: SOULFACTORY_CONTROL_REQUEST_KIND,
      content: JSON.stringify(content),
      tags: overrides.tags ?? [
        ["p", runtimePubkey],
        ["method", method],
        ["e", operatorRequest],
        ["soul", "soul-alice"],
        ["agent-id", agentId],
        ["controller", controllerPubkey],
        ["idempotency-key", idempotencyKey],
        ["spec-hash", specHash],
        ["schema", SOULFACTORY_CONTROL_SCHEMA],
      ],
      created_at: overrides.createdAt ?? NOW,
    },
    validatePrivateKey(privateKey),
  );
}

function createMemoryStateStore(seed?: Awaited<ReturnType<SoulFactoryBridgeStateStore["read"]>>) {
  const store: SoulFactoryBridgeStateStore = {
    read: vi.fn(async () => seed ?? null),
    write: vi.fn(async () => {}),
  };
  return store;
}

type CapturedBridgeHandlers = { onevent: (event: Event) => void | Promise<void> };

async function dispatchCapturedEvent(
  handlers: CapturedBridgeHandlers | null,
  event: Event,
): Promise<void> {
  if (!handlers) {
    throw new Error("expected SoulFactory bridge subscription handlers");
  }
  await handlers.onevent(event);
}

function publishCallsOf(pool: { publish: ReturnType<typeof vi.fn> }): Array<[string[], Event]> {
  return pool.publish.mock.calls as Array<[string[], Event]>;
}

function validate(event: Event) {
  return validateSoulFactoryControlRequest({
    event,
    runtimePubkey: RUNTIME_PUBKEY,
    trustedControllerPubkeys: [CONTROLLER_PUBKEY],
    now: NOW,
  });
}

describe("SoulFactory OpenClaw bridge", () => {
  it("creates signed 30317 openclaw capability announcements", () => {
    const event = createSoulFactoryCapabilityEvent({
      privateKey: RUNTIME_PRIVATE_KEY,
      controllerPubkeys: [CONTROLLER_PUBKEY],
      relayHints: { control: [TEST_RELAY_URL] },
      createdAt: NOW,
    });

    expect(event.kind).toBe(SOULFACTORY_CAPABILITY_KIND);
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toContainEqual(["runtime", "openclaw"]);
    expect(event.tags).toContainEqual(["schema", SOULFACTORY_CAPABILITY_SCHEMA]);
    expect(event.tags).toContainEqual(["control-schema", SOULFACTORY_CONTROL_SCHEMA]);
    expect(event.tags).toContainEqual(["controller", CONTROLLER_PUBKEY]);
    const content = JSON.parse(event.content) as Record<string, unknown>;
    expect(content).toMatchObject({
      schema: SOULFACTORY_CAPABILITY_SCHEMA,
      schema_version: SOULFACTORY_CAPABILITY_SCHEMA_VERSION,
      runtime: "openclaw",
      control_schema: SOULFACTORY_CONTROL_SCHEMA,
      controller_pubkeys: [CONTROLLER_PUBKEY],
      method_capabilities: SOULFACTORY_METHOD_CAPABILITIES,
      features: SOULFACTORY_CUSTOMIZATION_FEATURES,
      feature_parity: SOULFACTORY_PARITY,
    });
    expect(content.methods).toEqual(SOULFACTORY_METHODS);
    expect(content.features).toMatchObject({
      avatar: {
        availability: "partial",
        methods: ["soulfactory.avatar.generate", "soulfactory.avatar.set"],
      },
      memory: {
        availability: "partial",
        methods: ["soulfactory.memory.configure", "soulfactory.memory.reindex"],
      },
    });
    expect(content.method_capabilities).toMatchObject({
      "soulfactory.persona.update": { availability: "complete", category: "persona" },
      "soulfactory.memory.reindex": { availability: "stubbed", category: "memory" },
    });
    expect(content.feature_parity).toMatchObject({
      metiq: {
        customization_methods: expect.arrayContaining([
          "soulfactory.avatar.generate",
          "soulfactory.voice.configure",
          "soulfactory.memory.configure",
          "soulfactory.persona.update",
          "soulfactory.config.reload",
        ]),
      },
    });
  });

  it("publishes capability and subscribes to addressed 38384 requests", async () => {
    let handlers: { onevent: (event: Event) => void | Promise<void> } | null = null;
    const pool = {
      publish: vi.fn(() => [Promise.resolve()]),
      subscribeMany: vi.fn((_relays, _filters, nextHandlers) => {
        handlers = nextHandlers;
        return { close: vi.fn() };
      }),
    };
    const onValidatedRequest = vi.fn();
    const stateStore = createMemoryStateStore();
    const handle = await startSoulFactoryBridge({
      accountId: "default",
      privateKey: RUNTIME_PRIVATE_KEY,
      relays: [TEST_RELAY_URL],
      config: { enabled: true, controllerPubkeys: [CONTROLLER_PUBKEY.toUpperCase()] },
      pool,
      stateStore,
      onValidatedRequest,
    });

    expect(handle.publicKey).toBe(RUNTIME_PUBKEY);
    expect(pool.publish).toHaveBeenCalledWith(
      [TEST_RELAY_URL],
      expect.objectContaining({ kind: SOULFACTORY_CAPABILITY_KIND }),
    );
    expect(pool.subscribeMany).toHaveBeenCalledWith(
      [TEST_RELAY_URL],
      [
        expect.objectContaining({
          kinds: [SOULFACTORY_CONTROL_REQUEST_KIND],
          "#p": [RUNTIME_PUBKEY],
        }),
      ],
      expect.any(Object),
    );

    await dispatchCapturedEvent(
      handlers,
      createRequest({ createdAt: Math.floor(Date.now() / 1000) }),
    );
    expect(stateStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        state: expect.objectContaining({ idempotencyKeys: expect.any(Object) }),
      }),
    );
    expect(onValidatedRequest).toHaveBeenCalledTimes(1);
  });

  it("creates signed 38386 runtime control results", () => {
    const state = createSoulFactoryRequestValidationState();
    const validation = validateSoulFactoryControlRequest({
      event: createRequest(),
      runtimePubkey: RUNTIME_PUBKEY,
      trustedControllerPubkeys: [CONTROLLER_PUBKEY],
      now: NOW,
      state,
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      throw new Error("expected validation success");
    }

    const event = createSoulFactoryResultEvent({
      privateKey: RUNTIME_PRIVATE_KEY,
      request: validation.request,
      outcome: {
        status: "success",
        result: {
          agent_id: validation.request.agentId,
          runtime: "openclaw",
          runtime_binding: `openclaw://agents/${validation.request.agentId}`,
          state: "running",
          spec_hash: validation.request.specHash,
          observed_at: NOW,
          warnings: [],
        },
        error: null,
      },
      createdAt: NOW,
    });

    expect(event.kind).toBe(SOULFACTORY_CONTROL_RESULT_KIND);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(RUNTIME_PUBKEY);
    expect(event.tags).toContainEqual(["e", validation.request.event.id]);
    expect(event.tags).toContainEqual(["method", "soulfactory.provision"]);
    expect(event.tags).toContainEqual(["status", "success"]);
    const content = JSON.parse(event.content) as Record<string, unknown>;
    expect(content).toMatchObject({
      schema: SOULFACTORY_CONTROL_SCHEMA,
      method: "soulfactory.provision",
      idempotency_key: validation.request.idempotencyKey,
      request_event: validation.request.event.id,
      operator_request_event: validation.request.operatorRequestEvent,
      status: "success",
      error: null,
    });
  });

  it("executes validated requests and publishes correlated 38386 results", async () => {
    let handlers: { onevent: (event: Event) => void | Promise<void> } | null = null;
    const pool = {
      publish: vi.fn(() => [Promise.resolve()]),
      subscribeMany: vi.fn((_relays, _filters, nextHandlers) => {
        handlers = nextHandlers;
        return { close: vi.fn() };
      }),
    };
    const requestEvent = createRequest({ createdAt: Math.floor(Date.now() / 1000) });
    const executeRequest = vi.fn(async (request: ValidatedSoulFactoryRequest) => ({
      status: "success" as const,
      result: {
        agent_id: request.agentId,
        runtime: "openclaw",
        runtime_binding: `openclaw://agents/${request.agentId}`,
        state: "running",
        spec_hash: request.specHash,
        observed_at: NOW,
        warnings: [],
      },
      error: null,
    }));
    const onResultPublished = vi.fn();

    await startSoulFactoryBridge({
      accountId: "default",
      privateKey: RUNTIME_PRIVATE_KEY,
      relays: [TEST_RELAY_URL],
      config: { enabled: true, controllerPubkeys: [CONTROLLER_PUBKEY] },
      pool,
      stateStore: createMemoryStateStore(),
      executeRequest,
      onResultPublished,
    });

    await dispatchCapturedEvent(handlers, requestEvent);

    expect(executeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ event: requestEvent, method: "soulfactory.provision" }),
    );
    expect(pool.publish).toHaveBeenCalledWith(
      [TEST_RELAY_URL],
      expect.objectContaining({ kind: SOULFACTORY_CONTROL_RESULT_KIND }),
    );
    const resultEvent = publishCallsOf(pool).find(
      (call) => call[1].kind === SOULFACTORY_CONTROL_RESULT_KIND,
    )?.[1];
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.tags).toContainEqual(["e", requestEvent.id]);
    expect(onResultPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: SOULFACTORY_CONTROL_RESULT_KIND }),
      }),
    );
  });

  it("does not persist idempotency state when result publication fails", async () => {
    let handlers: { onevent: (event: Event) => void | Promise<void> } | null = null;
    const pool = {
      publish: vi.fn((_relays: string[], event: Event) => [
        event.kind === SOULFACTORY_CONTROL_RESULT_KIND
          ? Promise.reject(new Error("relay down"))
          : Promise.resolve(),
      ]),
      subscribeMany: vi.fn((_relays, _filters, nextHandlers) => {
        handlers = nextHandlers;
        return { close: vi.fn() };
      }),
    };
    const stateStore = createMemoryStateStore();
    const executeRequest = vi.fn(async () => ({
      status: "success" as const,
      result: {},
      error: null,
    }));
    const onError = vi.fn();

    await startSoulFactoryBridge({
      accountId: "default",
      privateKey: RUNTIME_PRIVATE_KEY,
      relays: [TEST_RELAY_URL],
      config: { enabled: true, controllerPubkeys: [CONTROLLER_PUBKEY] },
      pool,
      stateStore,
      executeRequest,
      onError,
    });

    await dispatchCapturedEvent(
      handlers,
      createRequest({ createdAt: Math.floor(Date.now() / 1000) }),
    );

    expect(executeRequest).toHaveBeenCalledTimes(1);
    expect(stateStore.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      "soulfactory result publish or persist",
    );
  });

  it("seeds persisted request IDs and idempotency keys before validation", () => {
    const event = createRequest();
    const state = createSoulFactoryRequestValidationState({
      version: 1,
      recentEventIds: [event.id],
      idempotencyKeys: {},
    });

    expect(
      validateSoulFactoryControlRequest({
        event,
        runtimePubkey: RUNTIME_PUBKEY,
        trustedControllerPubkeys: [CONTROLLER_PUBKEY],
        now: NOW,
        state,
      }),
    ).toMatchObject({ ok: false, code: "duplicate_conflict" });
  });

  it("accepts trusted addressed requests and rejects duplicate idempotency before reuse", () => {
    const state = createSoulFactoryRequestValidationState();
    const event = createRequest();

    const first = validateSoulFactoryControlRequest({
      event,
      runtimePubkey: RUNTIME_PUBKEY,
      trustedControllerPubkeys: [CONTROLLER_PUBKEY],
      now: NOW,
      state,
    });
    expect(first.ok).toBe(true);

    const second = validateSoulFactoryControlRequest({
      event,
      runtimePubkey: RUNTIME_PUBKEY,
      trustedControllerPubkeys: [CONTROLLER_PUBKEY],
      now: NOW,
      state,
    });
    expect(second).toMatchObject({ ok: false, code: "duplicate_conflict" });
  });

  it("rejects unsigned or invalidly signed requests", () => {
    const signed = createRequest();
    const unsigned = { ...signed, sig: "" } as Event;

    expect(validate(unsigned)).toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("rejects stale requests", () => {
    const stale = createRequest({ createdAt: NOW - 601 });

    expect(validate(stale)).toMatchObject({ ok: false, code: "stale_request" });
  });

  it("rejects requests from unauthorized controllers", () => {
    const unauthorized = createRequest({ privateKey: UNTRUSTED_PRIVATE_KEY });

    expect(validate(unauthorized)).toMatchObject({
      ok: false,
      code: "unauthorized_controller",
      details: { controller: UNTRUSTED_PUBKEY },
    });
  });

  it("rejects self-authored requests before runtime side effects", async () => {
    const selfAuthored = createRequest({
      privateKey: RUNTIME_PRIVATE_KEY,
      controllerPubkey: RUNTIME_PUBKEY,
    });

    expect(
      validateSoulFactoryControlRequest({
        event: selfAuthored,
        runtimePubkey: RUNTIME_PUBKEY,
        trustedControllerPubkeys: [RUNTIME_PUBKEY],
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: "unauthorized_controller" });
  });

  it("rejects misaddressed requests", () => {
    const misaddressed = createRequest({ runtimePubkey: "f".repeat(64) });

    expect(validate(misaddressed)).toMatchObject({ ok: false, code: "misaddressed_request" });
  });

  it("publishes rejected 38386 results for signed, addressed validation failures", async () => {
    let handlers: { onevent: (event: Event) => void | Promise<void> } | null = null;
    const pool = {
      publish: vi.fn(() => [Promise.resolve()]),
      subscribeMany: vi.fn((_relays, _filters, nextHandlers) => {
        handlers = nextHandlers;
        return { close: vi.fn() };
      }),
    };
    await startSoulFactoryBridge({
      accountId: "default",
      privateKey: RUNTIME_PRIVATE_KEY,
      relays: [TEST_RELAY_URL],
      config: { enabled: true, controllerPubkeys: [CONTROLLER_PUBKEY] },
      pool,
      stateStore: createMemoryStateStore(),
    });

    await dispatchCapturedEvent(
      handlers,
      createRequest({
        privateKey: UNTRUSTED_PRIVATE_KEY,
        createdAt: Math.floor(Date.now() / 1000),
      }),
    );

    const resultEvent = publishCallsOf(pool).find(
      (call) => call[1].kind === SOULFACTORY_CONTROL_RESULT_KIND,
    )?.[1];
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.tags).toContainEqual(["status", "rejected"]);
    expect(resultEvent?.tags).toContainEqual(["p", UNTRUSTED_PUBKEY]);
    const content = JSON.parse(resultEvent?.content ?? "{}") as Record<string, unknown>;
    expect(content).toMatchObject({ status: "rejected" });
    expect(content.error).toMatchObject({ code: "unauthorized_controller" });
  });

  it("does not dispatch validation callback for rejected requests", async () => {
    let handlers: { onevent: (event: Event) => void | Promise<void> } | null = null;
    const pool = {
      publish: vi.fn(() => [Promise.resolve()]),
      subscribeMany: vi.fn((_relays, _filters, nextHandlers) => {
        handlers = nextHandlers;
        return { close: vi.fn() };
      }),
    };
    const onValidatedRequest = vi.fn();
    const onRejectedRequest = vi.fn();
    await startSoulFactoryBridge({
      accountId: "default",
      privateKey: RUNTIME_PRIVATE_KEY,
      relays: [TEST_RELAY_URL],
      config: { enabled: true, controllerPubkeys: [CONTROLLER_PUBKEY] },
      pool,
      stateStore: createMemoryStateStore(),
      onValidatedRequest,
      onRejectedRequest,
    });

    await dispatchCapturedEvent(
      handlers,
      createRequest({
        privateKey: UNTRUSTED_PRIVATE_KEY,
        createdAt: Math.floor(Date.now() / 1000),
      }),
    );

    expect(onValidatedRequest).not.toHaveBeenCalled();
    expect(onRejectedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: UNTRUSTED_PUBKEY }),
      expect.objectContaining({ code: "unauthorized_controller" }),
    );
  });
});
