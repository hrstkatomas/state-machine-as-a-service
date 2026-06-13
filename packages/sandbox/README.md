# @flow/sandbox

The production `NodeExecutor`: it runs node logic and edge evaluation inside **one Docker
container per active run**. Depends on `@flow/contracts` (the `NodeExecutor` interface and
runner protocol it implements) and `dockerode`. It knows nothing about Postgres or the run
loop — the engine calls `execute` / `evaluateRoute` and the executor turns each into an
HTTP call to the runner inside the container.

## How it works

- **One container per run.** `containerFor(runId)` lazily starts `flow-run-<runId>` from the
  run's deployed image, waits for `/healthz`, and caches it. `execute` → `POST /execute`,
  `evaluateRoute` → `POST /route` on that container's runner (`RUNNER_PORT`).
- **Persistent workspace.** A named volume `ws-<runId>` is mounted at `/workspace` and
  **outlives the container**, so a run paused on an interrupt resumes with its filesystem
  (cloned repos, installed deps) intact. `release(runId, { removeWorkspace })` stops the
  container and optionally drops the volume at terminal status.
- **Confinement & limits.** `CapDrop: ALL`, `no-new-privileges`, non-root, and
  `NanoCpus` / `Memory` / `PidsLimit` from `SandboxLimits` (`DEFAULT_LIMITS` if unset).
- **Reachability.** `ExtraHosts: ["host.docker.internal:host-gateway"]` lets node code call
  back into the API — this is how orchestrator flows (`examples/feature-pipeline`) start and
  poll child runs from inside the sandbox.
- **Logs.** Container stdout is parsed as NDJSON `LogLine`s and fanned out to the engine's
  `onLog` hook; raw `console.log` falls back to an `info` line.
- **Crash recovery.** `sweepOrphans(ownedRunIds)` removes containers labelled
  `flow.run-id` (`RUN_LABEL`) that this worker no longer owns.

| export | role |
|---|---|
| `DockerExecutor` | implements `NodeExecutor`; `execute`, `evaluateRoute`, `release`, `sweepOrphans` |
| `DockerExecutorDeps` | `{ imageFor(flowId, version), limits?, env?, docker? }` |
| `RUN_LABEL` | `"flow.run-id"` — the container label used for ownership & orphan sweep |

## Interactions

```
worker ──constructs──► DockerExecutor({ imageFor, env, limits })
engine ──execute/route──► DockerExecutor ──HTTP──► flow-runtime container ──► your node code
                              imageFor(flowId, ver) ─► flows table (worker passes a storage lookup)
```

- **`apps/worker`** constructs the `DockerExecutor`, supplying `imageFor` (a `@flow/storage`
  lookup of `flows.image_ref`) and the `env` injected into every container (e.g.
  `FLOW_API_URL`, `FLOW_API_KEY`).
- **`@flow/engine`** is the caller, through the `NodeExecutor` interface — it never sees Docker.
- The container image is **`images/flow-runtime` + the user bundle**, produced by
  `flowctl deploy`; the runner inside speaks the `@flow/contracts` runner protocol.
