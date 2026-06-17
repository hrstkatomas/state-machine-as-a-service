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
  /**
   * Max process count. The Docker executor enforced this per-container; Kubernetes has no per-Pod
   * field for it (it's the kubelet-level `--pod-max-pids`), so the K8s executor ignores it and relies
   * on the memory limit + OOMKill as the fork-bomb backstop. Kept here for the local/in-process path.
   */
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
