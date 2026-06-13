import type { FlowDefinition } from "./flow.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased state type at the loading boundary
export type AnyFlow = FlowDefinition<any>;

/**
 * Accepts a module's default export — either a built FlowDefinition or a FlowBuilder.
 * Duck-typed (not instanceof) because the runner and the user bundle each carry their own
 * compiled copy of the SDK classes.
 */
export function resolveFlow(exported: unknown): AnyFlow {
  if (!exported || typeof exported !== "object") {
    throw new Error("Flow module must default-export defineFlow(...) or its .build() result");
  }
  if ("toManifest" in exported) return exported as AnyFlow;
  if ("build" in exported && typeof exported.build === "function") return exported.build() as AnyFlow;
  throw new Error("Flow module must default-export defineFlow(...) or its .build() result");
}
