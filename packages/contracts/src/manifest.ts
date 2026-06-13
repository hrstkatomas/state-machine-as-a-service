import type { Json, JsonObject } from "./json.js";

export type TriggerDef =
  | { kind: "cron"; schedule: string; timezone?: string; input?: Json }
  | { kind: "event"; topic: string }
  | { kind: "manual" };

export type EdgeSpec =
  | { kind: "static"; to: string }
  | { kind: "conditional"; targets: readonly string[] }
  | { kind: "fanOut"; targets: readonly string[] };

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface NodeSpec {
  name: string;
  retry: RetryPolicy;
}

/**
 * Reducers merge concurrent writes from parallel branches. They are named built-ins
 * (not user functions) so the host-side engine can apply them without loading user code.
 * A channel without a reducer accepts at most one write per step — more is an error.
 */
export type ReducerKind = "append" | "merge" | "sum" | "max" | "min";

export interface ChannelSpec {
  /** JSON Schema of the channel value, for dashboard display and input forms. */
  schema: JsonObject;
  reducer: ReducerKind | null;
  defaultValue: Json;
}

/** Serializable flow topology — everything the platform needs without loading user code. */
export interface FlowManifest {
  id: string;
  entry: string;
  nodes: NodeSpec[];
  edges: Record<string, EdgeSpec>;
  channels: Record<string, ChannelSpec>;
  triggers: TriggerDef[];
}

export const END = "__end__" as const;
export type EndNode = typeof END;
