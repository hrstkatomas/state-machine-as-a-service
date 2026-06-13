import type pg from "pg";
import type {
  EngineEvent,
  FlowManifest,
  Json,
  JsonObject,
  LogLine,
  NodeExecResult,
  NodeExecutor,
  RunId,
} from "@flow/contracts";
import { END } from "@flow/contracts";
import {
  appendEvent,
  createInterrupt,
  deterministicTaskId,
  getRun,
  insertLogs,
  latestAttempt,
  latestCheckpoint,
  recordTask,
  resolvedForNode,
  saveCheckpoint,
  succeededTasks,
  updateRunStatus,
  withTransaction,
  type CheckpointRow,
  type RunRow,
  getFlow,
} from "@flow/storage";
import { applyWrites, initialState, type NodeWrites } from "./reducers.js";

export interface DriveDeps {
  pool: pg.Pool;
  executor: NodeExecutor;
  /** Aborts the drive when the worker loses its lease or shuts down. */
  signal: AbortSignal;
  nodeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type NodeOutcome =
  | { node: string; kind: "writes"; writes: JsonObject }
  | { node: string; kind: "interrupt"; ordinal: number; payload: Json; responseSchema?: JsonObject; eventTopic?: string }
  | { node: string; kind: "error"; message: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const staticInEdges = (manifest: FlowManifest): Map<string, Set<string>> => {
  const incoming = new Map<string, Set<string>>();
  for (const [from, edge] of Object.entries(manifest.edges)) {
    if (edge.kind !== "static" || edge.to === END) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? new Set()).add(from));
  }
  return incoming;
};

/** Drives a claimed run until it completes, fails, pauses, or the signal aborts. */
export async function driveRun(deps: DriveDeps, runId: RunId): Promise<void> {
  const { pool, executor } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const run = await getRun(pool, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const flow = await getFlow(pool, run.flowId, run.flowVersion);
  if (!flow) throw new Error(`Flow ${run.flowId}@${run.flowVersion} not found`);
  const manifest = flow.graph;
  const joins = staticInEdges(manifest);

  let checkpoint = await latestCheckpoint(pool, runId);
  if (!checkpoint) {
    checkpoint = {
      runId,
      step: 0,
      state: initialState(manifest.channels, run.input),
      frontier: [manifest.entry],
      pendingJoins: {},
      createdAt: new Date(),
    };
    await withTransaction(pool, async (tx) => {
      await saveCheckpoint(tx, checkpoint!);
      await appendEvent(tx, { type: "run.started", runId, flowId: run.flowId, trigger: run.trigger });
    });
  }

  while (!deps.signal.aborted) {
    const current = await getRun(pool, runId);
    if (!current) return;
    if (current.cancelRequested) {
      await withTransaction(pool, async (tx) => {
        await updateRunStatus(tx, runId, "cancelled");
        await appendEvent(tx, { type: "run.cancelled", runId });
      });
      return;
    }
    if (checkpoint.frontier.length === 0) {
      await withTransaction(pool, async (tx) => {
        await updateRunStatus(tx, runId, "completed");
        await appendEvent(tx, { type: "run.completed", runId });
      });
      return;
    }

    await appendEvent(pool, {
      type: "step.started",
      runId,
      step: checkpoint.step,
      frontier: checkpoint.frontier,
    });
    const outcomes = await executeFrontier(deps, run, manifest, checkpoint, sleep);
    if (deps.signal.aborted) return;

    const errors = outcomes.filter((o) => o.kind === "error");
    if (errors.length) {
      const message = errors.map((e) => `${e.node}: ${e.message}`).join("; ");
      await withTransaction(pool, async (tx) => {
        await updateRunStatus(tx, runId, "failed", { error: message });
        await appendEvent(tx, { type: "run.failed", runId, error: message });
      });
      return;
    }

    const interrupts = outcomes.filter((o) => o.kind === "interrupt");
    if (interrupts.length) {
      await withTransaction(pool, async (tx) => {
        const status = interrupts.every((i) => i.eventTopic) ? "waiting_event" : "interrupted";
        await updateRunStatus(tx, runId, status);
        for (const i of interrupts) {
          const row = await createInterrupt(tx, {
            runId,
            step: checkpoint!.step,
            node: i.node,
            ordinal: i.ordinal,
            payload: i.payload,
            ...(i.responseSchema && { responseSchema: i.responseSchema }),
            ...(i.eventTopic && { eventTopic: i.eventTopic }),
          });
          await appendEvent(
            tx,
            i.eventTopic
              ? { type: "run.waiting_event", runId, step: checkpoint!.step, node: i.node, topic: i.eventTopic }
              : {
                  type: "run.interrupted",
                  runId,
                  step: checkpoint!.step,
                  node: i.node,
                  interruptId: row.id,
                  payload: i.payload,
                },
          );
        }
      });
      return;
    }

    const stepWrites: NodeWrites[] = outcomes.map((o) => ({
      node: o.node,
      writes: (o as NodeOutcome & { kind: "writes" }).writes,
    }));
    const nextState = applyWrites(manifest.channels, checkpoint.state, stepWrites);

    const pendingJoins: Record<string, string[]> = { ...checkpoint.pendingJoins };
    const nextFrontier = new Set<string>();
    for (const node of checkpoint.frontier) {
      const targets = await executor.evaluateRoute({
        runId,
        flowId: run.flowId,
        flowVersion: run.flowVersion,
        node,
        state: nextState,
      });
      for (const target of targets) {
        if (target === END) continue;
        const joinSources = joins.get(target);
        if (!joinSources || joinSources.size <= 1 || !joinSources.has(node)) {
          nextFrontier.add(target);
          continue;
        }
        const arrived = new Set([...(pendingJoins[target] ?? []), node]);
        if ([...joinSources].every((source) => arrived.has(source))) {
          nextFrontier.add(target);
          delete pendingJoins[target];
        } else {
          pendingJoins[target] = [...arrived].sort();
        }
      }
    }

    const next: CheckpointRow = {
      runId,
      step: checkpoint.step + 1,
      state: nextState,
      frontier: [...nextFrontier].sort(),
      pendingJoins,
      createdAt: new Date(),
    };
    await withTransaction(pool, async (tx) => {
      await saveCheckpoint(tx, next);
      await updateRunStatus(tx, runId, "running", { step: next.step });
      await appendEvent(tx, { type: "checkpoint.saved", runId, step: next.step });
    });
    checkpoint = next;
  }
}

async function executeFrontier(
  deps: DriveDeps,
  run: RunRow,
  manifest: FlowManifest,
  checkpoint: CheckpointRow,
  sleep: (ms: number) => Promise<void>,
): Promise<NodeOutcome[]> {
  const { pool } = deps;
  const alreadyDone = await succeededTasks(pool, run.id, checkpoint.step);
  const doneWrites = new Map(alreadyDone.map((t) => [t.node, t.writes ?? {}]));
  const toRun = checkpoint.frontier.filter((node) => !doneWrites.has(node));
  const fresh = await Promise.all(toRun.map((node) => runNodeWithRetry(deps, run, manifest, checkpoint, node, sleep)));
  return [
    ...[...doneWrites.entries()].map(([node, writes]): NodeOutcome => ({ node, kind: "writes", writes })),
    ...fresh,
  ];
}

async function runNodeWithRetry(
  deps: DriveDeps,
  run: RunRow,
  manifest: FlowManifest,
  checkpoint: CheckpointRow,
  node: string,
  sleep: (ms: number) => Promise<void>,
): Promise<NodeOutcome> {
  const { pool, executor } = deps;
  const retry = manifest.nodes.find((n) => n.name === node)?.retry ?? { maxAttempts: 1, baseDelayMs: 0 };
  const resume = (await resolvedForNode(pool, run.id, checkpoint.step, node)).map((i) => ({
    ordinal: i.ordinal,
    value: i.resumeValue as Json,
  }));
  const logBuffer: Array<LogLine & { step: number }> = [];
  const flushLogs = async () => {
    if (!logBuffer.length) return;
    await insertLogs(pool, run.id, logBuffer.splice(0));
  };

  for (let tryIndex = 1; tryIndex <= retry.maxAttempts; tryIndex++) {
    const attempt = (await latestAttempt(pool, run.id, checkpoint.step, node)) + 1;
    const id = deterministicTaskId(run.id, checkpoint.step, node, attempt);
    await recordTask(pool, { id, runId: run.id, step: checkpoint.step, node, attempt, status: "dispatched" });
    await appendEvent(pool, { type: "node.started", runId: run.id, step: checkpoint.step, node, attempt });
    const startedAt = Date.now();

    let result: NodeExecResult;
    try {
      result = await executor.execute(
        {
          taskId: id,
          runId: run.id,
          flowId: run.flowId,
          flowVersion: run.flowVersion,
          node,
          step: checkpoint.step,
          attempt,
          state: checkpoint.state,
          resume,
          timeoutMs: deps.nodeTimeoutMs ?? 600_000,
        },
        { onLog: (line) => logBuffer.push({ ...line, step: checkpoint.step, node }), signal: deps.signal },
      );
    } catch (error) {
      result = { kind: "error", message: error instanceof Error ? error.message : String(error), retryable: true };
    }
    await flushLogs();

    if (result.kind === "writes") {
      await recordTask(pool, {
        id,
        runId: run.id,
        step: checkpoint.step,
        node,
        attempt,
        status: "succeeded",
        writes: result.writes,
      });
      await appendEvent(pool, {
        type: "node.finished",
        runId: run.id,
        step: checkpoint.step,
        node,
        writes: result.writes,
        durationMs: Date.now() - startedAt,
      });
      return { node, kind: "writes", writes: result.writes };
    }
    if (result.kind === "interrupt") {
      await recordTask(pool, { id, runId: run.id, step: checkpoint.step, node, attempt, status: "interrupted" });
      return {
        node,
        kind: "interrupt",
        ordinal: result.ordinal,
        payload: result.payload,
        ...(result.responseSchema && { responseSchema: result.responseSchema }),
        ...(result.eventTopic && { eventTopic: result.eventTopic }),
      };
    }

    const willRetry = result.retryable && tryIndex < retry.maxAttempts && !deps.signal.aborted;
    await recordTask(pool, {
      id,
      runId: run.id,
      step: checkpoint.step,
      node,
      attempt,
      status: "failed",
      error: { message: result.message, ...(result.stack && { stack: result.stack }) },
    });
    await appendEvent(pool, {
      type: "node.failed",
      runId: run.id,
      step: checkpoint.step,
      node,
      error: result.message,
      willRetry,
    });
    if (!willRetry) return { node, kind: "error", message: result.message };
    await sleep(retry.baseDelayMs * 2 ** (tryIndex - 1));
  }
  return { node, kind: "error", message: "Retry attempts exhausted" };
}
