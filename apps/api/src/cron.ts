import { CronExpressionParser } from "cron-parser";
import type pg from "pg";
import {
  createRun,
  lockDueCronTriggers,
  notifyRunWakeup,
  purgeExpiredEvents,
  setNextFire,
  withTransaction,
} from "@flow/storage";

export const nextFire = (schedule: string, timezone?: string): Date =>
  CronExpressionParser.parse(schedule, timezone ? { tz: timezone } : {}).next().toDate();

/** Fires due cron triggers exactly once across instances (row locks + same-tx run insert). */
export async function fireDueCronTriggers(pool: pg.Pool): Promise<string[]> {
  return withTransaction(pool, async (tx) => {
    const started: string[] = [];
    for (const trigger of await lockDueCronTriggers(tx)) {
      const run = await createRun(tx, {
        flowId: trigger.flowId,
        flowVersion: trigger.flowVersion,
        input: trigger.input,
        trigger: { kind: "cron", schedule: trigger.schedule ?? "", ...(trigger.timezone && { timezone: trigger.timezone }) },
      });
      await setNextFire(tx, trigger.id, nextFire(trigger.schedule ?? "", trigger.timezone ?? undefined));
      started.push(run.id);
    }
    if (started.length) await notifyRunWakeup(tx);
    return started;
  });
}

export function startCronLoop(pool: pg.Pool, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    void fireDueCronTriggers(pool).catch((error) => console.error("cron loop:", error));
    void purgeExpiredEvents(pool).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}
