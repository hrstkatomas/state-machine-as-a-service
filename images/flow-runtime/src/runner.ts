import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  RUNNER_PORT,
  type LogLine,
  type NodeExecRequest,
  type RouteEvalRequest,
} from "@flow/contracts";
import { evaluateRoute, executeNode, resolveFlow, type AnyFlow } from "@flow/sdk";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/workspace";
const BUNDLE_PATH = process.env.FLOWS_BUNDLE ?? "/app/flows/index.mjs";

/** Structured log to stdout — the worker tails container logs and parses NDJSON. */
const emitLog = (line: LogLine) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function loadFlows(): Promise<Map<string, AnyFlow>> {
  const mod = (await import(BUNDLE_PATH)) as { flows?: unknown[]; default?: unknown };
  const exported = mod.flows ?? [mod.default];
  const flows = exported.map(resolveFlow);
  return new Map(flows.map((f) => [f.id, f]));
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const reply = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

const flows = await loadFlows();
const flowOrNull = (flowId: string) => flows.get(flowId) ?? null;

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") return reply(res, 200, { ok: true, flows: [...flows.keys()] });
    if (req.method === "POST" && req.url === "/execute") {
      const { request } = JSON.parse(await readBody(req)) as { request: NodeExecRequest };
      const flow = flowOrNull(request.flowId);
      if (!flow) return reply(res, 404, { error: `Unknown flow "${request.flowId}"` });
      const result = await executeNode(flow, request, {
        workspaceDir: WORKSPACE_DIR,
        onLog: emitLog,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      return reply(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/route") {
      const { request } = JSON.parse(await readBody(req)) as { request: RouteEvalRequest };
      const flow = flowOrNull(request.flowId);
      if (!flow) return reply(res, 404, { error: `Unknown flow "${request.flowId}"` });
      return reply(res, 200, { targets: evaluateRoute(flow, request) });
    }
    reply(res, 404, { error: "Not found" });
  } catch (error) {
    reply(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(RUNNER_PORT, () => {
  emitLog({ level: "info", message: `Runner listening on :${RUNNER_PORT}`, at: new Date().toISOString() });
});
