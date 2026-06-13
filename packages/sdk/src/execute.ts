import { spawn } from "node:child_process";
import { z } from "zod";
import type {
  Json,
  JsonObject,
  LogLine,
  NodeExecRequest,
  NodeExecResult,
  RouteEvalRequest,
} from "@flow/contracts";
import { GraphInterrupt, type ExecOpts, type ExecResult, type NodeLogger } from "./context.js";
import { createNodeCtx } from "./context.js";
import type { AnyFlow } from "./registry.js";

export interface ExecuteOptions {
  workspaceDir: string;
  onLog: (line: LogLine) => void;
  signal: AbortSignal;
}

const parseState = (flow: AnyFlow, state: JsonObject): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(flow.channels).map(([key, c]) => [key, c.schema.parse(state[key] ?? c.default())]),
  );

const parseWrites = (flow: AnyFlow, writes: Record<string, unknown>): JsonObject =>
  Object.fromEntries(
    Object.entries(writes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const c = flow.channels[key];
        if (!c) throw new Error(`Node wrote unknown channel "${key}"`);
        return [key, c.schema.parse(value) as Json];
      }),
  );

const makeLogger = (node: string, onLog: (line: LogLine) => void): NodeLogger => {
  const log = (level: LogLine["level"]) => (message: string) =>
    onLog({ level, message, node, at: new Date().toISOString() });
  return { info: log("info"), warn: log("warn"), error: log("error") };
};

function runShell(workspaceDir: string, signal: AbortSignal, onLog: (line: LogLine) => void, node: string) {
  return (command: string, opts: ExecOpts): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", command], {
        cwd: opts.cwd ?? workspaceDir,
        env: { ...process.env, ...opts.env },
        signal,
        timeout: opts.timeoutMs ?? 600_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        onLog({ level: "info", message: chunk.toString().trimEnd(), node, at: new Date().toISOString() });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        onLog({ level: "warn", message: chunk.toString().trimEnd(), node, at: new Date().toISOString() });
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
}

/** Runs one node of a flow — used by both the engine's InProcessExecutor and the sandbox runner. */
export async function executeNode(
  flow: AnyFlow,
  request: NodeExecRequest,
  options: ExecuteOptions,
): Promise<NodeExecResult> {
  const node = flow.nodes.get(request.node);
  if (!node) return { kind: "error", message: `Unknown node "${request.node}"`, retryable: false };
  const ctx = createNodeCtx({
    runId: request.runId,
    step: request.step,
    attempt: request.attempt,
    signal: options.signal,
    logger: makeLogger(request.node, options.onLog),
    resume: request.resume,
    runShell: runShell(options.workspaceDir, options.signal, options.onLog, request.node),
    toResponseSchema: (schema) => z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonObject,
  });
  try {
    const writes = await node.handler(parseState(flow, request.state), ctx);
    return { kind: "writes", writes: parseWrites(flow, writes) };
  } catch (error) {
    if (error instanceof GraphInterrupt) {
      return {
        kind: "interrupt",
        ordinal: error.ordinal,
        payload: error.payload,
        ...(error.responseSchema && { responseSchema: error.responseSchema }),
        ...(error.eventTopic && { eventTopic: error.eventTopic }),
      };
    }
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      kind: "error",
      message: err.message,
      ...(err.stack && { stack: err.stack }),
      retryable: !(err instanceof z.ZodError),
    };
  }
}

export function evaluateRoute(flow: AnyFlow, request: RouteEvalRequest): string[] {
  const edge = flow.edges.get(request.node);
  if (!edge) return [];
  const state = parseState(flow, request.state);
  switch (edge.kind) {
    case "static":
      return [edge.to];
    case "conditional":
      return [edge.route(state)];
    case "fanOut":
      return [...edge.route(state)];
  }
}
