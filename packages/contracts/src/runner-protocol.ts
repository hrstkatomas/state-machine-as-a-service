import type { NodeExecRequest, NodeExecResult, RouteEvalRequest } from "./executor.js";

/**
 * Wire protocol between the worker and the runner HTTP server inside the sandbox container:
 * POST /execute {request: NodeExecRequest} -> NodeExecResult
 * POST /route   {request: RouteEvalRequest} -> {targets: string[]}
 * GET  /healthz -> 200
 */
export interface RunnerExecuteBody {
  request: NodeExecRequest;
}

export type RunnerExecuteReply = NodeExecResult;

export interface RunnerRouteBody {
  request: RouteEvalRequest;
}

export interface RunnerRouteReply {
  targets: string[];
}

export const RUNNER_PORT = 8088;

export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
}

export interface SandboxSpec {
  runId: string;
  image: string;
  limits: SandboxLimits;
  env: Record<string, string>;
  networkPolicy: "open" | "none";
}

export const DEFAULT_LIMITS: SandboxLimits = { cpus: 1, memoryMb: 2048, pidsLimit: 512 };
