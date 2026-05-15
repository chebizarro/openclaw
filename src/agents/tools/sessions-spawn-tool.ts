import { Type } from "typebox";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import {
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "../../channels/thread-bindings-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { spawnSessionDirect, type SpawnSessionContext } from "../sessions-spawn-orchestrator.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "../subagent-spawn.js";
import { normalizeSubagentTaskName } from "../subagent-task-name.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  normalizeToolModelOverride,
  readStringParam,
  ToolInputError,
} from "./common.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type SessionsSpawnThreadAvailability = {
  subagent: boolean;
  acp: boolean;
};

function hasAnyThreadAvailability(availability: SessionsSpawnThreadAvailability): boolean {
  return availability.subagent || availability.acp;
}

function resolveSessionsSpawnThreadAvailability(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): SessionsSpawnThreadAvailability {
  const channel = opts?.agentChannel;
  const cfg = opts?.config;
  if (!channel || !cfg || !supportsAutomaticThreadBindingSpawn(channel)) {
    return { subagent: false, acp: false };
  }
  const resolve = (kind: "subagent" | "acp") => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg,
      channel,
      accountId: opts?.agentAccountId,
      kind,
    });
    return policy.enabled && policy.spawnEnabled;
  };
  return {
    subagent: resolve("subagent"),
    acp: resolve("acp"),
  };
}

function createSessionsSpawnToolSchema(params: {
  acpAvailable: boolean;
  threadAvailable: boolean;
}) {
  const spawnModes = params.threadAvailable ? SUBAGENT_SPAWN_MODES : (["run"] as const);
  const schema = {
    task: Type.String(),
    taskName: Type.Optional(
      Type.String({
        description:
          "Stable optional alias for later subagents targeting. Use lowercase letters, digits, and underscores, starting with a letter.",
      }),
    ),
    label: Type.Optional(Type.String()),
    runtime: optionalStringEnum(
      params.acpAvailable ? SESSIONS_SPAWN_RUNTIMES : (["subagent"] as const),
    ),
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    // Back-compat: older callers used timeoutSeconds for this tool.
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    ...(params.threadAvailable
      ? {
          thread: Type.Optional(
            Type.Boolean({
              description:
                'Bind the spawned session to a new chat thread when the current channel/account supports thread-bound session spawns. `thread=true` defaults mode to "session".',
            }),
          ),
        }
      : {}),
    mode: optionalStringEnum(spawnModes),
    cleanup: optionalStringEnum(["delete", "keep"] as const),
    sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
    context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
      description:
        'Native subagent context mode. Omit or use "isolated" for a clean child session; use "fork" only when the child needs the requester transcript context.',
    }),
    lightContext: Type.Optional(
      Type.Boolean({
        description:
          "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
      }),
    ),

    // Inline attachments (snapshot-by-value).
    // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          content: Type.String(),
          encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
          mimeType: Type.Optional(Type.String()),
        }),
        { maxItems: 50 },
      ),
    ),
    attachAs: Type.Optional(
      Type.Object({
        // Where the spawned agent should look for attachments.
        // Kept as a hint; implementation materializes into the child workspace.
        mountPath: Type.Optional(Type.String()),
      }),
    ),
    ...(params.acpAvailable
      ? {
          resumeSessionId: Type.Optional(
            Type.String({
              description:
                'ACP-only resume target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use only an ACP/harness session ID already recorded for this requester so the ACP backend replays conversation history instead of starting fresh.',
            }),
          ),
          streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS, {
            description:
              'ACP-only stream target. Only meaningful with runtime="acp"; ignored for runtime="subagent". Use "parent" to stream the ACP turn back to the requester instead of tracking it as a background sessions_spawn run.',
          }),
        }
      : {}),
  };
  return Type.Object(schema);
}

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  const acpAvailable = isAcpRuntimeSpawnAvailable({
    config: opts?.config,
    sandboxed: opts?.sandboxed,
  });
  const threadAvailability = resolveSessionsSpawnThreadAvailability(opts);
  const threadAvailable = hasAnyThreadAvailability(threadAvailability);
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: acpAvailable
      ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
      : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool({ acpAvailable, threadAvailable }),
    parameters: createSessionsSpawnToolSchema({ acpAvailable, threadAvailable }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const taskNameResult = normalizeSubagentTaskName(params.taskName);
      if (taskNameResult.error) {
        return jsonResult({
          status: "error",
          error: taskNameResult.error,
        });
      }
      const taskName = taskNameResult.taskName;
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      const modelOverride = normalizeToolModelOverride(readStringParam(params, "model"));
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      const sandbox = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = runtime === "acp" && params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;
      const attachMountPath =
        params.attachAs && typeof params.attachAs === "object"
          ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
          : undefined;

      const { runtime: _spawnRuntime, ...result } = await spawnSessionDirect(
        {
          runtime,
          task,
          taskName,
          label: label || undefined,
          agentId: requestedAgentId,
          resumeSessionId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          cwd,
          mode,
          cleanup,
          sandbox,
          context,
          streamTo,
          thread,
          lightContext,
          expectsCompletionMessage,
          attachments,
          attachMountPath,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          agentMemberRoleIds: opts?.agentMemberRoleIds,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          workspaceDir: opts?.workspaceDir,
          sandboxed: opts?.sandboxed,
          config: opts?.config,
        } satisfies SpawnSessionContext,
      );

      return jsonResult(result);
    },
  };
}
