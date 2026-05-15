import { isAcpRuntimeSpawnAvailable } from "../acp/runtime/availability.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import {
  isSpawnAcpAcceptedResult,
  spawnAcpDirect,
  type SpawnAcpContext,
  type SpawnAcpMode,
  type SpawnAcpResult,
} from "./acp-spawn.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentMode,
  type SpawnSubagentResult,
} from "./subagent-spawn.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export type SessionsSpawnRuntime = "subagent" | "acp";
export type SessionsSpawnSandboxMode = "inherit" | "require";
export type SessionsSpawnContextMode = "isolated" | "fork";

export type SpawnSessionRequest = {
  runtime?: SessionsSpawnRuntime;
  task: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
  resumeSessionId?: string;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SessionsSpawnSandboxMode;
  context?: SessionsSpawnContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  streamTo?: "parent";
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSessionContext = {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
} & SpawnedToolContext;

export type SpawnSessionResult =
  | ({ runtime: "subagent"; role?: string } & SpawnSubagentResult)
  | ({ runtime: "acp"; role?: string } & SpawnAcpResult);

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

function resolveAcpUnavailableMessage(opts?: { sandboxed?: boolean; config?: OpenClawConfig }) {
  if (opts?.sandboxed === true) {
    return 'runtime="acp" is unavailable from sandboxed sessions because ACP sessions run on the host. Use runtime="subagent".';
  }
  if (opts?.config?.acp?.enabled === false) {
    return 'runtime="acp" is unavailable because ACP is disabled by policy (`acp.enabled=false`). Use runtime="subagent".';
  }
  return 'runtime="acp" is unavailable in this session because no ACP runtime backend is loaded. Enable the acpx plugin or use runtime="subagent".';
}

export async function spawnSessionDirect(
  request: SpawnSessionRequest,
  context: SpawnSessionContext = {},
): Promise<SpawnSessionResult> {
  const runtime = request.runtime === "acp" ? "acp" : "subagent";
  const requestedAgentId = request.agentId;
  const roleContext = requestedAgentId ? { role: requestedAgentId } : {};
  const sandbox = request.sandbox === "require" ? "require" : "inherit";
  const cleanup =
    request.cleanup === "keep" || request.cleanup === "delete" ? request.cleanup : "keep";
  const expectsCompletionMessage = request.expectsCompletionMessage !== false;
  const thread = request.thread === true;
  const mode = request.mode === "run" || request.mode === "session" ? request.mode : undefined;
  const streamTo = runtime === "acp" && request.streamTo === "parent" ? "parent" : undefined;
  const contextMode =
    request.context === "fork" || request.context === "isolated" ? request.context : undefined;
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: context.config,
    sandboxed: context.sandboxed,
  });

  if (runtime === "acp" && !acpAvailable) {
    return {
      runtime: "acp",
      status: "error",
      error: resolveAcpUnavailableMessage(context),
      errorCode: "acp_disabled",
      ...roleContext,
    };
  }
  if (runtime === "acp" && request.lightContext) {
    throw new Error("lightContext is only supported for runtime='subagent'.");
  }
  if (runtime === "acp" && contextMode === "fork") {
    throw new Error('context="fork" is only supported for runtime="subagent".');
  }
  if (runtime === "acp" && Array.isArray(request.attachments) && request.attachments.length > 0) {
    return {
      runtime: "acp",
      status: "error",
      error:
        "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
      errorCode: "spawn_failed",
      ...roleContext,
    };
  }

  if (runtime === "acp") {
    const result = await spawnAcpDirect(
      {
        task: request.task,
        label: request.label || undefined,
        agentId: requestedAgentId,
        resumeSessionId: request.resumeSessionId,
        model: request.model,
        thinking: request.thinking,
        runTimeoutSeconds: request.runTimeoutSeconds,
        cwd: request.cwd,
        mode,
        thread,
        sandbox,
        streamTo,
      },
      {
        agentSessionKey: context.agentSessionKey,
        agentChannel: context.agentChannel,
        agentAccountId: context.agentAccountId,
        agentTo: context.agentTo,
        agentThreadId: context.agentThreadId,
        agentGroupId: context.agentGroupId ?? undefined,
        agentGroupSpace: context.agentGroupSpace,
        agentMemberRoleIds: context.agentMemberRoleIds,
        sandboxed: context.sandboxed,
      } satisfies SpawnAcpContext,
    );
    const childSessionKey = result.childSessionKey?.trim();
    const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
    const shouldTrackViaRegistry =
      result.status === "accepted" &&
      Boolean(childSessionKey) &&
      Boolean(childRunId) &&
      streamTo !== "parent";
    if (shouldTrackViaRegistry && childSessionKey && childRunId) {
      const cfg = getRuntimeConfig();
      const trackedSpawnMode = resolveTrackedSpawnMode({
        requestedMode: result.mode,
        threadRequested: thread,
      });
      const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey = context.agentSessionKey
        ? resolveInternalSessionKey({
            key: context.agentSessionKey,
            alias,
            mainKey,
          })
        : alias;
      const requesterDisplayKey = resolveDisplaySessionKey({
        key: requesterInternalKey,
        alias,
        mainKey,
      });
      const requesterOrigin = normalizeDeliveryContext({
        channel: context.agentChannel,
        accountId: context.agentAccountId,
        to: context.agentTo,
        threadId: context.agentThreadId,
      });
      const shouldExpectCompletionMessage = result.inlineDelivery
        ? false
        : expectsCompletionMessage;
      try {
        registerSubagentRun({
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
          requesterOrigin,
          requesterDisplayKey,
          task: request.task,
          taskName: request.taskName,
          cleanup: trackedCleanup,
          label: request.label || undefined,
          runTimeoutSeconds: request.runTimeoutSeconds,
          expectsCompletionMessage: shouldExpectCompletionMessage,
          spawnMode: trackedSpawnMode,
        });
      } catch (err) {
        await cleanupUntrackedAcpSession(childSessionKey);
        return {
          runtime: "acp",
          status: "error",
          error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
          errorCode: "spawn_failed",
          childSessionKey,
          runId: childRunId,
          ...roleContext,
        };
      }
    }
    return { runtime: "acp", ...addRoleToFailureResult(result, requestedAgentId) };
  }

  const result = await spawnSubagentDirect(
    {
      task: request.task,
      taskName: request.taskName,
      label: request.label || undefined,
      agentId: requestedAgentId,
      model: request.model,
      thinking: request.thinking,
      runTimeoutSeconds: request.runTimeoutSeconds,
      thread,
      mode,
      cleanup,
      sandbox,
      context: contextMode,
      lightContext: request.lightContext === true,
      expectsCompletionMessage,
      attachments: request.attachments,
      attachMountPath: request.attachMountPath,
    },
    {
      agentSessionKey: context.agentSessionKey,
      agentChannel: context.agentChannel,
      agentAccountId: context.agentAccountId,
      agentTo: context.agentTo,
      agentThreadId: context.agentThreadId,
      agentGroupId: context.agentGroupId,
      agentGroupChannel: context.agentGroupChannel,
      agentGroupSpace: context.agentGroupSpace,
      agentMemberRoleIds: context.agentMemberRoleIds,
      requesterAgentIdOverride: context.requesterAgentIdOverride,
      workspaceDir: context.workspaceDir,
    } satisfies SpawnSubagentContext,
  );

  return { runtime: "subagent", ...addRoleToFailureResult(result, requestedAgentId) };
}
