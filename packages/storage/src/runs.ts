import type { Json, JsonObject, RunId, RunStatus, TriggerDef } from "@flow/contracts";
import type { Queryable } from "./db.js";

export interface RunRow {
  id: RunId;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  input: Json | null;
  trigger: TriggerDef;
  currentStep: number;
  error: string | null;
  cancelRequested: boolean;
  lockedBy: string | null;
  workspaceVolume: string | null;
  workspaceHost: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

const rowToRun = (r: Record<string, unknown>): RunRow => ({
  id: r.id as RunId,
  flowId: r.flow_id as string,
  flowVersion: r.flow_version as number,
  status: r.status as RunStatus,
  input: r.input as Json | null,
  trigger: r.trigger as TriggerDef,
  currentStep: r.current_step as number,
  error: r.error as string | null,
  cancelRequested: r.cancel_requested as boolean,
  lockedBy: r.locked_by as string | null,
  workspaceVolume: r.workspace_volume as string | null,
  workspaceHost: r.workspace_host as string | null,
  createdAt: r.created_at as Date,
  finishedAt: r.finished_at as Date | null,
});

export async function createRun(
  q: Queryable,
  params: { flowId: string; flowVersion: number; input: Json | null; trigger: TriggerDef },
): Promise<RunRow> {
  const { rows } = await q.query(
    `insert into runs (flow_id, flow_version, input, trigger) values ($1, $2, $3, $4) returning *`,
    [params.flowId, params.flowVersion, JSON.stringify(params.input), JSON.stringify(params.trigger)],
  );
  return rowToRun(rows[0]);
}

export async function getRun(q: Queryable, id: string): Promise<RunRow | null> {
  const { rows } = await q.query("select * from runs where id = $1", [id]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function listRuns(
  q: Queryable,
  filter: { flowId?: string; status?: RunStatus; limit?: number; before?: Date },
): Promise<RunRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.flowId) conditions.push(`flow_id = $${values.push(filter.flowId)}`);
  if (filter.status) conditions.push(`status = $${values.push(filter.status)}`);
  if (filter.before) conditions.push(`created_at < $${values.push(filter.before)}`);
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await q.query(
    `select * from runs ${where} order by created_at desc limit $${values.push(filter.limit ?? 50)}`,
    values,
  );
  return rows.map(rowToRun);
}

const LEASE_SECONDS = 60;

/** Claims one runnable run: queued, or running with an expired lease (crashed worker). */
export async function claimRun(q: Queryable, workerId: string, host: string): Promise<RunRow | null> {
  const { rows } = await q.query(
    `update runs set status = 'running', locked_by = $1, lease_until = now() + make_interval(secs => $3)
     where id = (
       select id from runs
       where (status = 'queued' or (status = 'running' and lease_until < now()))
         and (workspace_host is null or workspace_host = $2)
       order by created_at
       for update skip locked
       limit 1)
     returning *`,
    [workerId, host, LEASE_SECONDS],
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

/** Extends the lease; returns false if the run was taken over (lease lost). */
export async function heartbeat(q: Queryable, runId: RunId, workerId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `update runs set lease_until = now() + make_interval(secs => $3)
     where id = $1 and locked_by = $2 and status = 'running'`,
    [runId, workerId, LEASE_SECONDS],
  );
  return rowCount === 1;
}

export async function updateRunStatus(
  q: Queryable,
  runId: RunId,
  status: RunStatus,
  opts: { error?: string; step?: number } = {},
): Promise<void> {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  await q.query(
    `update runs set status = $2::run_status, error = coalesce($3, error),
       current_step = coalesce($4, current_step),
       locked_by = case when $2::text = 'running' then locked_by else null end,
       lease_until = case when $2::text = 'running' then lease_until else null end,
       finished_at = case when $5 then now() else finished_at end
     where id = $1`,
    [runId, status, opts.error ?? null, opts.step ?? null, terminal],
  );
}

export async function requestCancel(q: Queryable, runId: RunId): Promise<void> {
  await q.query("update runs set cancel_requested = true where id = $1", [runId]);
}

export async function setWorkspace(q: Queryable, runId: RunId, volume: string, host: string | null): Promise<void> {
  await q.query("update runs set workspace_volume = $2, workspace_host = $3 where id = $1", [runId, volume, host]);
}

/** Re-queues a paused run so a worker picks it up (after interrupt resolution or event match). */
export async function requeueRun(q: Queryable, runId: RunId): Promise<void> {
  await q.query(
    `update runs set status = 'queued', locked_by = null, lease_until = null
     where id = $1 and status in ('interrupted', 'waiting_event', 'failed')`,
    [runId],
  );
}
