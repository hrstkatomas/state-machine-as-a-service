import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecHooks, NodeExecRequest, NodeExecResult, NodeExecutor, RouteEvalRequest } from "@flow/contracts";
import { evaluateRoute, executeNode, type AnyFlow } from "@flow/sdk";

/** Runs node logic in the worker process — for tests and `flowctl dev` without Docker. */
export class InProcessExecutor implements NodeExecutor {
  private readonly flows: Map<string, AnyFlow>;

  constructor(
    flows: AnyFlow[],
    private readonly workspaceRoot: string,
  ) {
    this.flows = new Map(flows.map((f) => [f.id, f]));
  }

  private flow(flowId: string): AnyFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error(`Flow "${flowId}" is not registered in the in-process executor`);
    return flow;
  }

  async execute(request: NodeExecRequest, hooks: ExecHooks): Promise<NodeExecResult> {
    const workspaceDir = join(this.workspaceRoot, request.runId);
    await mkdir(workspaceDir, { recursive: true });
    return executeNode(this.flow(request.flowId), request, {
      workspaceDir,
      onLog: hooks.onLog,
      signal: hooks.signal,
    });
  }

  async evaluateRoute(request: RouteEvalRequest): Promise<string[]> {
    return evaluateRoute(this.flow(request.flowId), request);
  }
}
