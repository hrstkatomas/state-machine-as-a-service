import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { createPool } from "@flow/storage";
import { registerAuth } from "./auth.js";
import { startCronLoop } from "./cron.js";
import { registerRoutes } from "./routes.js";
import { EventHub } from "./sse.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://flow:flow@localhost:5432/flow";
const port = Number(process.env.PORT ?? 4000);

const pool = createPool(databaseUrl);
const hub = new EventHub(pool, databaseUrl);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: "Invalid request body", issues: error.issues });
  app.log.error(error);
  return reply.code(error.statusCode ?? 500).send({ error: error.message });
});

await app.register(cors, { origin: true });
await registerAuth(app, pool);
registerRoutes(app, { pool, hub });
await hub.start();
const stopCron = startCronLoop(pool);

await app.listen({ port, host: "0.0.0.0" });
app.log.info(`flow api listening on :${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stopCron();
    await hub.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
