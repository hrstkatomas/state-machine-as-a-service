import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runId, taskId, type NodeExecRequest } from "@flow/contracts";
import { appendChannel, channel, defineFlow, END, executeNode, evaluateRoute } from "../src/index.js";

const buildFlow = () =>
  defineFlow("review", {
    amount: channel({ schema: z.number(), default: () => 0 }),
    checks: appendChannel(z.object({ name: z.string(), ok: z.boolean() })),
    decision: channel({ schema: z.enum(["pending", "approved", "rejected"]), default: () => "pending" as const }),
  })
    .addNode("intake", async () => ({}))
    .addNode("fraud", async (s) => ({ checks: [{ name: "fraud", ok: s.amount < 50_000 }] }))
    .addNode("credit", async () => ({ checks: [{ name: "credit", ok: true }] }))
    .addNode("human", async (s, ctx) => {
      const verdict = await ctx.interrupt<{ approved: boolean }>(
        { ask: "Approve?" },
        { responseSchema: z.object({ approved: z.boolean() }) },
      );
      return { decision: verdict.approved ? ("approved" as const) : ("rejected" as const) };
    })
    .setEntry("intake")
    .addEdge("intake", { kind: "fanOut", targets: ["fraud", "credit"], route: () => ["fraud", "credit"] })
    .addEdge("fraud", { kind: "static", to: "human" })
    .addEdge("credit", { kind: "static", to: "human" })
    .addEdge("human", { kind: "static", to: END })
    .addTrigger({ kind: "cron", schedule: "0 9 * * 1-5" })
    .build();

const request = (node: string, state: Record<string, unknown>, resume: NodeExecRequest["resume"] = []) => ({
  taskId: taskId("t1"),
  runId: runId("r1"),
  flowId: "review",
  flowVersion: 1,
  node,
  step: 0,
  attempt: 1,
  state: state as NodeExecRequest["state"],
  resume,
  timeoutMs: 5000,
});

const options = { workspaceDir: "/tmp", onLog: () => undefined, signal: new AbortController().signal };

describe("sdk", () => {
  it("produces a serializable manifest", () => {
    const manifest = buildFlow().toManifest();
    expect(manifest.entry).toBe("intake");
    expect(manifest.nodes.map((n) => n.name)).toEqual(["intake", "fraud", "credit", "human"]);
    expect(manifest.edges.intake).toEqual({ kind: "fanOut", targets: ["fraud", "credit"] });
    expect(manifest.channels.checks?.reducer).toBe("append");
    expect(manifest.channels.amount?.defaultValue).toBe(0);
    expect(manifest.triggers).toEqual([{ kind: "cron", schedule: "0 9 * * 1-5" }]);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("executes a node and validates writes", async () => {
    const result = await executeNode(buildFlow(), request("fraud", { amount: 100_000 }), options);
    expect(result).toEqual({ kind: "writes", writes: { checks: [{ name: "fraud", ok: false }] } });
  });

  it("surfaces interrupts with response schema and replays resume values", async () => {
    const flow = buildFlow();
    const first = await executeNode(flow, request("human", { amount: 1 }), options);
    expect(first.kind).toBe("interrupt");
    if (first.kind !== "interrupt") throw new Error("unreachable");
    expect(first.ordinal).toBe(0);
    expect(first.responseSchema).toMatchObject({ type: "object" });

    const resumed = await executeNode(
      flow,
      request("human", { amount: 1 }, [{ ordinal: 0, value: { approved: true } }]),
      options,
    );
    expect(resumed).toEqual({ kind: "writes", writes: { decision: "approved" } });
  });

  it("evaluates fan-out and static routes", () => {
    const flow = buildFlow();
    const base = { runId: runId("r1"), flowId: "review", flowVersion: 1, state: {} };
    expect(evaluateRoute(flow, { ...base, node: "intake" })).toEqual(["fraud", "credit"]);
    expect(evaluateRoute(flow, { ...base, node: "human" })).toEqual([END]);
  });

  it("rejects invalid writes as non-retryable", async () => {
    const flow = defineFlow("bad", { value: channel({ schema: z.number(), default: () => 0 }) })
      .addNode("oops", async () => ({ value: "not a number" as unknown as number }))
      .setEntry("oops")
      .addEdge("oops", { kind: "static", to: END })
      .build();
    const result = await executeNode(flow, request("oops", {}), options);
    expect(result).toMatchObject({ kind: "error", retryable: false });
  });

  it("validates graph shape at build time", () => {
    expect(() =>
      defineFlow("broken", { value: channel({ schema: z.number(), default: () => 0 }) })
        .addNode("a", async () => ({}))
        .setEntry("a")
        .build(),
    ).toThrow(/no outgoing edge/);
  });
});
