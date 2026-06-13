import { z } from "zod";
import { channel, defineFlow, END } from "@flow/sdk";

/** Waits for an external event on a run-specific topic, then records its payload. */
const approval = defineFlow("approval-gate", {
  approvalKey: channel({ schema: z.string(), default: () => "default" }),
  received: channel({ schema: z.string(), default: () => "" }),
})
  .addNode("await", async (state, ctx) => {
    const payload = await ctx.waitForEvent(`approval:${state.approvalKey}`);
    ctx.logger.info(`approval arrived for ${state.approvalKey}`);
    return { received: JSON.stringify(payload) };
  })
  .addEdge("await", { kind: "static", to: END })
  .setEntry("await");

/** Fires every minute via cron; completes immediately. */
const tick = defineFlow("tick", {
  firedAt: channel({ schema: z.string(), default: () => "" }),
})
  .addNode("tick", async (_state, ctx) => {
    ctx.logger.info("tick");
    return { firedAt: new Date().toISOString() };
  })
  .addEdge("tick", { kind: "static", to: END })
  .setEntry("tick")
  .addTrigger({ kind: "cron", schedule: "* * * * *" });

export const flows = [approval, tick];
