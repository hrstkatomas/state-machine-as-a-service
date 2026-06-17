import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { driveRun } from "@flow/engine";
import { KubernetesExecutor } from "@flow/sandbox";
import {
  claimRun,
  createPool,
  getFlow,
  getRun,
  heartbeat,
  listen,
  RUN_WAKEUP_CHANNEL,
  setWorkspace,
  type RunRow,
} from "@flow/storage";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://flow:flow@localhost:5432/flow";
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 10);
const POLL_MS = 1_000;
const HEARTBEAT_MS = 20_000;

const workerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
const host = process.env.WORKER_HOST ?? hostname();
const pool = createPool(DATABASE_URL);

const executor = new KubernetesExecutor({
  imageFor: async (flowId, flowVersion) => {
    const flow = await getFlow(pool, flowId, flowVersion);
    if (!flow?.imageRef) throw new Error(`Flow ${flowId}@${flowVersion} has no deployed image`);
    return flow.imageRef;
  },
});

const active = new Map<string, AbortController>();
let shuttingDown = false;
let wakeRequested = false;

const log = (message: string) => console.log(`[worker ${workerId}] ${message}`);

async function processRun(run: RunRow): Promise<void> {
  const controller = new AbortController();
  active.set(run.id, controller);
  log(`claimed run ${run.id} (${run.flowId}@${run.flowVersion}, step ${run.currentStep})`);
  // No host pinning under K8s: the kube-scheduler places the Pod (and its PVC), so any worker can
  // drive or resume any run. Recording a null host keeps claimRun's affinity filter always satisfiable.
  await setWorkspace(pool, run.id, `ws-${run.id}`, null);

  const beat = setInterval(() => {
    void (async () => {
      const alive = await heartbeat(pool, run.id, workerId).catch(() => false);
      if (!alive) {
        log(`lost lease on run ${run.id}, aborting`);
        controller.abort();
        return;
      }
      const current = await getRun(pool, run.id).catch(() => null);
      if (current?.cancelRequested) controller.abort();
    })();
  }, HEARTBEAT_MS);

  try {
    await driveRun({ pool, executor, signal: controller.signal }, run.id);
  } catch (error) {
    log(`run ${run.id} crashed in engine: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearInterval(beat);
    active.delete(run.id);
    const final = await getRun(pool, run.id).catch(() => null);
    const terminal = final && ["completed", "failed", "cancelled"].includes(final.status);
    await executor.release(run.id, { removeWorkspace: Boolean(terminal) }).catch(() => undefined);
    log(`run ${run.id} finished with status ${final?.status ?? "unknown"}`);
  }
}

async function claimLoop(): Promise<void> {
  while (!shuttingDown) {
    wakeRequested = false;
    while (active.size < CONCURRENCY && !shuttingDown) {
      const run = await claimRun(pool, workerId, host).catch((error) => {
        log(`claim failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (!run) break;
      void processRun(run);
    }
    if (!wakeRequested) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const listener = await listen(DATABASE_URL, RUN_WAKEUP_CHANNEL, () => {
  wakeRequested = true;
});

await executor.sweepOrphans(new Set()).catch((error) => log(`orphan sweep failed: ${error}`));

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down, aborting active runs");
  for (const controller of active.values()) controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await listener.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`started (host=${host}, concurrency=${CONCURRENCY})`);
await claimLoop();
