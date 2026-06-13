import Docker from "dockerode";
import {
  DEFAULT_LIMITS,
  RUNNER_PORT,
  type ExecHooks,
  type LogLine,
  type NodeExecRequest,
  type NodeExecResult,
  type NodeExecutor,
  type RouteEvalRequest,
  type SandboxLimits,
} from "@flow/contracts";

export const RUN_LABEL = "flow.run-id";

export interface DockerExecutorDeps {
  /** Resolves the deployed image for a flow version (from the flows table). */
  imageFor: (flowId: string, flowVersion: number) => Promise<string>;
  limits?: SandboxLimits;
  env?: Record<string, string>;
  docker?: Docker;
}

interface RunContainer {
  containerId: string;
  baseUrl: string;
  detachLogs: () => void;
}

const workspaceVolume = (runId: string) => `ws-${runId}`;

/**
 * One container per active run: node logic and route evaluation are HTTP calls to the
 * runner inside it. The /workspace volume outlives the container so paused runs resume
 * with their filesystem intact.
 */
export class DockerExecutor implements NodeExecutor {
  private readonly docker: Docker;
  private readonly containers = new Map<string, Promise<RunContainer>>();
  private readonly logSinks = new Map<string, Set<(line: LogLine) => void>>();

  constructor(private readonly deps: DockerExecutorDeps) {
    this.docker = deps.docker ?? new Docker();
  }

  async execute(request: NodeExecRequest, hooks: ExecHooks): Promise<NodeExecResult> {
    const sink = this.addLogSink(request.runId, hooks.onLog);
    try {
      const { baseUrl } = await this.containerFor(request.runId, request.flowId, request.flowVersion);
      const response = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request }),
        signal: anySignal(hooks.signal, AbortSignal.timeout(request.timeoutMs + 30_000)),
      });
      if (!response.ok) {
        return { kind: "error", message: `Runner replied ${response.status}: ${await response.text()}`, retryable: true };
      }
      return (await response.json()) as NodeExecResult;
    } catch (error) {
      return {
        kind: "error",
        message: `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
    } finally {
      sink.remove();
    }
  }

  async evaluateRoute(request: RouteEvalRequest): Promise<string[]> {
    const { baseUrl } = await this.containerFor(request.runId, request.flowId, request.flowVersion);
    const response = await fetch(`${baseUrl}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Route evaluation failed (${response.status}): ${await response.text()}`);
    const { targets } = (await response.json()) as { targets: string[] };
    return targets;
  }

  /** Stops the run's container; the workspace volume is kept unless removeWorkspace is set. */
  async release(runId: string, opts: { removeWorkspace: boolean }): Promise<void> {
    const pending = this.containers.get(runId);
    this.containers.delete(runId);
    if (pending) {
      const { containerId, detachLogs } = await pending.catch(() => ({ containerId: null, detachLogs: () => {} }));
      detachLogs();
      if (containerId) await this.removeContainer(containerId);
    }
    if (opts.removeWorkspace) {
      await this.docker.getVolume(workspaceVolume(runId)).remove().catch(() => undefined);
    }
    this.logSinks.delete(runId);
  }

  /** Removes containers labelled with run ids this worker no longer owns (post-crash cleanup). */
  async sweepOrphans(ownedRunIds: ReadonlySet<string>): Promise<void> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [RUN_LABEL] } });
    for (const info of list) {
      const runId = info.Labels[RUN_LABEL];
      if (runId && !ownedRunIds.has(runId) && !this.containers.has(runId)) {
        await this.removeContainer(info.Id);
      }
    }
  }

  private containerFor(runId: string, flowId: string, flowVersion: number): Promise<RunContainer> {
    const existing = this.containers.get(runId);
    if (existing) return existing;
    const created = this.startContainer(runId, flowId, flowVersion);
    this.containers.set(runId, created);
    created.catch(() => this.containers.delete(runId));
    return created;
  }

  private async startContainer(runId: string, flowId: string, flowVersion: number): Promise<RunContainer> {
    const image = await this.deps.imageFor(flowId, flowVersion);
    const limits = this.deps.limits ?? DEFAULT_LIMITS;
    const container = await this.docker.createContainer({
      name: `flow-run-${runId}`,
      Image: image,
      Labels: { [RUN_LABEL]: runId },
      Env: Object.entries(this.deps.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Tty: true,
      ExposedPorts: { [`${RUNNER_PORT}/tcp`]: {} },
      HostConfig: {
        Binds: [`${workspaceVolume(runId)}:/workspace`],
        PortBindings: { [`${RUNNER_PORT}/tcp`]: [{ HostPort: "0" }] },
        NanoCpus: Math.round(limits.cpus * 1e9),
        Memory: limits.memoryMb * 1024 * 1024,
        PidsLimit: limits.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        AutoRemove: false,
      },
    });
    await container.start();
    const detachLogs = await this.attachLogs(runId, container);
    const info = await container.inspect();
    const hostPort = info.NetworkSettings.Ports[`${RUNNER_PORT}/tcp`]?.[0]?.HostPort;
    if (!hostPort) {
      await this.removeContainer(container.id);
      throw new Error(`Container for run ${runId} exposed no host port`);
    }
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    await this.waitHealthy(baseUrl, runId);
    return { containerId: container.id, baseUrl, detachLogs };
  }

  private async waitHealthy(baseUrl: string, runId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) return;
      } catch {
        // runner still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`Runner for run ${runId} did not become healthy within 30s`);
  }

  private async attachLogs(runId: string, container: Docker.Container): Promise<() => void> {
    const stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = parseLogLine(raw);
        if (line) for (const sink of this.logSinks.get(runId) ?? []) sink(line);
      }
    };
    stream.on("data", onData);
    return () => stream.removeListener("data", onData);
  }

  private addLogSink(runId: string, onLog: (line: LogLine) => void): { remove: () => void } {
    const sinks = this.logSinks.get(runId) ?? new Set();
    sinks.add(onLog);
    this.logSinks.set(runId, sinks);
    return { remove: () => sinks.delete(onLog) };
  }

  private async removeContainer(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).remove({ force: true }).catch(() => undefined);
  }
}

function parseLogLine(raw: string): LogLine | null {
  const trimmed = raw.replace(/\r$/, "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LogLine>;
    if (parsed.message !== undefined && parsed.level !== undefined) {
      return { level: parsed.level, message: parsed.message, at: parsed.at ?? new Date().toISOString(), ...(parsed.node && { node: parsed.node }) };
    }
  } catch {
    // raw console output from user code
  }
  return { level: "info", message: trimmed, at: new Date().toISOString() };
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
