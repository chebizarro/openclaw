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
  agentDir?: string;
  systemPromptOverride?: string;
  memorySearch?: Record<string, unknown>;
  tts?: Record<string, unknown>;
  identity?: { name?: string; theme?: string; emoji?: string; avatar?: string };
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

const MAX_INLINE_AVATAR_BYTES = 16 * 1024;

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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? structuredClone(value) : undefined;
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
          ...existing.identity,
          ...patch.identity,
        }
      : undefined;
  const next: ManagedAgentEntry = {
    ...existing,
    ...patch,
    id: normalized,
    ...(identity ? { identity } : {}),
    soulFactory: {
      ...existing.soulFactory,
      ...patch.soulFactory,
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

function notImplemented(method: SoulFactoryMethod): SoulFactoryExecutionOutcome {
  return rejected(
    "execution_failed",
    `${method} is registered but not implemented in OpenClaw yet`,
  );
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

async function persistCustomizationPatch(params: {
  request: ValidatedSoulFactoryRequest;
  current: ManagedAgentEntry;
  patch: Partial<ManagedAgentEntry>;
  specHash?: string;
}): Promise<ManagedAgentEntry> {
  const runtime = getNostrRuntime();
  const request = params.request;
  const currentState = params.current.soulFactory?.state ?? "running";
  const patch: Partial<ManagedAgentEntry> = {
    ...params.patch,
    soulFactory: {
      managed: true,
      soulId: request.soul,
      soulEvent: request.envelope.soul.event,
      soulDraft: request.envelope.soul.draft,
      ownerPubkey: request.envelope.operator?.pubkey,
      controllerPubkey: request.event.pubkey,
      runtimePubkey: request.envelope.target.runtime_pubkey,
      capabilityRef: params.current.soulFactory?.capabilityRef,
      controlRelays: params.current.soulFactory?.controlRelays,
      specHash: params.specHash ?? request.specHash,
      lastOperatorRequestEvent: request.operatorRequestEvent,
      lastRuntimeRequestEvent: request.event.id,
      runtimeBinding: `openclaw://agents/${request.agentId}`,
      state: currentState,
      session: params.current.soulFactory?.session,
      updatedAt: Math.floor(Date.now() / 1000),
    },
  };
  const result = await runtime.config.mutateConfigFile<ManagedAgentEntry>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => upsertManagedAgent(draft, request.agentId, patch),
  });
  return (
    result.result ?? findAgentEntry(result.nextConfig, request.agentId) ?? { id: request.agentId }
  );
}

function getManagedAgent(request: ValidatedSoulFactoryRequest): ManagedAgentEntry | undefined {
  const current = findAgentEntry(
    getNostrRuntime().config.current() as OpenClawConfig,
    request.agentId,
  );
  return current?.soulFactory?.managed ? current : undefined;
}

function managedAgentUnavailable(
  request: ValidatedSoulFactoryRequest,
): SoulFactoryExecutionOutcome {
  return rejected("runtime_unavailable", `managed agent ${request.agentId} is not provisioned`);
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

function humanizePersonaSectionName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildPersonaSystemPrompt(params: Record<string, unknown>): string | undefined {
  const direct = readString(params.system_prompt) ?? readString(params.systemPromptOverride);
  if (direct) {
    return direct;
  }
  const persona = readRecord(params.persona) ?? {};
  const personaDirect =
    readString(persona.system_prompt) ?? readString(persona.systemPromptOverride);
  if (personaDirect) {
    return personaDirect;
  }

  const lines: string[] = [];
  const sections =
    readRecord(persona.system_prompt_sections) ?? readRecord(persona.systemPromptSections);
  if (sections) {
    const preferred = ["role", "identity", "style", "guidelines", "constraints", "red_lines"];
    const keys = [
      ...preferred.filter((key) => typeof sections[key] === "string"),
      ...Object.keys(sections)
        .filter((key) => !preferred.includes(key) && typeof sections[key] === "string")
        .toSorted(),
    ];
    for (const key of keys) {
      const text = readString(sections[key]);
      if (text) {
        lines.push(`## ${humanizePersonaSectionName(key)}\n${text}`);
      }
    }
  }

  const traits = readStringArray(persona.traits);
  if (traits) {
    lines.push(`Traits: ${traits.join(", ")}`);
  }
  const style = readString(persona.style);
  if (style) {
    lines.push(`Style: ${style}`);
  }
  const tone = readString(persona.tone);
  if (tone) {
    lines.push(`Tone: ${tone}`);
  }
  const constraints = readStringArray(persona.constraints);
  if (constraints) {
    lines.push(`Constraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}`);
  }

  return lines.length > 0 ? lines.join("\n\n") : undefined;
}

function readIdentityPatch(
  params: Record<string, unknown>,
): ManagedAgentEntry["identity"] | undefined {
  const raw = readRecord(params.identity) ?? readRecord(readRecord(params.persona)?.identity);
  if (!raw) {
    return undefined;
  }
  const identity = Object.fromEntries(
    Object.entries({
      name: readString(raw.name),
      theme: readString(raw.theme),
      emoji: readString(raw.emoji),
      avatar: readString(raw.avatar) ?? readString(raw.avatar_ref),
    }).filter(([, value]) => value !== undefined),
  ) as ManagedAgentEntry["identity"];
  return identity && Object.values(identity).some(Boolean) ? identity : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readAvatarGenerationParams(params: Record<string, unknown>): Record<string, unknown> {
  const avatar = readRecord(params.avatar);
  return readRecord(params.generation) ?? readRecord(avatar?.generation) ?? params;
}

function buildAvatarPrompt(prompt: string, generation: Record<string, unknown>): string {
  const stylePreset = readString(generation.style_preset);
  return stylePreset ? `${prompt}\n\nStyle preset: ${stylePreset}` : prompt;
}

function readAvatarModelOverride(
  generation: Record<string, unknown>,
): SoulFactoryExecutionOutcome | string | undefined {
  const model = firstString(generation.model_ref, generation.model);
  const provider = readString(generation.provider);
  if (provider && !model) {
    return rejected(
      "missing_required_param",
      "avatar.generate provider requires model or model_ref so OpenClaw can honor the requested provider",
    );
  }
  if (provider && model && !model.includes("/")) {
    return `${provider}/${model}`;
  }
  return model;
}

function resolveAvatarRef(params: Record<string, unknown>): string | undefined {
  const avatar = readRecord(params.avatar);
  const current = readString(avatar?.current);
  if (current === "generated") {
    return readString(avatar?.generated_ref);
  }
  if (current === "uploaded") {
    return readString(avatar?.uploaded_ref);
  }
  return firstString(
    params.avatar_ref,
    params.ref,
    params.current_ref,
    avatar?.avatar_ref,
    avatar?.ref,
    avatar?.current_ref,
    avatar?.generated_ref,
    avatar?.uploaded_ref,
  );
}

async function executeAvatarGenerate(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const generation = readAvatarGenerationParams(request.envelope.params);
  const prompt = firstString(generation.prompt, request.envelope.params.prompt);
  if (!prompt) {
    return rejected("missing_required_param", "avatar.generate requires prompt");
  }

  if (readString(generation.seed)) {
    return rejected(
      "invalid_schema",
      "avatar.generate seed is not supported by the OpenClaw image-generation runtime yet",
    );
  }
  const modelOverride = readAvatarModelOverride(generation);
  if (typeof modelOverride === "object") {
    return modelOverride;
  }
  const width = readFiniteNumber(generation.width);
  const height = readFiniteNumber(generation.height);
  const size = firstString(generation.size, width && height ? `${width}x${height}` : undefined);
  const effectivePrompt = buildAvatarPrompt(prompt, generation);
  const runtime = getNostrRuntime();
  const generated = await runtime.imageGeneration.generate({
    cfg: runtime.config.current() as OpenClawConfig,
    prompt: effectivePrompt,
    agentDir: current.agentDir ?? current.workspace,
    modelOverride,
    count: 1,
    ...(size ? { size } : {}),
    ...(readString(generation.output_format)
      ? { outputFormat: readString(generation.output_format) as "png" | "jpeg" | "webp" }
      : {}),
  });
  const image = generated.images[0];
  if (!image) {
    return failed("avatar generation returned no images", false);
  }
  if (image.buffer.length > MAX_INLINE_AVATAR_BYTES) {
    return rejected(
      "execution_failed",
      `generated avatar is too large to inline safely in a 38386 result (${image.buffer.length} bytes > ${MAX_INLINE_AVATAR_BYTES} bytes); configure Blossom/file-backed avatar storage first`,
    );
  }
  const avatarRef = `data:${image.mimeType};base64,${image.buffer.toString("base64")}`;
  const entry = await persistCustomizationPatch({
    request,
    current,
    patch: {
      identity: { ...current.identity, avatar: avatarRef },
    },
  });
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: entry.soulFactory?.state ?? "running" }),
      avatar_ref: avatarRef,
      provider: generated.provider,
      model: generated.model,
      image: {
        mime_type: image.mimeType,
        file_name: image.fileName,
        revised_prompt: image.revisedPrompt,
        metadata: image.metadata,
      },
      generation: {
        prompt: effectivePrompt,
        style_preset: readString(generation.style_preset),
        seed: readString(generation.seed),
      },
    },
    error: null,
  };
}

async function executeAvatarSet(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const avatarRef = resolveAvatarRef(request.envelope.params);
  if (!avatarRef) {
    return rejected("missing_required_param", "avatar.set requires avatar_ref");
  }
  const entry = await persistCustomizationPatch({
    request,
    current,
    patch: { identity: { ...current.identity, avatar: avatarRef } },
  });
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: entry.soulFactory?.state ?? "running" }),
      avatar_ref: avatarRef,
    },
    error: null,
  };
}

async function executePersonaUpdate(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const identity = readIdentityPatch(request.envelope.params);
  const systemPromptOverride = buildPersonaSystemPrompt(request.envelope.params);
  if (!identity && !systemPromptOverride) {
    return rejected(
      "missing_required_param",
      "persona.update requires identity or system prompt changes",
    );
  }
  const patch: Partial<ManagedAgentEntry> = {
    ...(identity?.name ? { name: identity.name } : {}),
    ...(identity ? { identity: { ...current.identity, ...identity } } : {}),
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
  };
  const entry = await persistCustomizationPatch({ request, current, patch });
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: entry.soulFactory?.state ?? "running" }),
      identity: entry.identity ?? null,
      system_prompt_updated: Boolean(systemPromptOverride),
      system_prompt_chars: systemPromptOverride?.length ?? 0,
    },
    error: null,
  };
}

function buildVoiceTtsConfig(
  current: ManagedAgentEntry,
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = readRecord(params.tts) ?? readRecord(params.voice) ?? params;
  const provider = firstString(raw.provider, params.provider);
  const personaId = firstString(raw.persona_id, raw.personaId, raw.persona);
  const auto = firstString(raw.auto_mode, raw.auto, params.auto_mode);
  const next: Record<string, unknown> = {
    ...cloneRecord(current.tts),
    ...cloneRecord(params.tts),
  };
  if (provider) {
    next.provider = provider;
  }
  if (personaId) {
    next.persona = personaId;
  }
  if (auto) {
    next.auto = auto;
  }
  const providers = cloneRecord(raw.providers);
  if (providers) {
    next.providers = { ...readRecord(next.providers), ...providers };
  }
  const persona = readRecord(raw.persona);
  if (personaId && persona) {
    const prompt = {
      profile: readString(persona.profile),
      scene: readString(persona.scene),
      sampleContext: readString(persona.sample_context) ?? readString(persona.sampleContext),
      style: readString(persona.style),
      accent: readString(persona.accent),
      pacing: readString(persona.pacing),
      constraints: readStringArray(persona.constraints),
    };
    next.personas = {
      ...readRecord(next.personas),
      [personaId]: {
        label: readString(persona.label),
        description: readString(persona.description),
        provider,
        prompt: Object.fromEntries(
          Object.entries(prompt).filter(([, value]) => value !== undefined),
        ),
        ...(cloneRecord(persona.providers) ? { providers: cloneRecord(persona.providers) } : {}),
      },
    };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

async function executeVoiceConfigure(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const tts = buildVoiceTtsConfig(current, request.envelope.params);
  if (!tts) {
    return rejected("missing_required_param", "voice.configure requires voice parameters");
  }
  const entry = await persistCustomizationPatch({ request, current, patch: { tts } });
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: entry.soulFactory?.state ?? "running" }),
      tts,
    },
    error: null,
  };
}

async function executeVoiceSample(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const text = firstString(request.envelope.params.sample_text, request.envelope.params.text);
  if (!text) {
    return rejected("missing_required_param", "voice.sample requires sample_text");
  }
  const runtime = getNostrRuntime();
  const sample = await runtime.tts.textToSpeech({
    text,
    cfg: runtime.config.current() as OpenClawConfig,
    agentId: request.agentId,
    timeoutMs: readFiniteNumber(request.envelope.params.timeout_ms),
  });
  if (!sample.success) {
    return failed(sample.error ?? "voice sample generation failed", false);
  }
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: current.soulFactory?.state ?? "running" }),
      sample_audio_ref: sample.audioPath,
      provider: sample.provider,
      persona: sample.persona,
      latency_ms: sample.latencyMs,
      output_format: sample.outputFormat,
      voice_compatible: sample.voiceCompatible,
    },
    error: null,
  };
}

function buildMemorySearchConfig(
  current: ManagedAgentEntry,
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = readRecord(params.memory) ?? params;
  const search = readRecord(raw.search) ?? readRecord(params.search);
  const next: Record<string, unknown> = { ...cloneRecord(current.memorySearch) };
  const provider = firstString(
    raw.embedding_provider,
    raw.provider,
    params.embedding_provider,
    params.provider,
  );
  const model = firstString(raw.embedding_model, raw.model, params.embedding_model, params.model);
  if (provider) {
    next.provider = provider;
  }
  if (model) {
    next.model = model;
  }
  const autoIndex = readBoolean(raw.auto_index);
  if (autoIndex !== undefined) {
    next.sync = { ...readRecord(next.sync), onSessionStart: autoIndex, onSearch: autoIndex };
  }
  if (search) {
    const query: Record<string, unknown> = { ...readRecord(next.query) };
    const topK = readFiniteNumber(search.top_k) ?? readFiniteNumber(search.max_results);
    const scoreThreshold =
      readFiniteNumber(search.score_threshold) ?? readFiniteNumber(search.min_score);
    if (topK !== undefined) {
      query.maxResults = topK;
    }
    if (scoreThreshold !== undefined) {
      query.minScore = scoreThreshold;
    }
    const rerank = readBoolean(search.rerank);
    if (rerank !== undefined) {
      query.hybrid = {
        ...readRecord(query.hybrid),
        mmr: { ...readRecord(readRecord(query.hybrid)?.mmr), enabled: rerank },
      };
    }
    if (Object.keys(query).length > 0) {
      next.query = query;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

async function executeMemoryConfigure(
  request: ValidatedSoulFactoryRequest,
): Promise<SoulFactoryExecutionOutcome> {
  const current = getManagedAgent(request);
  if (!current) {
    return managedAgentUnavailable(request);
  }
  const memorySearch = buildMemorySearchConfig(current, request.envelope.params);
  if (!memorySearch) {
    return rejected("missing_required_param", "memory.configure requires memory parameters");
  }
  const entry = await persistCustomizationPatch({
    request,
    current,
    patch: { memorySearch },
  });
  return {
    status: "success",
    result: {
      ...resultFor({ request, state: entry.soulFactory?.state ?? "running" }),
      memory_search: memorySearch,
    },
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
    "soulfactory.avatar.generate": () => executeAvatarGenerate(request),
    "soulfactory.avatar.set": () => executeAvatarSet(request),
    "soulfactory.voice.configure": () => executeVoiceConfigure(request),
    "soulfactory.voice.sample": () => executeVoiceSample(request),
    "soulfactory.memory.configure": () => executeMemoryConfigure(request),
    "soulfactory.memory.reindex": async () => notImplemented(request.method),
    "soulfactory.persona.update": () => executePersonaUpdate(request),
    "soulfactory.config.reload": async () => notImplemented(request.method),
  };
  return await handlers[request.method]();
}
