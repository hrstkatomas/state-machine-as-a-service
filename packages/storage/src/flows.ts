import type { FlowManifest, TriggerDef } from "@flow/contracts";
import type { Queryable } from "./db.js";

export interface FlowRow {
  id: string;
  version: number;
  graph: FlowManifest;
  triggers: TriggerDef[];
  imageRef: string | null;
  createdAt: Date;
}

const rowToFlow = (r: Record<string, unknown>): FlowRow => ({
  id: r.id as string,
  version: r.version as number,
  graph: r.graph as FlowManifest,
  triggers: r.triggers as TriggerDef[],
  imageRef: r.image_ref as string | null,
  createdAt: r.created_at as Date,
});

export async function insertFlowVersion(
  q: Queryable,
  params: { manifest: FlowManifest; imageRef?: string },
): Promise<FlowRow> {
  const { rows } = await q.query(
    `insert into flows (id, version, graph, triggers, image_ref)
     values ($1, coalesce((select max(version) from flows where id = $1), 0) + 1, $2, $3, $4)
     returning *`,
    [
      params.manifest.id,
      JSON.stringify(params.manifest),
      JSON.stringify(params.manifest.triggers),
      params.imageRef ?? null,
    ],
  );
  return rowToFlow(rows[0]);
}

export async function getFlow(q: Queryable, id: string, version?: number): Promise<FlowRow | null> {
  const { rows } = await q.query(
    version === undefined
      ? "select * from flows where id = $1 order by version desc limit 1"
      : "select * from flows where id = $1 and version = $2",
    version === undefined ? [id] : [id, version],
  );
  return rows[0] ? rowToFlow(rows[0]) : null;
}

export async function listFlows(q: Queryable): Promise<FlowRow[]> {
  const { rows } = await q.query(
    `select distinct on (id) * from flows order by id, version desc`,
  );
  return rows.map(rowToFlow);
}
