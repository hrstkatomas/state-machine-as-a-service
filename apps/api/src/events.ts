import type pg from "pg";
import type { Json } from "@flow/contracts";
import {
  appendEvent,
  createRun,
  eventTriggersForTopic,
  lockPendingByTopic,
  notifyRunWakeup,
  requeueRun,
  resolveInterrupt,
  storeExternalEvent,
  withTransaction,
} from "@flow/storage";

export interface DispatchResult {
  resumedRuns: string[];
  startedRuns: string[];
}

/**
 * Event dispatch order: ① resume runs waiting on the topic, ② start runs for flows
 * with an event trigger, ③ store the event either way (24h TTL, dashboard-inspectable).
 */
export async function dispatchEvent(pool: pg.Pool, topic: string, payload: Json): Promise<DispatchResult> {
  return withTransaction(pool, async (tx) => {
    const resumedRuns: string[] = [];
    for (const waiting of await lockPendingByTopic(tx, topic)) {
      await resolveInterrupt(tx, waiting.id, payload);
      await requeueRun(tx, waiting.runId);
      await appendEvent(tx, { type: "run.resumed", runId: waiting.runId, interruptId: waiting.id });
      resumedRuns.push(waiting.runId);
    }
    const startedRuns: string[] = [];
    for (const trigger of await eventTriggersForTopic(tx, topic)) {
      const run = await createRun(tx, {
        flowId: trigger.flowId,
        flowVersion: trigger.flowVersion,
        input: payload,
        trigger: { kind: "event", topic },
      });
      startedRuns.push(run.id);
    }
    await storeExternalEvent(tx, topic, payload, resumedRuns.length + startedRuns.length > 0);
    if (resumedRuns.length || startedRuns.length) await notifyRunWakeup(tx);
    return { resumedRuns, startedRuns };
  });
}
