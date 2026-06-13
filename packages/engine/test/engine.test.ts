import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { z } from "zod";
import { appendChannel, channel, defineFlow, END, type AnyFlow } from "@flow/sdk";
import {
  claimRun,
  createPool,
  createRun,
  getRun,
  insertFlowVersion,
  latestCheckpoint,
  listEvents,
  listInterrupts,
  migrate,
  requestCancel,
  requeueRun,
  resolveInterrupt,
  type RunRow,
} from "@flow/storage";
import { driveRun, InProcessExecutor } from "../src/index.js";

let pool: pg.Pool;
const workspaceRoot = mkdtempSync(join(tmpdir(), "flow-test-"));
const noSleep = () => Promise.resolve();

const drive = (flows: AnyFlow[], run: RunRow, signal = new AbortController().signal) =>
  driveRun({ pool, executor: new InProcessExecutor(flows, workspaceRoot), signal, sleep: noSleep }, run.id);

async function startRun(flow: AnyFlow, input: Record<string, unknown> = {}) {
  const inserted = await insertFlowVersion(pool, { manifest: flow.toManifest() });
  const run = await createRun(pool, {
    flowId: inserted.id,
    flowVersion: inserted.version,
    input: input as RunRow["input"],
    trigger: { kind: "manual" },
  });
  await claimRun(pool, "test-worker", "test-host");
  return run;
}

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL ?? "postgres://flow:flow@localhost:5432/flow_test_engine");
  await pool.query("drop schema public cascade; create schema public");
  await migrate(pool);
});

afterAll(() => pool.end());

describe("engine", () => {
  it("runs a linear flow to completion with checkpoints", async () => {
    const flow = defineFlow("linear", {
      value: channel({ schema: z.number(), default: () => 0 }),
    })
      .addNode("double", async (s) => ({ value: s.value * 2 }))
      .addNode("increment", async (s) => ({ value: s.value + 1 }))
      .setEntry("double")
      .addEdge("double", { kind: "static", to: "increment" })
      .addEdge("increment", { kind: "static", to: END })
      .build();

    const run = await startRun(flow, { value: 5 });
    await drive([flow], run);

    expect((await getRun(pool, run.id))?.status).toBe("completed");
    const final = await latestCheckpoint(pool, run.id);
    expect(final?.state.value).toBe(11);
    expect(final?.frontier).toEqual([]);
    const types = (await listEvents(pool, run.id)).map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
  });

  it("fans out in parallel, merges via reducer, and joins on all branches", async () => {
    const order: string[] = [];
    const flow = defineFlow("parallel", {
      results: appendChannel(z.string()),
      joined: channel({ schema: z.boolean(), default: () => false }),
    })
      .addNode("split", async () => ({}))
      .addNode("slow", async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("slow");
        return { results: ["slow"] };
      })
      .addNode("fast", async () => {
        order.push("fast");
        return { results: ["fast"] };
      })
      .addNode("join", async (s) => {
        expect(s.results.toSorted()).toEqual(["fast", "slow"]);
        return { joined: true };
      })
      .setEntry("split")
      .addEdge("split", { kind: "fanOut", targets: ["slow", "fast"], route: () => ["slow", "fast"] })
      .addEdge("slow", { kind: "static", to: "join" })
      .addEdge("fast", { kind: "static", to: "join" })
      .addEdge("join", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);

    expect(order).toEqual(["fast", "slow"]);
    expect((await getRun(pool, run.id))?.status).toBe("completed");
    const final = await latestCheckpoint(pool, run.id);
    expect(final?.state.joined).toBe(true);
    expect((final?.state.results as string[]).toSorted()).toEqual(["fast", "slow"]);
  });

  it("pauses on interrupt and resumes with the human response", async () => {
    let executionsBeforeInterrupt = 0;
    const flow = defineFlow("hitl", {
      decision: channel({ schema: z.string(), default: () => "pending" }),
    })
      .addNode("review", async (_s, ctx) => {
        executionsBeforeInterrupt++;
        const verdict = await ctx.interrupt<{ approved: boolean }>({ ask: "Approve?" });
        return { decision: verdict.approved ? "approved" : "rejected" };
      })
      .setEntry("review")
      .addEdge("review", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);

    expect((await getRun(pool, run.id))?.status).toBe("interrupted");
    const [pending] = await listInterrupts(pool, run.id, { pendingOnly: true });
    expect(pending?.payload).toEqual({ ask: "Approve?" });

    await resolveInterrupt(pool, pending!.id, { approved: true });
    await requeueRun(pool, run.id);
    await claimRun(pool, "test-worker", "test-host");
    await drive([flow], run);

    expect((await getRun(pool, run.id))?.status).toBe("completed");
    expect((await latestCheckpoint(pool, run.id))?.state.decision).toBe("approved");
    expect(executionsBeforeInterrupt).toBe(2);
  });

  it("skips already-succeeded nodes when resuming a partially-finished step", async () => {
    const executions: Record<string, number> = { stable: 0, flaky: 0 };
    let failOnce = true;
    const flow = defineFlow("partial", {
      results: appendChannel(z.string()),
    })
      .addNode("split", async () => ({}))
      .addNode("stable", async () => {
        executions.stable++;
        return { results: ["stable"] };
      })
      .addNode(
        "flaky",
        async () => {
          executions.flaky++;
          if (failOnce) {
            failOnce = false;
            throw new Error("transient outage");
          }
          return { results: ["flaky"] };
        },
        { retry: { maxAttempts: 1 } },
      )
      .setEntry("split")
      .addEdge("split", { kind: "fanOut", targets: ["stable", "flaky"], route: () => ["stable", "flaky"] })
      .addEdge("stable", { kind: "static", to: END })
      .addEdge("flaky", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);
    expect((await getRun(pool, run.id))?.status).toBe("failed");
    expect(executions).toEqual({ stable: 1, flaky: 1 });

    await requeueRun(pool, run.id);
    await claimRun(pool, "test-worker", "test-host");
    await drive([flow], run);

    expect((await getRun(pool, run.id))?.status).toBe("completed");
    expect(executions).toEqual({ stable: 1, flaky: 2 });
  });

  it("retries failing nodes with backoff up to maxAttempts", async () => {
    let attempts = 0;
    const flow = defineFlow("retry", {
      done: channel({ schema: z.boolean(), default: () => false }),
    })
      .addNode(
        "unstable",
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("boom");
          return { done: true };
        },
        { retry: { maxAttempts: 3, baseDelayMs: 1 } },
      )
      .setEntry("unstable")
      .addEdge("unstable", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);

    expect(attempts).toBe(3);
    expect((await getRun(pool, run.id))?.status).toBe("completed");
  });

  it("routes conditionally based on merged state", async () => {
    const flow = defineFlow("conditional", {
      amount: channel({ schema: z.number(), default: () => 0 }),
      path: channel({ schema: z.string(), default: () => "" }),
    })
      .addNode("check", async () => ({}))
      .addNode("small", async () => ({ path: "small" }))
      .addNode("large", async () => ({ path: "large" }))
      .setEntry("check")
      .addEdge("check", {
        kind: "conditional",
        targets: ["small", "large"],
        route: (s) => (s.amount > 100 ? "large" : "small"),
      })
      .addEdge("small", { kind: "static", to: END })
      .addEdge("large", { kind: "static", to: END })
      .build();

    const run = await startRun(flow, { amount: 500 });
    await drive([flow], run);
    expect((await latestCheckpoint(pool, run.id))?.state.path).toBe("large");
  });

  it("honours cancellation between steps", async () => {
    const flow = defineFlow("cancellable", {
      count: channel({ schema: z.number(), default: () => 0 }),
    })
      .addNode("first", async (s, ctx) => {
        await requestCancel(pool, ctx.runId);
        return { count: s.count + 1 };
      })
      .addNode("second", async (s) => ({ count: s.count + 1 }))
      .setEntry("first")
      .addEdge("first", { kind: "static", to: "second" })
      .addEdge("second", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);
    expect((await getRun(pool, run.id))?.status).toBe("cancelled");
  });

  it("waits for external events and resumes with the payload", async () => {
    const flow = defineFlow("event-wait", {
      received: channel({ schema: z.string(), default: () => "" }),
    })
      .addNode("wait", async (_s, ctx) => {
        const payload = await ctx.waitForEvent<{ message: string }>("deploy.finished");
        return { received: payload.message };
      })
      .setEntry("wait")
      .addEdge("wait", { kind: "static", to: END })
      .build();

    const run = await startRun(flow);
    await drive([flow], run);

    expect((await getRun(pool, run.id))?.status).toBe("waiting_event");
    const [pending] = await listInterrupts(pool, run.id, { pendingOnly: true });
    expect(pending?.eventTopic).toBe("deploy.finished");

    await resolveInterrupt(pool, pending!.id, { message: "v42 live" });
    await requeueRun(pool, run.id);
    await claimRun(pool, "test-worker", "test-host");
    await drive([flow], run);

    expect((await latestCheckpoint(pool, run.id))?.state.received).toBe("v42 live");
  });
});
