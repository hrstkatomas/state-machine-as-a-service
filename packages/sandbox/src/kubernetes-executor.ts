import { createServer, type Socket } from "node:net";
import { Writable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
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

const NAMESPACE = process.env.FLOW_NAMESPACE ?? "flow-runs";
/** Pull-side registry host prepended to the deployed image ref; differs from the push host on Docker Desktop. */
const REGISTRY = process.env.FLOW_REGISTRY ?? "";
const IMAGE_PULL_POLICY = process.env.FLOW_IMAGE_PULL_POLICY ?? "IfNotPresent";
const STORAGE_CLASS = process.env.FLOW_STORAGE_CLASS;
const PVC_SIZE = process.env.FLOW_PVC_SIZE ?? "1Gi";
const POD_READY_TIMEOUT_MS = Number(process.env.FLOW_POD_READY_TIMEOUT_MS ?? 120_000);

export interface KubernetesExecutorDeps {
  /** Resolves the deployed image ref for a flow version (the unqualified `flows/<id>:<hash>` from the flows table). */
  imageFor: (flowId: string, flowVersion: number) => Promise<string>;
  limits?: SandboxLimits;
  env?: Record<string, string>;
}

interface RunPod {
  baseUrl: string;
  detachLogs: () => void;
  closeNetwork: () => void;
}

const podNameFor = (runId: string) => `flow-run-${runId}`;
const pvcNameFor = (runId: string) => `ws-${runId}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNotFound = (error: unknown) => error instanceof k8s.ApiException && error.code === 404;
const isConflict = (error: unknown) => error instanceof k8s.ApiException && error.code === 409;

const isDead = (pod: k8s.V1Pod) => pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded";
const isReady = (pod: k8s.V1Pod) =>
  pod.status?.phase === "Running" &&
  (pod.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");

const PULL_FAILURES = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);
const imagePullFailure = (pod: k8s.V1Pod): string | null => {
  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting;
    if (waiting?.reason && PULL_FAILURES.has(waiting.reason)) return `${waiting.reason}: ${waiting.message ?? ""}`.trim();
  }
  return null;
};

/**
 * One bare Pod per active run, reached over the same HTTP runner protocol as before. The `ws-<runId>`
 * PVC outlives the Pod so a run paused for human-in-the-loop resumes with its workspace intact — on a
 * different worker if need be, since the kube-scheduler (not the worker) owns Pod placement.
 */
export class KubernetesExecutor implements NodeExecutor {
  private readonly core: k8s.CoreV1Api;
  private readonly watchLogs: k8s.Log;
  private readonly portForward: k8s.PortForward | null;
  private readonly inCluster: boolean;
  private readonly pods = new Map<string, Promise<RunPod>>();
  private readonly logSinks = new Map<string, Set<(line: LogLine) => void>>();

  constructor(private readonly deps: KubernetesExecutorDeps) {
    const kc = new k8s.KubeConfig();
    this.inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
    if (this.inCluster) kc.loadFromCluster();
    else kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.watchLogs = new k8s.Log(kc);
    this.portForward = this.inCluster ? null : new k8s.PortForward(kc);
  }

  async execute(request: NodeExecRequest, hooks: ExecHooks): Promise<NodeExecResult> {
    const sink = this.addLogSink(request.runId, hooks.onLog);
    try {
      const { baseUrl } = await this.podFor(request.runId, request.flowId, request.flowVersion);
      const response = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request }),
        signal: AbortSignal.any([hooks.signal, AbortSignal.timeout(request.timeoutMs + 30_000)]),
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
    const { baseUrl } = await this.podFor(request.runId, request.flowId, request.flowVersion);
    const response = await fetch(`${baseUrl}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Route evaluation failed (${response.status}): ${await response.text()}`);
    return ((await response.json()) as { targets: string[] }).targets;
  }

  /** Tears down the run's Pod; the workspace PVC is kept unless removeWorkspace is set. */
  async release(runId: string, opts: { removeWorkspace: boolean }): Promise<void> {
    const pending = this.pods.get(runId);
    this.pods.delete(runId);
    if (pending) {
      const pod = await pending.catch(() => null);
      pod?.detachLogs();
      pod?.closeNetwork();
    }
    await this.deletePod(runId);
    if (opts.removeWorkspace) await this.deletePvc(runId);
    this.logSinks.delete(runId);
  }

  /** Deletes Pods labelled with run ids this worker no longer owns (post-crash cleanup). Never touches PVCs. */
  async sweepOrphans(ownedRunIds: ReadonlySet<string>): Promise<void> {
    const list = await this.core.listNamespacedPod({ namespace: NAMESPACE, labelSelector: RUN_LABEL });
    for (const pod of list.items) {
      const runId = pod.metadata?.labels?.[RUN_LABEL];
      if (runId && !ownedRunIds.has(runId) && !this.pods.has(runId)) await this.deletePod(runId);
    }
  }

  private podFor(runId: string, flowId: string, flowVersion: number): Promise<RunPod> {
    const existing = this.pods.get(runId);
    if (existing) return existing;
    const created = this.startPod(runId, flowId, flowVersion);
    this.pods.set(runId, created);
    created.catch(() => this.pods.delete(runId));
    return created;
  }

  private async startPod(runId: string, flowId: string, flowVersion: number): Promise<RunPod> {
    let pod = await this.readPod(runId);
    if (pod && (pod.metadata?.deletionTimestamp || isDead(pod))) {
      if (!pod.metadata?.deletionTimestamp) await this.deletePod(runId);
      await this.waitDeleted(runId);
      pod = null;
    }
    if (!pod) {
      await this.ensurePvc(runId);
      await this.createPod(runId, flowId, flowVersion);
    }
    const podIP = await this.waitReady(runId);
    const { baseUrl, closeNetwork } = await this.connect(runId, podIP);
    return { baseUrl, closeNetwork, detachLogs: await this.attachLogs(runId) };
  }

  private async readPod(runId: string): Promise<k8s.V1Pod | null> {
    return this.core.readNamespacedPod({ name: podNameFor(runId), namespace: NAMESPACE }).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
  }

  private async ensurePvc(runId: string): Promise<void> {
    await this.core
      .createNamespacedPersistentVolumeClaim({
        namespace: NAMESPACE,
        body: {
          metadata: { name: pvcNameFor(runId), labels: { [RUN_LABEL]: runId } },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: PVC_SIZE } },
            ...(STORAGE_CLASS ? { storageClassName: STORAGE_CLASS } : {}),
          },
        },
      })
      .catch((error) => {
        if (!isConflict(error)) throw error;
      });
  }

  private async createPod(runId: string, flowId: string, flowVersion: number): Promise<void> {
    const imageRef = await this.deps.imageFor(flowId, flowVersion);
    const image = REGISTRY ? `${REGISTRY}/${imageRef}` : imageRef;
    await this.core
      .createNamespacedPod({ namespace: NAMESPACE, body: this.podManifest(runId, image) })
      .catch((error) => {
        if (!isConflict(error)) throw error; // a second worker won the create race — adopt its Pod
      });
  }

  private podManifest(runId: string, image: string): k8s.V1Pod {
    const limits = this.deps.limits ?? DEFAULT_LIMITS;
    const resources = { cpu: String(limits.cpus), memory: `${limits.memoryMb}Mi` };
    return {
      metadata: { name: podNameFor(runId), labels: { [RUN_LABEL]: runId } },
      spec: {
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 5,
        automountServiceAccountToken: false,
        // runAsUser/Group are the *numeric* UID/GID of the base image's `node` user. The image's
        // `USER node` is a name, and the kubelet can't resolve a name to a UID to satisfy the
        // runAsNonRoot precheck (it doesn't read the image's /etc/passwd) — without an explicit
        // number it fails with CreateContainerConfigError "image has non-numeric user (node)".
        // fsGroup makes the freshly provisioned PVC writable by that user — unlike a Docker named
        // volume, a PVC mounts root-owned. OnRootMismatch skips re-chowning an already-correct
        // workspace, so resuming a run with a large cloned repo stays cheap.
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          fsGroupChangePolicy: "OnRootMismatch",
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [{ name: "workspace", persistentVolumeClaim: { claimName: pvcNameFor(runId) } }],
        containers: [
          {
            name: "runner",
            image,
            imagePullPolicy: IMAGE_PULL_POLICY,
            ports: [{ containerPort: RUNNER_PORT }],
            env: Object.entries(this.deps.env ?? {}).map(([name, value]) => ({ name, value })),
            resources: { limits: resources, requests: resources },
            // No readOnlyRootFilesystem: ctx.exec runs arbitrary user commands (git, npm, ...) that write
            // to $HOME and other root-fs paths. The Docker executor never locked the rootfs down either.
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            readinessProbe: {
              httpGet: { path: "/healthz", port: RUNNER_PORT },
              periodSeconds: 2,
              failureThreshold: 30,
            },
          },
        ],
      },
    };
  }

  /** Polls Pod status until Ready; fails fast on image-pull / container-create errors rather than hanging to timeout. */
  private async waitReady(runId: string): Promise<string | undefined> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pod = await this.readPod(runId);
      if (pod) {
        const failure = imagePullFailure(pod);
        if (failure) throw new Error(`Pod ${podNameFor(runId)} cannot start: ${failure}`);
        if (isDead(pod)) throw new Error(`Pod ${podNameFor(runId)} terminated (${pod.status?.phase}) before ready`);
        if (isReady(pod)) return pod.status?.podIP;
      }
      await delay(750);
    }
    throw new Error(`Pod ${podNameFor(runId)} did not become ready within ${POD_READY_TIMEOUT_MS}ms`);
  }

  /** In-cluster reaches the Pod IP directly; on a dev host a local TCP server bridges each socket through port-forward. */
  private async connect(runId: string, podIP: string | undefined): Promise<{ baseUrl: string; closeNetwork: () => void }> {
    if (this.inCluster) {
      if (!podIP) throw new Error(`Pod for run ${runId} has no IP`);
      return { baseUrl: `http://${podIP}:${RUNNER_PORT}`, closeNetwork: () => {} };
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      // Destroying the local socket when its port-forward stream ends evicts it from fetch's keep-alive
      // pool, so the next request opens a fresh tunnel instead of reusing a dead one.
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      this.portForward!.portForward(NAMESPACE, podNameFor(runId), [RUNNER_PORT], socket, null, socket).catch(() =>
        socket.destroy(),
      );
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("port-forward server got no local port"));
      });
    });
    const closeNetwork = () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    };
    return { baseUrl: `http://127.0.0.1:${port}`, closeNetwork };
  }

  private async attachLogs(runId: string): Promise<() => void> {
    let buffer = "";
    const stream = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = parseLogLine(raw);
          if (line) for (const sink of this.logSinks.get(runId) ?? []) sink(line);
        }
        done();
      },
    });
    const controller = await this.watchLogs
      .log(NAMESPACE, podNameFor(runId), "runner", stream, { follow: true, tailLines: 0 })
      .catch(() => null);
    return () => controller?.abort();
  }

  private addLogSink(runId: string, onLog: (line: LogLine) => void): { remove: () => void } {
    const sinks = this.logSinks.get(runId) ?? new Set();
    sinks.add(onLog);
    this.logSinks.set(runId, sinks);
    return { remove: () => sinks.delete(onLog) };
  }

  private async waitDeleted(runId: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await this.readPod(runId))) return;
      await delay(500);
    }
    throw new Error(`Pod ${podNameFor(runId)} did not terminate within 30s`);
  }

  private async deletePod(runId: string): Promise<void> {
    await this.core
      .deleteNamespacedPod({ name: podNameFor(runId), namespace: NAMESPACE, gracePeriodSeconds: 5 })
      .catch(() => undefined);
  }

  private async deletePvc(runId: string): Promise<void> {
    await this.core
      .deleteNamespacedPersistentVolumeClaim({ name: pvcNameFor(runId), namespace: NAMESPACE })
      .catch(() => undefined);
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
