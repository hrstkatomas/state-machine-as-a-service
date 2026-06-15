#!/usr/bin/env node
import { Command } from "commander";
import { ApiClient } from "./client.js";
import { deploy } from "./deploy.js";

const program = new Command("flowctl")
  .description("Deploy and operate flows")
  .option("--api <url>", "API base URL", process.env.FLOW_API_URL ?? "http://localhost:4000")
  .option("--key <key>", "API key", process.env.FLOW_API_KEY);

const client = () => {
  const { api, key } = program.opts<{ api: string; key?: string }>();
  return new ApiClient({ api, ...(key && { key }) });
};

const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program
  .command("deploy <entry>")
  .description("Bundle a flow module, build its image, and register the deployment")
  .option("--dockerfile <path>", "custom Dockerfile for the flow's image (must extend platform/flow-runtime)")
  .action(async (entry: string, opts: { dockerfile?: string }) => deploy(entry, client(), opts));

program
  .command("run <flowId>")
  .description("Start a run")
  .option("--input <json>", "run input as JSON")
  .option("--version <n>", "flow version (default: latest)")
  .action(async (flowId: string, opts: { input?: string; version?: string }) => {
    printJson(
      await client().post("/v1/runs", {
        flowId,
        ...(opts.version && { flowVersion: Number(opts.version) }),
        ...(opts.input && { input: JSON.parse(opts.input) }),
      }),
    );
  });

program
  .command("runs")
  .description("List recent runs")
  .option("--flow <flowId>")
  .option("--status <status>")
  .action(async (opts: { flow?: string; status?: string }) => {
    const query = new URLSearchParams({
      ...(opts.flow && { flowId: opts.flow }),
      ...(opts.status && { status: opts.status }),
    });
    const runs = await client().get<{ id: string; flowId: string; status: string; currentStep: number; createdAt: string }[]>(
      `/v1/runs?${query}`,
    );
    for (const run of runs) {
      console.log(`${run.id}  ${run.status.padEnd(13)} step=${run.currentStep}  ${run.flowId}  ${run.createdAt}`);
    }
  });

program
  .command("status <runId>")
  .description("Show a run with its latest checkpoint and pending interrupts")
  .action(async (runId: string) => printJson(await client().get(`/v1/runs/${runId}`)));

program
  .command("logs <runId>")
  .description("Print run logs")
  .action(async (runId: string) => {
    const logs = await client().get<{ node: string; stream: string; line: string }[]>(`/v1/runs/${runId}/logs`);
    for (const log of logs) console.log(`[${log.node}/${log.stream}] ${log.line}`);
  });

program
  .command("respond <runId> <interruptId> <json>")
  .description("Answer a pending interrupt and resume the run")
  .action(async (runId: string, interruptId: string, json: string) =>
    printJson(await client().post(`/v1/runs/${runId}/interrupts/${interruptId}/respond`, { value: JSON.parse(json) })),
  );

program
  .command("event <topic> [json]")
  .description("Publish an external event")
  .action(async (topic: string, json?: string) =>
    printJson(await client().post(`/v1/events/${topic}`, json ? JSON.parse(json) : {})),
  );

program
  .command("flows")
  .description("List deployed flows")
  .action(async () => {
    const flows = await client().get<{ id: string; version: number; imageRef: string | null }[]>("/v1/flows");
    for (const flow of flows) console.log(`${flow.id}  v${flow.version}  ${flow.imageRef ?? "-"}`);
  });

await program.parseAsync();
