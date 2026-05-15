import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validatePrivateKey } from "./nostr-key-utils.js";
import {
  SOULFACTORY_CONTROL_REQUEST_KIND,
  SOULFACTORY_CONTROL_SCHEMA,
  type SoulFactoryMethod,
  validateSoulFactoryControlRequest,
} from "./soulfactory-bridge.js";

const hoisted = vi.hoisted(() => {
  const spawnSessionDirectMock = vi.fn();
  const mutateConfigFileMock = vi.fn();
  const deleteSessionMock = vi.fn();
  const state = { cfg: { agents: { list: [] as Array<Record<string, unknown>> } } };
  return { spawnSessionDirectMock, mutateConfigFileMock, deleteSessionMock, state };
});

vi.mock("openclaw/plugin-sdk/sessions-spawn-runtime", () => ({
  spawnSessionDirect: (...args: unknown[]) => hoisted.spawnSessionDirectMock(...args),
}));

vi.mock("./runtime.js", () => ({
  getNostrRuntime: () => ({
    config: {
      current: () => hoisted.state.cfg,
      mutateConfigFile: hoisted.mutateConfigFileMock,
    },
    subagent: {
      deleteSession: hoisted.deleteSessionMock,
    },
  }),
}));

const RUNTIME_PRIVATE_KEY = "0101010101010101010101010101010101010101010101010101010101010101";
const CONTROLLER_PRIVATE_KEY = "0202020202020202020202020202020202020202020202020202020202020202";
const RUNTIME_PUBKEY = getPublicKey(validatePrivateKey(RUNTIME_PRIVATE_KEY));
const CONTROLLER_PUBKEY = getPublicKey(validatePrivateKey(CONTROLLER_PRIVATE_KEY));
const NOW = 1_715_700_000;

function provisionParams() {
  return {
    identity: { name: "Alice", purpose: "help operators", tier: "dev" },
    runtime: { target: "openclaw", capability_ref: "capability-event" },
    permissions: { allowed_kinds: [], tool_grants: [], approval_policy: "manual" },
    relay_policy: {
      read: ["wss://relay.example"],
      write: ["wss://relay.example"],
      control: ["wss://relay.example"],
    },
    workspace: { repo: "/tmp/alice", branch: "main" },
    assets: { avatar_ref: "https://example.com/alice.png" },
  };
}

function methodParams(method: SoulFactoryMethod): Record<string, unknown> {
  if (method === "soulfactory.provision") {
    return provisionParams();
  }
  if (method === "soulfactory.update") {
    return {
      patch: { identity: { name: "Alice 2" } },
      previous_spec_hash: "sha256:spec",
      new_spec_hash: "sha256:spec2",
      update_mode: "merge",
    };
  }
  if (method === "soulfactory.redeploy") {
    return { reason: "refresh", strategy: "restart" };
  }
  if (method === "soulfactory.revoke") {
    return { reason: "operator request", revoke_runtime_credentials: true };
  }
  return { reason: "operator request" };
}

function createRequest(method: SoulFactoryMethod): Event {
  const idempotencyKey = `idem-${method}`;
  const specHash = method === "soulfactory.update" ? "sha256:spec2" : "sha256:spec";
  const operatorRequest = `operator-${method}`;
  const content = {
    schema: SOULFACTORY_CONTROL_SCHEMA,
    method,
    idempotency_key: idempotencyKey,
    requested_at: NOW,
    operator: { pubkey: "operator-pubkey", request_event: operatorRequest },
    controller: { pubkey: CONTROLLER_PUBKEY },
    target: { runtime: "openclaw", runtime_pubkey: RUNTIME_PUBKEY, agent_id: "agent-alice" },
    soul: { id: "soul-alice", draft: "draft-event", spec_hash: specHash },
    params: methodParams(method),
  };
  return finalizeEvent(
    {
      kind: SOULFACTORY_CONTROL_REQUEST_KIND,
      content: JSON.stringify(content),
      tags: [
        ["p", RUNTIME_PUBKEY],
        ["method", method],
        ["e", operatorRequest],
        ["soul", "soul-alice"],
        ["agent-id", "agent-alice"],
        ["controller", CONTROLLER_PUBKEY],
        ["idempotency-key", idempotencyKey],
        ["spec-hash", specHash],
        ["schema", SOULFACTORY_CONTROL_SCHEMA],
      ],
      created_at: NOW,
    },
    validatePrivateKey(CONTROLLER_PRIVATE_KEY),
  );
}

function validatedRequest(method: SoulFactoryMethod) {
  const result = validateSoulFactoryControlRequest({
    event: createRequest(method),
    runtimePubkey: RUNTIME_PUBKEY,
    trustedControllerPubkeys: [CONTROLLER_PUBKEY],
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(`request validation failed: ${result.code}`);
  }
  return result.request;
}

describe("SoulFactory OpenClaw execution", () => {
  beforeEach(() => {
    hoisted.state.cfg = { agents: { list: [] } };
    hoisted.spawnSessionDirectMock.mockReset().mockResolvedValue({
      runtime: "subagent",
      status: "accepted",
      childSessionKey: "agent:agent-alice:subagent:1",
      runId: "run-1",
    });
    hoisted.deleteSessionMock.mockReset().mockResolvedValue(undefined);
    hoisted.mutateConfigFileMock
      .mockReset()
      .mockImplementation(
        async (params: { mutate: (draft: typeof hoisted.state.cfg) => unknown }) => {
          const draft = structuredClone(hoisted.state.cfg);
          const result = await params.mutate(draft);
          hoisted.state.cfg = draft;
          return { nextConfig: draft, result };
        },
      );
  });

  it("provisions managed agent metadata and reuses session-spawn orchestration", async () => {
    const { executeSoulFactoryRuntimeRequest } = await import("./soulfactory-execution.js");

    const outcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.provision"),
    );

    expect(outcome.status).toBe("success");
    expect(hoisted.spawnSessionDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "subagent", agentId: "agent-alice", cleanup: "keep" }),
      expect.objectContaining({ requesterAgentIdOverride: "agent-alice" }),
    );
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      id: "agent-alice",
      name: "Alice",
      workspace: "/tmp/alice",
      identity: { name: "Alice", avatar: "https://example.com/alice.png" },
      soulFactory: {
        managed: true,
        soulId: "soul-alice",
        controllerPubkey: CONTROLLER_PUBKEY,
        runtimePubkey: RUNTIME_PUBKEY,
        capabilityRef: "capability-event",
        specHash: "sha256:spec",
        state: "running",
        session: { key: "agent:agent-alice:subagent:1", runId: "run-1" },
      },
    });
  });

  it("dispatches all documented lifecycle methods to config/session APIs", async () => {
    const { executeSoulFactoryRuntimeRequest } = await import("./soulfactory-execution.js");
    await executeSoulFactoryRuntimeRequest(validatedRequest("soulfactory.provision"));

    for (const method of [
      "soulfactory.update",
      "soulfactory.suspend",
      "soulfactory.resume",
      "soulfactory.redeploy",
      "soulfactory.revoke",
    ] as const) {
      const outcome = await executeSoulFactoryRuntimeRequest(validatedRequest(method));
      expect(outcome.status).toBe("success");
    }

    expect(hoisted.deleteSessionMock).toHaveBeenCalledWith({
      sessionKey: "agent:agent-alice:subagent:1",
      deleteTranscript: false,
    });
    expect(hoisted.spawnSessionDirectMock).toHaveBeenCalledTimes(3);
    expect(
      (hoisted.state.cfg.agents.list[0] as { soulFactory?: unknown }).soulFactory,
    ).toMatchObject({
      state: "revoked",
      specHash: "sha256:spec",
      lastRuntimeRequestEvent: expect.any(String),
    });
  });
});
