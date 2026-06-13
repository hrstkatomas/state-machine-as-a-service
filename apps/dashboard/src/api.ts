import type { EngineEvent, FlowManifest, Json, JsonObject, RunStatus, TriggerDef } from "@flow/contracts";

export interface Run {
  id: string;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  input: Json | null;
  trigger: TriggerDef;
  currentStep: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface Checkpoint {
  runId: string;
  step: number;
  state: JsonObject;
  frontier: string[];
  pendingJoins: Record<string, string[]>;
  createdAt: string;
}

export interface Interrupt {
  id: string;
  runId: string;
  step: number;
  node: string;
  ordinal: number;
  payload: Json;
  responseSchema: JsonObject | null;
  eventTopic: string | null;
  resumeValue: Json | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface RunDetail {
  run: Run;
  checkpoint: Checkpoint | null;
  pendingInterrupts: Interrupt[];
}

export interface Flow {
  id: string;
  version: number;
  graph: FlowManifest;
  triggers: TriggerDef[];
  imageRef: string | null;
  createdAt: string;
}

export interface Trigger {
  id: string;
  flowId: string;
  flowVersion: number;
  kind: "cron" | "event";
  schedule: string | null;
  timezone: string | null;
  topic: string | null;
  enabled: boolean;
  nextFireAt: string | null;
}

export interface RunLog {
  seq: string;
  node: string;
  stream: "stdout" | "stderr";
  line: string;
  at: string;
}

export type { EngineEvent, RunStatus };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export const api = {
  runs: (filter: { flowId?: string; status?: string } = {}) =>
    request<Run[]>("GET", `/v1/runs?${new URLSearchParams(filter)}`),
  run: (id: string) => request<RunDetail>("GET", `/v1/runs/${id}`),
  checkpoints: (runId: string) => request<Checkpoint[]>("GET", `/v1/runs/${runId}/checkpoints`),
  logs: (runId: string, since?: string) =>
    request<RunLog[]>("GET", `/v1/runs/${runId}/logs${since ? `?since=${since}` : ""}`),
  interrupts: (runId: string) => request<Interrupt[]>("GET", `/v1/runs/${runId}/interrupts`),
  respond: (runId: string, interruptId: string, value: unknown) =>
    request("POST", `/v1/runs/${runId}/interrupts/${interruptId}/respond`, { value }),
  cancel: (runId: string) => request("POST", `/v1/runs/${runId}/cancel`),
  replay: (runId: string, fromStep?: number) =>
    request<{ runId: string }>("POST", `/v1/runs/${runId}/replay`, fromStep === undefined ? {} : { fromStep }),
  startRun: (flowId: string, input?: unknown) =>
    request<{ runId: string }>("POST", "/v1/runs", { flowId, ...(input !== undefined && { input }) }),
  flows: () => request<Flow[]>("GET", "/v1/flows"),
  flow: (id: string) => request<Flow>("GET", `/v1/flows/${id}`),
  triggers: () => request<Trigger[]>("GET", "/v1/triggers"),
  setTriggerEnabled: (id: string, enabled: boolean) =>
    request("PATCH", `/v1/triggers/${id}`, { enabled }),
};
