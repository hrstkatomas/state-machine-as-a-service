import { createHash } from "node:crypto";
import type { JsonObject, RunId, TaskId } from "@flow/contracts";
import { taskId } from "@flow/contracts";
import type { Queryable } from "./db.js";

export type TaskStatus = "dispatched" | "succeeded" | "failed" | "interrupted";

export interface TaskRow {
  id: TaskId;
  runId: RunId;
  step: number;
  node: string;
  attempt: number;
  status: TaskStatus;
  writes: JsonObject | null;
  error: JsonObject | null;
}

export const deterministicTaskId = (runId: RunId, step: number, node: string, attempt: number): TaskId =>
  taskId(createHash("sha256").update(`${runId}:${step}:${node}:${attempt}`).digest("hex").slice(0, 32));

const rowToTask = (r: Record<string, unknown>): TaskRow => ({
  id: r.id as TaskId,
  runId: r.run_id as RunId,
  step: r.step as number,
  node: r.node as string,
  attempt: r.attempt as number,
  status: r.status as TaskStatus,
  writes: r.writes as JsonObject | null,
  error: r.error as JsonObject | null,
});

export async function recordTask(
  q: Queryable,
  task: Pick<TaskRow, "id" | "runId" | "step" | "node" | "attempt" | "status"> & {
    writes?: JsonObject;
    error?: JsonObject;
  },
): Promise<void> {
  await q.query(
    `insert into tasks (id, run_id, step, node, attempt, status, writes, error, finished_at)
     values ($1, $2, $3, $4, $5, $6::task_status, $7, $8, case when $6::text = 'dispatched' then null else now() end)
     on conflict (id) do update set status = $6::task_status, writes = $7, error = $8,
       finished_at = case when $6::text = 'dispatched' then null else now() end`,
    [
      task.id,
      task.runId,
      task.step,
      task.node,
      task.attempt,
      task.status,
      task.writes ? JSON.stringify(task.writes) : null,
      task.error ? JSON.stringify(task.error) : null,
    ],
  );
}

/** Succeeded tasks of a step — used on resume to skip re-executing finished nodes. */
export async function succeededTasks(q: Queryable, runId: string, step: number): Promise<TaskRow[]> {
  const { rows } = await q.query(
    "select * from tasks where run_id = $1 and step = $2 and status = 'succeeded'",
    [runId, step],
  );
  return rows.map(rowToTask);
}

export async function latestAttempt(q: Queryable, runId: string, step: number, node: string): Promise<number> {
  const { rows } = await q.query(
    "select coalesce(max(attempt), 0) as attempt from tasks where run_id = $1 and step = $2 and node = $3",
    [runId, step, node],
  );
  return rows[0].attempt as number;
}
