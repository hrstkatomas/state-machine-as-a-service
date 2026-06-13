import { z } from "zod";
import { appendChannel, channel, defineFlow, END } from "@flow/sdk";

const channels = {
  repoUrl: channel({ schema: z.string(), default: () => "" }),
  setupCommand: channel({ schema: z.string(), default: () => "true" }),
  testCommand: channel({ schema: z.string(), default: () => "npm test" }),
  testExitCode: channel({ schema: z.number(), default: () => -1 }),
  testOutput: channel({ schema: z.string(), default: () => "" }),
  decision: channel({ schema: z.enum(["retry", "giveUp", "none"]), default: () => "none" as const }),
  history: appendChannel(z.string()),
};

const decisionSchema = z.object({
  action: z.enum(["fix", "retry", "giveUp"]),
  command: z.string().optional().describe("Shell command to run before retesting (action=fix)"),
});

/**
 * Clones a repository, runs its tests, and on failure pauses for a human:
 * the response can apply a fix command and loop back to the tests.
 */
const flow = defineFlow("repo-ci", channels)
  .addNode("clone", async (state, ctx) => {
    const { exitCode, stderr } = await ctx.exec(`git clone --depth 1 ${state.repoUrl} repo`);
    if (exitCode !== 0) throw new Error(`git clone failed: ${stderr.slice(-500)}`);
    return { history: [`cloned ${state.repoUrl}`] };
  })
  .addNode("install", async (state, ctx) => {
    const { exitCode, stderr } = await ctx.exec(state.setupCommand, { cwd: "repo", timeoutMs: 300_000 });
    if (exitCode !== 0) throw new Error(`setup failed: ${stderr.slice(-500)}`);
    return { history: [`setup: ${state.setupCommand}`] };
  })
  .addNode("test", async (state, ctx) => {
    const { exitCode, stdout, stderr } = await ctx.exec(state.testCommand, { cwd: "repo", timeoutMs: 300_000 });
    ctx.logger.info(`tests exited with ${exitCode}`);
    return {
      testExitCode: exitCode,
      testOutput: (stdout + stderr).slice(-4000),
      history: [`test run: exit ${exitCode}`],
    };
  })
  .addNode("askHuman", async (state, ctx) => {
    const response = await ctx.interrupt<z.infer<typeof decisionSchema>>(
      { question: "Tests failed — how should I proceed?", testOutput: state.testOutput },
      { responseSchema: decisionSchema },
    );
    if (response.action === "giveUp") return { decision: "giveUp", history: ["human: give up"] };
    if (response.action === "fix" && response.command) {
      const { exitCode } = await ctx.exec(response.command, { cwd: "repo" });
      return { decision: "retry", history: [`human fix (exit ${exitCode}): ${response.command}`] };
    }
    return { decision: "retry", history: ["human: retry"] };
  })
  .addNode("report", async (state, ctx) => {
    const verdict = state.testExitCode === 0 ? "PASSED" : "FAILED (gave up)";
    ctx.logger.info(`CI ${verdict} after ${state.history.length} steps`);
    return { history: [`report: ${verdict}`] };
  })
  .addEdge("clone", { kind: "static", to: "install" })
  .addEdge("install", { kind: "static", to: "test" })
  .addEdge("test", {
    kind: "conditional",
    targets: ["report", "askHuman"],
    route: (state) => (state.testExitCode === 0 ? "report" : "askHuman"),
  })
  .addEdge("askHuman", {
    kind: "conditional",
    targets: ["test", "report"],
    route: (state) => (state.decision === "giveUp" ? "report" : "test"),
  })
  .addEdge("report", { kind: "static", to: END })
  .setEntry("clone");

export default flow;
