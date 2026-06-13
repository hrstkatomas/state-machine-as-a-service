import type { Json, JsonObject } from "./json.js";
import type { RunId } from "./ids.js";
import type { TriggerDef } from "./manifest.js";

export type RunStatus =
  | "queued"
  | "running"
  | "interrupted"
  | "waiting_event"
  | "completed"
  | "failed"
  | "cancelled";

export type EngineEvent =
  | { type: "run.started"; runId: RunId; flowId: string; trigger: TriggerDef }
  | { type: "step.started"; runId: RunId; step: number; frontier: string[] }
  | { type: "node.started"; runId: RunId; step: number; node: string; attempt: number }
  | { type: "node.finished"; runId: RunId; step: number; node: string; writes: JsonObject; durationMs: number }
  | { type: "node.failed"; runId: RunId; step: number; node: string; error: string; willRetry: boolean }
  | { type: "checkpoint.saved"; runId: RunId; step: number }
  | { type: "run.interrupted"; runId: RunId; step: number; node: string; interruptId: string; payload: Json }
  | { type: "run.waiting_event"; runId: RunId; step: number; node: string; topic: string }
  | { type: "run.resumed"; runId: RunId; interruptId: string }
  | { type: "run.completed"; runId: RunId }
  | { type: "run.failed"; runId: RunId; error: string }
  | { type: "run.cancelled"; runId: RunId };
