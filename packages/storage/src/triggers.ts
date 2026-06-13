import type { Json, TriggerDef } from "@flow/contracts";
import type { Queryable } from "./db.js";

export interface TriggerRow {
  id: string;
  flowId: string;
  flowVersion: number;
  kind: "cron" | "event";
  schedule: string | null;
  timezone: string | null;
  topic: string | null;
  input: Json | null;
  enabled: boolean;
  nextFireAt: Date | null;
}

const rowToTrigger = (r: Record<string, unknown>): TriggerRow => ({
  id: r.id as string,
  flowId: r.flow_id as string,
  flowVersion: r.flow_version as number,
  kind: r.kind as "cron" | "event",
  schedule: r.schedule as string | null,
  timezone: r.timezone as string | null,
  topic: r.topic as string | null,
  input: r.input as Json | null,
  enabled: r.enabled as boolean,
  nextFireAt: r.next_fire_at as Date | null,
});

/** Replaces a flow's triggers on deploy. nextFire computes the first cron firing. */
export async function syncTriggers(
  q: Queryable,
  flowId: string,
  flowVersion: number,
  defs: TriggerDef[],
  nextFire: (schedule: string, timezone?: string) => Date,
): Promise<void> {
  await q.query("delete from triggers where flow_id = $1", [flowId]);
  for (const def of defs) {
    if (def.kind === "manual") continue;
    await q.query(
      `insert into triggers (flow_id, flow_version, kind, schedule, timezone, topic, input, next_fire_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        flowId,
        flowVersion,
        def.kind,
        def.kind === "cron" ? def.schedule : null,
        def.kind === "cron" ? (def.timezone ?? null) : null,
        def.kind === "event" ? def.topic : null,
        def.kind === "cron" ? JSON.stringify(def.input ?? null) : null,
        def.kind === "cron" ? nextFire(def.schedule, def.timezone) : null,
      ],
    );
  }
}

/** Due cron triggers, locked so concurrent API instances fire each exactly once. */
export async function lockDueCronTriggers(q: Queryable): Promise<TriggerRow[]> {
  const { rows } = await q.query(
    `select * from triggers
     where kind = 'cron' and enabled and next_fire_at <= now()
     for update skip locked`,
  );
  return rows.map(rowToTrigger);
}

export async function setNextFire(q: Queryable, triggerId: string, at: Date): Promise<void> {
  await q.query("update triggers set next_fire_at = $2 where id = $1", [triggerId, at]);
}

export async function eventTriggersForTopic(q: Queryable, topic: string): Promise<TriggerRow[]> {
  const { rows } = await q.query(
    "select * from triggers where kind = 'event' and enabled and topic = $1",
    [topic],
  );
  return rows.map(rowToTrigger);
}

export async function listTriggers(q: Queryable): Promise<TriggerRow[]> {
  const { rows } = await q.query("select * from triggers order by flow_id");
  return rows.map(rowToTrigger);
}

export async function setTriggerEnabled(q: Queryable, id: string, enabled: boolean): Promise<void> {
  await q.query("update triggers set enabled = $2 where id = $1", [id, enabled]);
}

export async function storeExternalEvent(q: Queryable, topic: string, payload: Json, matched: boolean): Promise<void> {
  await q.query("insert into external_events (topic, payload, matched) values ($1, $2, $3)", [
    topic,
    JSON.stringify(payload),
    matched,
  ]);
}

export interface ExternalEventRow {
  id: string;
  topic: string;
  payload: Json;
  matched: boolean;
  receivedAt: Date;
}

export async function listExternalEvents(q: Queryable, limit = 100): Promise<ExternalEventRow[]> {
  const { rows } = await q.query("select * from external_events order by received_at desc limit $1", [limit]);
  return rows.map((r) => ({
    id: r.id as string,
    topic: r.topic as string,
    payload: r.payload as Json,
    matched: r.matched as boolean,
    receivedAt: r.received_at as Date,
  }));
}

export async function purgeExpiredEvents(q: Queryable, ttlHours = 24): Promise<void> {
  await q.query("delete from external_events where received_at < now() - make_interval(hours => $1)", [ttlHours]);
}
