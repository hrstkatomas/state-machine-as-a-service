import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Json, RunId, RunStatus } from "@flow/contracts";
import {
  appendEvent,
  createRun,
  getCheckpoint,
  getFlow,
  getInterrupt,
  getRun,
  latestCheckpoint,
  listCheckpoints,
  listExternalEvents,
  listFlows,
  listInterrupts,
  listLogs,
  listRuns,
  listTriggers,
  notifyRunWakeup,
  requestCancel,
  requeueRun,
  resolveInterrupt,
  saveCheckpoint,
  setTriggerEnabled,
  withTransaction,
  insertFlowVersion,
  syncTriggers,
} from "@flow/storage";
import { dispatchEvent } from "./events.js";
import { nextFire } from "./cron.js";
import type { EventHub } from "./sse.js";

const startRunBody = z.object({
  flowId: z.string(),
  flowVersion: z.number().int().optional(),
  input: z.unknown().optional(),
});

const respondBody = z.object({ value: z.unknown() });
const replayBody = z.object({ fromStep: z.number().int().min(0).optional() });
const patchTriggerBody = z.object({ enabled: z.boolean() });
const deployBody = z.object({
  manifest: z.object({
    id: z.string(),
    entry: z.string(),
    nodes: z.array(z.object({ name: z.string(), retry: z.object({ maxAttempts: z.number(), baseDelayMs: z.number() }) })),
    edges: z.record(z.string(), z.unknown()),
    channels: z.record(z.string(), z.unknown()),
    triggers: z.array(z.unknown()),
  }),
  imageRef: z.string().optional(),
});

export interface RoutesDeps {
  pool: pg.Pool;
  hub: EventHub;
}

export function registerRoutes(app: FastifyInstance, { pool, hub }: RoutesDeps): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/runs", async (request, reply) => {
    const body = startRunBody.parse(request.body);
    const flow = await getFlow(pool, body.flowId, body.flowVersion);
    if (!flow) return reply.code(404).send({ error: `Flow "${body.flowId}" not found` });
    const run = await createRun(pool, {
      flowId: flow.id,
      flowVersion: flow.version,
      input: (body.input ?? null) as Json,
      trigger: { kind: "manual" },
    });
    await notifyRunWakeup(pool);
    return reply.code(201).send({ runId: run.id });
  });

  app.get("/v1/runs", async (request) => {
    const query = request.query as { flowId?: string; status?: RunStatus; limit?: string };
    return listRuns(pool, {
      ...(query.flowId && { flowId: query.flowId }),
      ...(query.status && { status: query.status }),
      limit: query.limit ? Number(query.limit) : 50,
    });
  });

  app.get("/v1/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await getRun(pool, id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const [checkpoint, interrupts] = await Promise.all([
      latestCheckpoint(pool, id),
      listInterrupts(pool, id, { pendingOnly: true }),
    ]);
    return { run, checkpoint, pendingInterrupts: interrupts };
  });

  app.get("/v1/runs/:id/checkpoints", async (request) => {
    const { id } = request.params as { id: string };
    return listCheckpoints(pool, id);
  });

  app.get("/v1/runs/:id/checkpoints/:step", async (request, reply) => {
    const { id, step } = request.params as { id: string; step: string };
    const checkpoint = await getCheckpoint(pool, id, Number(step));
    return checkpoint ?? reply.code(404).send({ error: "Checkpoint not found" });
  });

  app.get("/v1/runs/:id/logs", async (request) => {
    const { id } = request.params as { id: string };
    const { since } = request.query as { since?: string };
    return listLogs(pool, id, BigInt(since ?? 0));
  });

  app.get("/v1/runs/:id/interrupts", async (request) => {
    const { id } = request.params as { id: string };
    return listInterrupts(pool, id);
  });

  app.post("/v1/runs/:id/interrupts/:interruptId/respond", async (request, reply) => {
    const { id, interruptId } = request.params as { id: string; interruptId: string };
    const { value } = respondBody.parse(request.body);
    const interrupt = await getInterrupt(pool, interruptId);
    if (!interrupt || interrupt.runId !== id) return reply.code(404).send({ error: "Interrupt not found" });
    const resolved = await withTransaction(pool, async (tx) => {
      if (!(await resolveInterrupt(tx, interruptId, value as Json))) return false;
      await requeueRun(tx, interrupt.runId);
      await appendEvent(tx, { type: "run.resumed", runId: interrupt.runId, interruptId });
      await notifyRunWakeup(tx);
      return true;
    });
    if (!resolved) return reply.code(409).send({ error: "Interrupt already resolved" });
    return { resumed: true };
  });

  app.post("/v1/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await getRun(pool, id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    await requestCancel(pool, run.id);
    if (["interrupted", "waiting_event", "failed"].includes(run.status)) {
      await withTransaction(pool, async (tx) => {
        await requeueRun(tx, run.id);
        await notifyRunWakeup(tx);
      });
    }
    return { cancelRequested: true };
  });

  app.post("/v1/runs/:id/replay", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { fromStep } = replayBody.parse(request.body ?? {});
    const source = await getRun(pool, id);
    if (!source) return reply.code(404).send({ error: "Run not found" });
    const forked = await withTransaction(pool, async (tx) => {
      const run = await createRun(tx, {
        flowId: source.flowId,
        flowVersion: source.flowVersion,
        input: source.input,
        trigger: { kind: "manual" },
      });
      if (fromStep !== undefined) {
        const checkpoint = await getCheckpoint(tx, id, fromStep);
        if (!checkpoint) throw Object.assign(new Error("Checkpoint not found"), { statusCode: 404 });
        await saveCheckpoint(tx, { ...checkpoint, runId: run.id as RunId });
      }
      await notifyRunWakeup(tx);
      return run;
    });
    return reply.code(201).send({ runId: forked.id });
  });

  app.get("/v1/runs/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const lastSeq =
      (request.headers["last-event-id"] as string | undefined) ??
      (request.query as { since?: string }).since ??
      "0";
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    reply.raw.write(":connected\n\n");
    const unsubscribe = await hub.subscribe(id, lastSeq, (seq, data) => {
      reply.raw.write(`id: ${seq}\ndata: ${data}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(":ping\n\n"), 25_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    await new Promise(() => undefined); // held open until the client disconnects
  });

  app.get("/v1/flows", async () => listFlows(pool));

  app.get("/v1/flows/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { version } = request.query as { version?: string };
    const flow = await getFlow(pool, id, version ? Number(version) : undefined);
    return flow ?? reply.code(404).send({ error: "Flow not found" });
  });

  app.get("/v1/triggers", async () => listTriggers(pool));

  app.patch("/v1/triggers/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { enabled } = patchTriggerBody.parse(request.body);
    await setTriggerEnabled(pool, id, enabled);
    return { enabled };
  });

  app.get("/v1/events", async () => listExternalEvents(pool));

  app.post("/v1/events/:topic", async (request, reply) => {
    const { topic } = request.params as { topic: string };
    const result = await dispatchEvent(pool, topic, (request.body ?? null) as Json);
    return reply.code(202).send(result);
  });

  app.post("/v1/deployments", async (request, reply) => {
    const body = deployBody.parse(request.body);
    const manifest = body.manifest as unknown as Parameters<typeof insertFlowVersion>[1]["manifest"];
    const flow = await withTransaction(pool, async (tx) => {
      const inserted = await insertFlowVersion(tx, {
        manifest,
        ...(body.imageRef && { imageRef: body.imageRef }),
      });
      await syncTriggers(tx, inserted.id, inserted.version, manifest.triggers, nextFire);
      return inserted;
    });
    return reply.code(201).send({ flowId: flow.id, version: flow.version });
  });
}
