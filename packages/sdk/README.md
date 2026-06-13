# @flow/sdk

The authoring surface. This is the **only** package user flow code imports: `defineFlow`,
`channel` / `appendChannel`, the `NodeCtx` passed to every node, and `END`. It also exports
the two pure execution functions — `executeNode` and `evaluateRoute` — that actually run a
node or evaluate an edge given a state object. Depends only on `@flow/contracts` and `zod`.

The SDK owns the boundary between *live* flow code (zod schemas, node closures, route
functions) and the *serialized* `FlowManifest` (`@flow/contracts`) that the rest of the
platform stores and reasons about. `defineFlow(...).build()` crosses that boundary; the
runner crosses back when it loads a bundle and calls `resolveFlow`.

## What it provides

| source | exports | role |
|---|---|---|
| [`src/flow.ts`](src/flow.ts) | `defineFlow` · `FlowBuilder` · `FlowDefinition` · `NodeHandler` · `Edge` · `END` | the builder; node names accumulate as a string-literal union so edge targets are compile-time checked |
| [`src/channels.ts`](src/channels.ts) | `channel` · `appendChannel` · `Channel` · `ChannelMap` · `StateOf` | typed state keys: zod schema + default + optional reducer |
| [`src/context.ts`](src/context.ts) | `NodeCtx` · `NodeLogger` · `GraphInterrupt` · `InterruptOpts` · `ExecOpts` · `ExecResult` | what a node receives: `interrupt`, `waitForEvent`, `exec`, `logger`, `signal` |
| [`src/execute.ts`](src/execute.ts) | `executeNode` · `evaluateRoute` · `ExecuteOptions` | pure run-one-node / evaluate-one-edge, given state + resume values |
| [`src/registry.ts`](src/registry.ts) | `resolveFlow` · `AnyFlow` | normalize an imported module's `flows` / `default` export into definitions |

## Interactions

- **User flows** `import { defineFlow, channel, END } from "@flow/sdk"` and `export default`
  a flow (or `export const flows = [...]`).
- **`images/flow-runtime`** imports the user bundle, calls `resolveFlow` to get the
  definitions, and routes `POST /execute` → `executeNode`, `POST /route` → `evaluateRoute`.
  This is where node closures actually run, inside the container.
- **`@flow/engine`** uses the same `executeNode` / `evaluateRoute` in its `InProcessExecutor`
  (tests / local dev), so in-process and sandboxed execution share one code path.
- **`@flow/flowctl`** uses `resolveFlow` at deploy time to extract each `FlowManifest`
  from the bundle and register it.

`GraphInterrupt` is the control-flow signal `ctx.interrupt()` / `ctx.waitForEvent()` throw;
the executor turns it into a `NodeExecResult` of kind `interrupt`. Because a node
re-executes from the top on resume, **keep side effects before an interrupt idempotent**.
