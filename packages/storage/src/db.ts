import pg from "pg";

export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export const createPool = (connectionString = process.env.DATABASE_URL ?? "postgres://flow:flow@localhost:5432/flow") =>
  new pg.Pool({ connectionString });

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
