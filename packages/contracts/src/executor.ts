import type { Json, JsonObject } from "./json.js";
import type { RunId, TaskId } from "./ids.js";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  at: string;
  node?: string;
}

export interface ResumeValue {
  ordinal: number;
  value: Json;
}

export interface NodeExecRequest {
  taskId: TaskId;
  runId: RunId;
  flowId: string;
  flowVersion: number;
  node: string;
  step: number;
  attempt: number;
  state: JsonObject;
  resume: ResumeValue[];
  timeoutMs: number;
}

export type NodeExecResult =
  | { kind: "writes"; writes: JsonObject }
  | { kind: "interrupt"; ordinal: number; payload: Json; eventTopic?: string; responseSchema?: JsonObject }
  | { kind: "error"; message: string; stack?: string; retryable: boolean };

export interface ExecHooks {
  onLog: (line: LogLine) => void;
  signal: AbortSignal;
}

export interface RouteEvalRequest {
  runId: RunId;
  flowId: string;
  flowVersion: number;
  node: string;
  state: JsonObject;
}

/**
 * Runs node logic somewhere (in-process, Docker sandbox, ...). The engine stays agnostic.
 * Route evaluation also lives here because conditional/fanOut routes are user functions.
 */
export interface NodeExecutor {
  execute(request: NodeExecRequest, hooks: ExecHooks): Promise<NodeExecResult>;
  evaluateRoute(request: RouteEvalRequest): Promise<string[]>;
}
