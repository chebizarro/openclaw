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
  const imageGenerateMock = vi.fn();
  const textToSpeechMock = vi.fn();
  const state = { cfg: { agents: { list: [] as Array<Record<string, unknown>> } } };
  return {
    spawnSessionDirectMock,
    mutateConfigFileMock,
    deleteSessionMock,
    imageGenerateMock,
    textToSpeechMock,
    state,
  };
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
    imageGeneration: {
      generate: hoisted.imageGenerateMock,
    },
    tts: {
      textToSpeech: hoisted.textToSpeechMock,
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
  if (method === "soulfactory.avatar.generate") {
    return { generation: { prompt: "pixel art owl", width: 512, height: 512 } };
  }
  if (method === "soulfactory.avatar.set") {
    return { avatar: { current: "uploaded", uploaded_ref: "blossom:avatar-hash" } };
  }
  if (method === "soulfactory.voice.configure") {
    return {
      voice: {
        provider: "elevenlabs",
        persona_id: "scout-voice",
        auto_mode: "tagged",
        persona: { label: "Scout", profile: "Researcher", style: "clear" },
      },
    };
  }
  if (method === "soulfactory.voice.sample") {
    return { sample_text: "Hello from Scout" };
  }
  if (method === "soulfactory.memory.configure") {
    return {
      memory: {
        embedding_provider: "voyage",
        embedding_model: "voyage-3",
        auto_index: true,
        search: { top_k: 8, score_threshold: 0.7, rerank: true },
      },
    };
  }
  if (method === "soulfactory.persona.update") {
    return {
      identity: { name: "Scout", theme: "warm", emoji: "🔍" },
      persona: {
        traits: ["curious", "patient"],
        style: "conversational",
        system_prompt_sections: { role: "You are Scout.", guidelines: "Cite sources." },
      },
    };
  }
  if (method === "soulfactory.config.reload") {
    return { patch: { identity: { name: "Scout" } } };
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
    hoisted.imageGenerateMock.mockReset().mockResolvedValue({
      images: [{ buffer: Buffer.from("avatar"), mimeType: "image/png", fileName: "avatar.png" }],
      provider: "test-image",
      model: "test-model",
      attempts: [],
      ignoredOverrides: [],
    });
    hoisted.textToSpeechMock.mockReset().mockResolvedValue({
      success: true,
      audioPath: "/tmp/sample.mp3",
      provider: "elevenlabs",
      persona: "scout-voice",
      latencyMs: 12,
      outputFormat: "mp3",
    });
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

  it("validates all customization runtime method envelopes", () => {
    for (const method of [
      "soulfactory.avatar.generate",
      "soulfactory.avatar.set",
      "soulfactory.voice.configure",
      "soulfactory.voice.sample",
      "soulfactory.memory.configure",
      "soulfactory.memory.reindex",
      "soulfactory.persona.update",
      "soulfactory.config.reload",
    ] as const) {
      expect(validatedRequest(method).method).toBe(method);
    }
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

  it("applies avatar and persona customization to managed agent config", async () => {
    const { executeSoulFactoryRuntimeRequest } = await import("./soulfactory-execution.js");
    await executeSoulFactoryRuntimeRequest(validatedRequest("soulfactory.provision"));

    const setOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.avatar.set"),
    );
    expect(setOutcome.status).toBe("success");
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      identity: { avatar: "blossom:avatar-hash" },
    });

    const personaOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.persona.update"),
    );
    expect(personaOutcome.status).toBe("success");
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      name: "Scout",
      identity: { name: "Scout", theme: "warm", emoji: "🔍", avatar: "blossom:avatar-hash" },
      systemPromptOverride: expect.stringContaining("You are Scout."),
    });

    const generateOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.avatar.generate"),
    );
    expect(generateOutcome.status).toBe("success");
    expect(hoisted.imageGenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "pixel art owl", size: "512x512", count: 1 }),
    );
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      identity: { avatar: "data:image/png;base64,YXZhdGFy" },
    });
  });

  it("configures TTS and memory search for managed agents", async () => {
    const { executeSoulFactoryRuntimeRequest } = await import("./soulfactory-execution.js");
    await executeSoulFactoryRuntimeRequest(validatedRequest("soulfactory.provision"));

    const voiceOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.voice.configure"),
    );
    expect(voiceOutcome.status).toBe("success");
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      tts: {
        provider: "elevenlabs",
        persona: "scout-voice",
        auto: "tagged",
        personas: {
          "scout-voice": {
            label: "Scout",
            prompt: { profile: "Researcher", style: "clear" },
          },
        },
      },
    });

    const sampleOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.voice.sample"),
    );
    expect(sampleOutcome.status).toBe("success");
    expect(hoisted.textToSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello from Scout", agentId: "agent-alice" }),
    );

    const memoryOutcome = await executeSoulFactoryRuntimeRequest(
      validatedRequest("soulfactory.memory.configure"),
    );
    expect(memoryOutcome.status).toBe("success");
    expect(hoisted.state.cfg.agents.list[0]).toMatchObject({
      memorySearch: {
        provider: "voyage",
        model: "voyage-3",
        sync: { onSessionStart: true, onSearch: true },
        query: {
          maxResults: 8,
          minScore: 0.7,
          hybrid: { mmr: { enabled: true } },
        },
      },
    });
  });

  it("returns explicit not-implemented errors for pending customization hooks", async () => {
    const { executeSoulFactoryRuntimeRequest } = await import("./soulfactory-execution.js");
    await executeSoulFactoryRuntimeRequest(validatedRequest("soulfactory.provision"));

    for (const method of ["soulfactory.memory.reindex", "soulfactory.config.reload"] as const) {
      const outcome = await executeSoulFactoryRuntimeRequest(validatedRequest(method));
      expect(outcome).toMatchObject({
        status: "rejected",
        error: { code: "execution_failed", retryable: false },
      });
    }
  });
});
