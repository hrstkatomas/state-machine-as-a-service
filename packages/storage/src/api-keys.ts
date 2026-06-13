import { createHash } from "node:crypto";
import type { Queryable } from "./db.js";

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function upsertApiKey(q: Queryable, name: string, key: string): Promise<void> {
  await q.query(
    "insert into api_keys (name, key_hash) values ($1, $2) on conflict (key_hash) do nothing",
    [name, hashKey(key)],
  );
}

export async function isValidApiKey(q: Queryable, key: string): Promise<boolean> {
  const { rowCount } = await q.query("select 1 from api_keys where key_hash = $1", [hashKey(key)]);
  return rowCount === 1;
}
