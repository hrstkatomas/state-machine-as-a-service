# @flow/engine

The heart of the platform: the **super-step run loop**. `driveRun` takes a claimed run and
advances it one checkpointed step at a time until it completes, fails, pauses on an
interrupt, or its `AbortSignal` fires. Depends on `@flow/contracts`, `@flow/sdk`,
`@flow/storage`, and `pg`. It does **not** know about Docker, HTTP, or Postgres claim
mechanics — it is handed a `NodeExecutor` and a `pg.Pool` and orchestrates between them.

## What it does each step

1. Read the latest checkpoint (`state`, `frontier`, `pending_joins`) from storage.
2. Run the whole frontier in parallel through the `NodeExecutor` (one node per `execute`).
3. Merge the nodes' partial writes deterministically via channel reducers (`applyWrites`).
4. Evaluate outgoing edges (`evaluateRoute` through the executor) to compute the next
   frontier; a node with multiple static in-edges waits in `pending_joins` until all arrive.
5. Persist the new checkpoint, per-task records, logs, and `EngineEvent`s — **one transaction**.

A node that already `succeeded` in a step is never re-run after a crash (the `tasks` row is
the idempotency record); an interrupt persists the run and returns the stored response on
re-execution, matched by `(run, step, node, ordinal)`.

| source | exports | role |
|---|---|---|
| [`src/run-loop.ts`](src/run-loop.ts) | `driveRun` · `DriveDeps` | the step loop; `DriveDeps = { pool, executor, signal, nodeTimeoutMs?, sleep? }` |
| [`src/reducers.ts`](src/reducers.ts) | `applyWrites` · `initialState` · `NodeWrites` | deterministic merge of parallel writes by `ReducerKind` |
| [`src/in-process-executor.ts`](src/in-process-executor.ts) | `InProcessExecutor` | runs nodes in-process via `@flow/sdk` — for tests and local dev |

## Interactions

```
worker ──► driveRun(deps, runId)
              │  deps.pool      ─► @flow/storage  (checkpoints, tasks, interrupts, events, logs)
              │  deps.executor  ─► NodeExecutor   (@flow/sandbox in prod, InProcessExecutor in tests)
              └─ deps.signal    ◄─ worker lease/heartbeat & cancellation
```

- **`apps/worker`** is the only production caller: it claims a run, then calls `driveRun`
  with a `DockerExecutor` (`@flow/sandbox`) and a signal wired to the lease heartbeat.
- The `NodeExecutor` seam (`@flow/contracts`) is the abstraction boundary — swap
  `DockerExecutor` for `InProcessExecutor` and the same loop runs without containers.
- All persistence goes through `@flow/storage`; the engine holds no in-memory run state,
  so any worker can resume any run from its last checkpoint.

## Tests

```sh
pnpm --filter @flow/engine test   # against flow_test_engine; parallel writes, resume, interrupts
```
