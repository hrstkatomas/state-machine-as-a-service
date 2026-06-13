import type { JsonObject, RunId } from "@flow/contracts";
import type { Queryable } from "./db.js";

export interface CheckpointRow {
  runId: RunId;
  step: number;
  state: JsonObject;
  frontier: string[];
  /** Per join-node: source branches that already arrived, e.g. {"review": ["lint"]}. */
  pendingJoins: Record<string, string[]>;
  createdAt: Date;
}

const rowToCheckpoint = (r: Record<string, unknown>): CheckpointRow => ({
  runId: r.run_id as RunId,
  step: r.step as number,
  state: r.state as JsonObject,
  frontier: r.frontier as string[],
  pendingJoins: r.pending_joins as Record<string, string[]>,
  createdAt: r.created_at as Date,
});

export async function saveCheckpoint(
  q: Queryable,
  checkpoint: Pick<CheckpointRow, "runId" | "step" | "state" | "frontier" | "pendingJoins">,
): Promise<void> {
  await q.query(
    `insert into checkpoints (run_id, step, state, frontier, pending_joins)
     values ($1, $2, $3, $4, $5)
     on conflict (run_id, step) do update set state = $3, frontier = $4, pending_joins = $5`,
    [
      checkpoint.runId,
      checkpoint.step,
      JSON.stringify(checkpoint.state),
      JSON.stringify(checkpoint.frontier),
      JSON.stringify(checkpoint.pendingJoins),
    ],
  );
}

export async function latestCheckpoint(q: Queryable, runId: string): Promise<CheckpointRow | null> {
  const { rows } = await q.query(
    "select * from checkpoints where run_id = $1 order by step desc limit 1",
    [runId],
  );
  return rows[0] ? rowToCheckpoint(rows[0]) : null;
}

export async function getCheckpoint(q: Queryable, runId: string, step: number): Promise<CheckpointRow | null> {
  const { rows } = await q.query("select * from checkpoints where run_id = $1 and step = $2", [runId, step]);
  return rows[0] ? rowToCheckpoint(rows[0]) : null;
}

export async function listCheckpoints(q: Queryable, runId: string): Promise<CheckpointRow[]> {
  const { rows } = await q.query("select * from checkpoints where run_id = $1 order by step", [runId]);
  return rows.map(rowToCheckpoint);
}
