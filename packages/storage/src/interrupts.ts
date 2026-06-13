import type { InterruptId, Json, JsonObject, RunId } from "@flow/contracts";
import type { Queryable } from "./db.js";

export interface InterruptRow {
  id: InterruptId;
  runId: RunId;
  step: number;
  node: string;
  ordinal: number;
  payload: Json;
  responseSchema: JsonObject | null;
  eventTopic: string | null;
  resumeValue: Json | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

const rowToInterrupt = (r: Record<string, unknown>): InterruptRow => ({
  id: r.id as InterruptId,
  runId: r.run_id as RunId,
  step: r.step as number,
  node: r.node as string,
  ordinal: r.ordinal as number,
  payload: r.payload as Json,
  responseSchema: r.response_schema as JsonObject | null,
  eventTopic: r.event_topic as string | null,
  resumeValue: r.resume_value as Json | null,
  resolvedAt: r.resolved_at as Date | null,
  createdAt: r.created_at as Date,
});

export async function createInterrupt(
  q: Queryable,
  params: {
    runId: RunId;
    step: number;
    node: string;
    ordinal: number;
    payload: Json;
    responseSchema?: JsonObject;
    eventTopic?: string;
  },
): Promise<InterruptRow> {
  const { rows } = await q.query(
    `insert into interrupts (run_id, step, node, ordinal, payload, response_schema, event_topic)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (run_id, step, node, ordinal) do update set payload = $5
     returning *`,
    [
      params.runId,
      params.step,
      params.node,
      params.ordinal,
      JSON.stringify(params.payload),
      params.responseSchema ? JSON.stringify(params.responseSchema) : null,
      params.eventTopic ?? null,
    ],
  );
  return rowToInterrupt(rows[0]);
}

export async function listInterrupts(
  q: Queryable,
  runId: string,
  filter: { pendingOnly?: boolean } = {},
): Promise<InterruptRow[]> {
  const { rows } = await q.query(
    `select * from interrupts where run_id = $1 ${filter.pendingOnly ? "and resolved_at is null" : ""} order by created_at`,
    [runId],
  );
  return rows.map(rowToInterrupt);
}

export async function getInterrupt(q: Queryable, id: string): Promise<InterruptRow | null> {
  const { rows } = await q.query("select * from interrupts where id = $1", [id]);
  return rows[0] ? rowToInterrupt(rows[0]) : null;
}

/** Returns false if the interrupt was already resolved (idempotent guard). */
export async function resolveInterrupt(q: Queryable, id: string, resumeValue: Json): Promise<boolean> {
  const { rowCount } = await q.query(
    "update interrupts set resume_value = $2, resolved_at = now() where id = $1 and resolved_at is null",
    [id, JSON.stringify(resumeValue)],
  );
  return rowCount === 1;
}

/** Resolved interrupts for a node at a step — injected as resume values on re-execution. */
export async function resolvedForNode(
  q: Queryable,
  runId: string,
  step: number,
  node: string,
): Promise<InterruptRow[]> {
  const { rows } = await q.query(
    `select * from interrupts
     where run_id = $1 and step = $2 and node = $3 and resolved_at is not null
     order by ordinal`,
    [runId, step, node],
  );
  return rows.map(rowToInterrupt);
}

/** Oldest pending event-wait on a topic, locked for the matching transaction. */
export async function lockPendingByTopic(q: Queryable, topic: string): Promise<InterruptRow[]> {
  const { rows } = await q.query(
    `select * from interrupts
     where event_topic = $1 and resolved_at is null
     order by created_at
     for update skip locked`,
    [topic],
  );
  return rows.map(rowToInterrupt);
}
