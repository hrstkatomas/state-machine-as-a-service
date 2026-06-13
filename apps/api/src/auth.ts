import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { isValidApiKey, upsertApiKey } from "@flow/storage";

/**
 * Bearer API-key auth. Open when FLOW_API_KEY is unset (local dev);
 * when set, the key is seeded into api_keys and every /v1 request must carry one.
 */
export async function registerAuth(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  const adminKey = process.env.FLOW_API_KEY;
  if (!adminKey) return;
  await upsertApiKey(pool, "admin", adminKey);
  const validated = new Set<string>();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1")) return;
    const key = request.headers.authorization?.replace(/^Bearer /, "");
    if (!key) return reply.code(401).send({ error: "Missing Authorization: Bearer <api-key>" });
    const hash = createHash("sha256").update(key).digest("hex");
    if (validated.has(hash)) return;
    if (!(await isValidApiKey(pool, key))) return reply.code(401).send({ error: "Invalid API key" });
    validated.add(hash);
  });
}
