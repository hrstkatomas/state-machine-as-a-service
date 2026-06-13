import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runId as asRunId, type FlowManifest } from "@flow/contracts";
import {
  claimRun,
  createPool,
  createRun,
  createInterrupt,
  deterministicTaskId,
  getRun,
  heartbeat,
  insertFlowVersion,
  latestCheckpoint,
  listInterrupts,
  migrate,
  recordTask,
  requeueRun,
  resolveInterrupt,
  resolvedForNode,
  saveCheckpoint,
  succeededTasks,
  updateRunStatus,
  withTransaction,
} from "../src/index.js";

const manifest: FlowManifest = {
  id: "test-flow",
  entry: "start",
  nodes: [{ name: "start", retry: { maxAttempts: 3, baseDelayMs: 100 } }],
  edges: { start: { kind: "static", to: "__end__" } },
  channels: { value: { schema: { type: "number" }, hasReducer: false } },
  triggers: [{ kind: "manual" }],
};

let pool: pg.Pool;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL ?? "postgres://flow:flow@localhost:5432/flow_test_storage");
  await pool.query("drop schema public cascade; create schema public");
  await migrate(pool);
});

afterAll(() => pool.end());

describe("storage", () => {
  it("round-trips a flow, run, checkpoint, and tasks", async () => {
    const flow = await insertFlowVersion(pool, { manifest });
    expect(flow.version).toBe(1);

    const run = await createRun(pool, {
      flowId: flow.id,
      flowVersion: flow.version,
      input: { value: 1 },
      trigger: { kind: "manual" },
    });
    expect(run.status).toBe("queued");

    const claimed = await claimRun(pool, "worker-1", "host-a");
    expect(claimed?.id).toBe(run.id);
    expect(await claimRun(pool, "worker-2", "host-a")).toBeNull();
    expect(await heartbeat(pool, run.id, "worker-1")).toBe(true);
    expect(await heartbeat(pool, run.id, "worker-2")).toBe(false);

    await withTransaction(pool, async (tx) => {
      await saveCheckpoint(tx, {
        runId: run.id,
        step: 0,
        state: { value: 1 },
        frontier: ["start"],
        pendingJoins: {},
      });
      await recordTask(tx, {
        id: deterministicTaskId(run.id, 0, "start", 1),
        runId: run.id,
        step: 0,
        node: "start",
        attempt: 1,
        status: "succeeded",
        writes: { value: 2 },
      });
    });

    const checkpoint = await latestCheckpoint(pool, run.id);
    expect(checkpoint?.state).toEqual({ value: 1 });
    expect(checkpoint?.frontier).toEqual(["start"]);

    const done = await succeededTasks(pool, run.id, 0);
    expect(done).toHaveLength(1);
    expect(done[0]?.writes).toEqual({ value: 2 });
  });

  it("claims runs with expired leases (crashed worker takeover)", async () => {
    const run = await createRun(pool, {
      flowId: "test-flow",
      flowVersion: 1,
      input: null,
      trigger: { kind: "manual" },
    });
    await claimRun(pool, "worker-1", "host-a");
    await pool.query("update runs set lease_until = now() - interval '1 second' where id = $1", [run.id]);
    const reclaimed = await claimRun(pool, "worker-2", "host-a");
    expect(reclaimed?.id).toBe(run.id);
    expect(reclaimed?.lockedBy).toBe("worker-2");
  });

  it("respects workspace host affinity when claiming", async () => {
    const run = await createRun(pool, {
      flowId: "test-flow",
      flowVersion: 1,
      input: null,
      trigger: { kind: "manual" },
    });
    await pool.query("update runs set workspace_host = 'host-a', workspace_volume = 'ws-x' where id = $1", [run.id]);
    expect(await claimRun(pool, "worker-b", "host-b")).toBeNull();
    expect((await claimRun(pool, "worker-a", "host-a"))?.id).toBe(run.id);
    await updateRunStatus(pool, run.id, "completed");
  });

  it("creates, resolves, and replays interrupts", async () => {
    const run = await createRun(pool, {
      flowId: "test-flow",
      flowVersion: 1,
      input: null,
      trigger: { kind: "manual" },
    });
    const interrupt = await createInterrupt(pool, {
      runId: run.id,
      step: 2,
      node: "review",
      ordinal: 0,
      payload: { ask: "Approve?" },
    });
    await updateRunStatus(pool, run.id, "interrupted");

    const pending = await listInterrupts(pool, run.id, { pendingOnly: true });
    expect(pending).toHaveLength(1);

    expect(await resolveInterrupt(pool, interrupt.id, { approved: true })).toBe(true);
    expect(await resolveInterrupt(pool, interrupt.id, { approved: false })).toBe(false);

    await requeueRun(pool, asRunId(run.id));
    expect((await getRun(pool, run.id))?.status).toBe("queued");

    const resolved = await resolvedForNode(pool, run.id, 2, "review");
    expect(resolved[0]?.resumeValue).toEqual({ approved: true });
  });

  it("task recording is idempotent by deterministic id", async () => {
    const run = await createRun(pool, {
      flowId: "test-flow",
      flowVersion: 1,
      input: null,
      trigger: { kind: "manual" },
    });
    const id = deterministicTaskId(run.id, 1, "node-a", 1);
    await recordTask(pool, { id, runId: run.id, step: 1, node: "node-a", attempt: 1, status: "dispatched" });
    await recordTask(pool, {
      id,
      runId: run.id,
      step: 1,
      node: "node-a",
      attempt: 1,
      status: "succeeded",
      writes: { done: true },
    });
    const done = await succeededTasks(pool, run.id, 1);
    expect(done).toHaveLength(1);
  });
});
