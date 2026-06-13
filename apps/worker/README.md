# @flow/worker

The execution plane: it claims queued runs from Postgres and drives them to completion.
Depends on `@flow/engine` (the run loop), `@flow/sandbox` (the Docker executor),
`@flow/storage` (claim/lease/heartbeat), and `@flow/contracts`. It is the package that
composes the others — it owns no execution logic of its own, only the claim/lease lifecycle.

## What it does

- **Claim loop.** Up to `WORKER_CONCURRENCY` (default 10) runs at once via
  `claimRun` (`FOR UPDATE SKIP LOCKED`, filtered by `workspace_host` affinity). Wakes
  immediately on the `RUN_WAKEUP_CHANNEL` `NOTIFY`, otherwise polls every second.
- **Drive.** For each claimed run it calls `driveRun` from `@flow/engine`, passing a
  `DockerExecutor` and an `AbortController.signal`.
- **Lease & heartbeat.** Every 20s it `heartbeat`s the lease; if the lease is lost (another
  worker took over) or `cancel_requested` is set, it aborts the run's signal.
- **Cleanup.** On terminal status it `release`s the container and drops the `ws-<runId>`
  volume; on startup and shutdown it `sweepOrphans` to remove containers it no longer owns.
- **Graceful shutdown.** SIGINT/SIGTERM abort active runs (their checkpoints let another
  worker resume) and close the pool.

## Interactions

```
worker ──claimRun / heartbeat / setWorkspace──► @flow/storage ──► Postgres
worker ──driveRun(pool, executor, signal)─────► @flow/engine
worker ──new DockerExecutor({ imageFor, env })─► @flow/sandbox ──► Docker container per run
```

- **No direct link to `apps/api`.** The worker only reads/writes Postgres; the API enqueues
  by writing rows + `NOTIFY`, the worker claims them. Cancellation arrives as the
  `cancel_requested` flag, observed on the heartbeat.
- It supplies `DockerExecutor` with `imageFor` (a `getFlow` lookup of `flows.image_ref`) and
  the `env` injected into every container — including `FLOW_API_URL`
  (`SANDBOX_API_URL`, default `http://host.docker.internal:4000`) and `FLOW_API_KEY`, so node
  code can call back into the API.

## Configuration

| env | default | purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://flow:flow@localhost:5432/flow` | Postgres connection |
| `WORKER_CONCURRENCY` | `10` | max simultaneous runs |
| `WORKER_HOST` | hostname | workspace/claim affinity key |
| `SANDBOX_API_URL` | `http://host.docker.internal:4000` | `FLOW_API_URL` injected into containers |
| `FLOW_API_KEY` | — | forwarded to containers when set |

```sh
node apps/worker/dist/main.js
```
