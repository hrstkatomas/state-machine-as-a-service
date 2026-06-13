import type { ChannelSpec, Json, JsonObject, ReducerKind } from "@flow/contracts";

const reducers: Record<ReducerKind, (current: Json, update: Json) => Json> = {
  append: (current, update) => [...(current as Json[]), ...(update as Json[])],
  merge: (current, update) => ({ ...(current as JsonObject), ...(update as JsonObject) }),
  sum: (current, update) => (current as number) + (update as number),
  max: (current, update) => Math.max(current as number, update as number),
  min: (current, update) => Math.min(current as number, update as number),
};

export interface NodeWrites {
  node: string;
  writes: JsonObject;
}

/**
 * Merges one step's writes into state, node-by-node in name order so conflicts are
 * deterministic. A channel without a reducer tolerates exactly one writer per step.
 */
export function applyWrites(
  channels: Record<string, ChannelSpec>,
  state: JsonObject,
  stepWrites: NodeWrites[],
): JsonObject {
  const next = { ...state };
  const writersPerChannel = new Map<string, string>();
  for (const { node, writes } of [...stepWrites].sort((a, b) => a.node.localeCompare(b.node))) {
    for (const [key, value] of Object.entries(writes)) {
      const spec = channels[key];
      if (!spec) throw new Error(`Node "${node}" wrote unknown channel "${key}"`);
      const previousWriter = writersPerChannel.get(key);
      if (previousWriter !== undefined && !spec.reducer) {
        throw new Error(
          `Channel "${key}" written by both "${previousWriter}" and "${node}" in one step but has no reducer`,
        );
      }
      next[key] = spec.reducer
        ? reducers[spec.reducer]((next[key] ?? spec.defaultValue) as Json, value)
        : value;
      writersPerChannel.set(key, node);
    }
  }
  return next;
}

export function initialState(channels: Record<string, ChannelSpec>, input: Json | null): JsonObject {
  const state = Object.fromEntries(Object.entries(channels).map(([key, c]) => [key, c.defaultValue]));
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (key in state && value !== undefined) state[key] = value;
    }
  }
  return state;
}
