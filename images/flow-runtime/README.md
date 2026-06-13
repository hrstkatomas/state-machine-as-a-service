# @flow/runtime-image

The base Docker image that every flow runs inside, plus the **runner** that executes node
code within it. Depends on `@flow/contracts` (the runner protocol) and `@flow/sdk` (to load
and run flows). This is the one place user node logic actually executes — `flowctl deploy`
layers a user bundle on top of this image, and `@flow/sandbox` starts one container from the
result per active run.

## The runner

[`src/runner.ts`](src/runner.ts) is a tiny HTTP server (bundled to `dist/runner.mjs`,
`ENTRYPOINT` of the image, listening on `RUNNER_PORT` = 8088):

| endpoint | role |
|---|---|
| `GET /healthz` | readiness — the sandbox waits on this before sending work |
| `POST /execute` | run one node via `@flow/sdk`'s `executeNode`, return a `NodeExecResult` |
| `POST /route` | evaluate one edge via `evaluateRoute`, return the next targets |

On boot it imports the user bundle from `/app/flows/index.mjs`, normalizes it with
`resolveFlow` (`mod.flows ?? [mod.default]`), and serves those definitions. Node `stdout` is
structured NDJSON `LogLine`s, which the sandbox parses and forwards to the engine.

## The image ([`Dockerfile`](Dockerfile))

`node:22-bookworm-slim` + `git` / `ca-certificates` / `openssh-client`, runs as the non-root
`node` user, working directory `/workspace` (where the run's named volume is mounted). User
code runs in Node 22 with global `fetch` and `process.env` — so a node can clone repos, run
shell via `ctx.exec`, or call back into the API.

## Interactions

```
flowctl deploy ──FROM platform/flow-runtime:latest──► flows/<id>:<hash>   (bundle at /app/flows/index.mjs)
sandbox ──docker run──► container ──HTTP /execute /route /healthz──► runner ──► @flow/sdk ──► your nodes
```

- **`@flow/flowctl`** builds each deployable image `FROM` this base.
- **`@flow/sandbox`** starts a container per run and drives the runner over HTTP using the
  `@flow/contracts` runner protocol; it injects env (`FLOW_API_URL`, `FLOW_API_KEY`) and
  mounts `ws-<runId>` at `/workspace`.
- **`@flow/sdk`** does the real work inside — `executeNode` / `evaluateRoute` against the
  loaded flow definitions.

## Build

```sh
pnpm --filter @flow/runtime-image build:image   # bundles runner + docker build -t platform/flow-runtime:latest
```
