# @flow/contracts

The shared type vocabulary every other package speaks. **Zero runtime dependencies** —
it is the bottom of the dependency graph, so a type can flow from the SDK (where a user
authors it) through storage (where it is persisted as `jsonb`) into the engine, the
sandbox, and the runner without any of them importing each other.

These types are the *serialized* contracts — the manifest, the executor protocol, the
runner protocol. They describe data at rest in Postgres and on the wire, never live zod
schemas or closures (those exist only inside `@flow/sdk` and user code). That separation
is what lets the host merge channel writes and route edges **without loading user code**.

## What it defines

| source | exports | role |
|---|---|---|
| [`src/ids.ts`](src/ids.ts) | branded `RunId` · `TaskId` · `InterruptId` · `FlowId` + constructors | string ids that don't mix at compile time |
| [`src/json.ts`](src/json.ts) | `Json` · `JsonObject` | the only shape persisted to `jsonb` columns |
| [`src/manifest.ts`](src/manifest.ts) | `FlowManifest` · `NodeSpec` · `EdgeSpec` · `ChannelSpec` · `ReducerKind` · `TriggerDef` · `RetryPolicy` · `END` | the compiled flow graph stored in `flows.graph` |
| [`src/executor.ts`](src/executor.ts) | `NodeExecutor` · `NodeExecRequest` · `NodeExecResult` · `ExecHooks` · `RouteEvalRequest` · `LogLine` · `ResumeValue` | the engine ⇄ executor seam (in-process or Docker) |
| [`src/runner-protocol.ts`](src/runner-protocol.ts) | `RunnerExecuteBody` · `RunnerExecuteReply` · `RunnerRouteBody` · `RunnerRouteReply` · `RUNNER_PORT` · `SandboxLimits` · `SandboxSpec` · `DEFAULT_LIMITS` | the HTTP contract between sandbox and the in-container runner |
| [`src/events.ts`](src/events.ts) | `RunStatus` · `EngineEvent` | the run-status enum and the observability event union |

## Interactions

```
contracts ◄── sdk        (manifest + executor types the builder emits)
          ◄── storage    (Json/manifest shapes it reads & writes as jsonb)
          ◄── engine     (NodeExecutor, NodeExecResult, EngineEvent, ids)
          ◄── sandbox    (NodeExecutor it implements; runner-protocol; SandboxLimits)
          ◄── flowctl    (manifest + ids for deploy/run)
          ◄── api        (RunStatus, TriggerDef, Json for request/response shapes)
          ◄── dashboard  (the same types, so UI and server can't drift)
          ◄── flow-runtime (runner-protocol it serves)
```

It imports **nothing**. Changing a type here is the one change that ripples everywhere —
which is exactly why it is isolated in its own package.
