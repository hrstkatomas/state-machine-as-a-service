import { z } from "zod";
import type { ChannelSpec, Json, ReducerKind } from "@flow/contracts";

export interface Channel<T> {
  schema: z.ZodType<T>;
  default: () => T;
  /** Built-in reducer for merging concurrent writes from parallel branches. */
  reducer?: ReducerKind;
}

export type ChannelMap = Record<string, Channel<unknown>>;

export type StateOf<C extends ChannelMap> = {
  [K in keyof C]: C[K] extends Channel<infer T> ? T : never;
};

export const channel = <T>(definition: Channel<T>): Channel<T> => definition;

export const appendChannel = <T>(itemSchema: z.ZodType<T>): Channel<T[]> => ({
  schema: z.array(itemSchema),
  default: () => [],
  reducer: "append",
});

export const channelSpec = (c: Channel<unknown>): ChannelSpec => ({
  schema: z.toJSONSchema(c.schema, { unrepresentable: "any" }) as ChannelSpec["schema"],
  reducer: c.reducer ?? null,
  defaultValue: c.default() as Json,
});
