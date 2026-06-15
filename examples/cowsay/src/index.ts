import { z } from "zod";
import { channel, defineFlow, END } from "@flow/sdk";

const channels = {
  art: channel({ schema: z.string(), default: () => "" }),
};

/**
 * Runs `fortune | cowsay | lolcat` in a per-flow execution environment.
 * The tools don't exist in the base runtime — the Dockerfile next to this file
 * installs them, and `flowctl deploy --dockerfile ./examples/cowsay/Dockerfile`
 * builds that image for this flow only.
 */
const flow = defineFlow("cowsay-fortune", channels)
  .addNode("speak", async (_state, ctx) => {
    const { exitCode, stdout, stderr } = await ctx.exec("fortune | cowsay | lolcat -f");
    if (exitCode !== 0) throw new Error(`cowsay pipeline failed: ${stderr.slice(-500)}`);
    ctx.logger.info(stdout);
    return { art: stdout };
  })
  .addEdge("speak", { kind: "static", to: END })
  .setEntry("speak");

export default flow;
