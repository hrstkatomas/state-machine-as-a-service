import type { EngineEvent, LogLine, RunId } from "@flow/contracts";
import type { Queryable } from "./db.js";

export const RUN_EVENTS_CHANNEL = "run_events";
export const RUN_WAKEUP_CHANNEL = "run_wakeup";

export interface RunEventRow {
  seq: string;
  runId: RunId;
  type: EngineEvent["type"];
  data: EngineEvent;
  at: Date;
}

/** Appends in the caller's transaction and notifies live listeners on commit. */
export async function appendEvent(q: Queryable, event: EngineEvent): Promise<void> {
  await q.query(
    `with inserted as (
       insert into run_events (run_id, type, data) values ($1, $2, $3) returning seq, run_id
     )
     select pg_notify($4, json_build_object('seq', seq, 'runId', run_id)::text) from inserted`,
    [event.runId, event.type, JSON.stringify(event), RUN_EVENTS_CHANNEL],
  );
}

export async function notifyRunWakeup(q: Queryable): Promise<void> {
  await q.query("select pg_notify($1, '')", [RUN_WAKEUP_CHANNEL]);
}

export async function listEvents(q: Queryable, runId: string, afterSeq = 0n): Promise<RunEventRow[]> {
  const { rows } = await q.query(
    "select * from run_events where run_id = $1 and seq > $2 order by seq",
    [runId, afterSeq.toString()],
  );
  return rows.map((r) => ({
    seq: String(r.seq),
    runId: r.run_id as RunId,
    type: r.type as EngineEvent["type"],
    data: r.data as EngineEvent,
    at: r.at as Date,
  }));
}

export async function insertLogs(
  q: Queryable,
  runId: RunId,
  lines: Array<LogLine & { step?: number }>,
): Promise<void> {
  if (!lines.length) return;
  await q.query(
    `insert into run_logs (run_id, step, node, level, message, at)
     select $1, l.step, l.node, l.level, l.message, l.at
     from jsonb_to_recordset($2) as l(step int, node text, level text, message text, at timestamptz)`,
    [runId, JSON.stringify(lines.map((l) => ({ ...l, message: l.message })))],
  );
}

export interface RunLogRow {
  seq: string;
  step: number | null;
  node: string | null;
  level: string;
  message: string;
  at: Date;
}

export async function listLogs(q: Queryable, runId: string, afterSeq = 0n): Promise<RunLogRow[]> {
  const { rows } = await q.query(
    "select * from run_logs where run_id = $1 and seq > $2 order by seq limit 1000",
    [runId, afterSeq.toString()],
  );
  return rows.map((r) => ({
    seq: String(r.seq),
    step: r.step as number | null,
    node: r.node as string | null,
    level: r.level as string,
    message: r.message as string,
    at: r.at as Date,
  }));
}
