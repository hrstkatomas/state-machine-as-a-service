# @flow/flowctl

The command-line client. It bundles flow source into a runnable image, registers it with
the API, and drives runs from the terminal. Depends on `@flow/contracts`, `@flow/sdk`,
`commander`, and `esbuild`. It is a pure **client of the API** — it never touches Postgres
or Docker containers directly (it does invoke the local Docker daemon to *build* images).

## Commands

| command | what it does |
|---|---|
| `deploy <entry> [--dockerfile <path>]` | bundle → build image → register manifest(s) |
| `run <flowId> [--input <json>]` | `POST /v1/runs` and print the new run id |
| `runs [--flow <id>] [--status <s>]` | list recent runs |
| `status <runId>` | run status, current step, latest checkpoint |
| `logs <runId>` | tail run logs |
| `respond <runId> <interruptId> <json>` | answer a pending interrupt (resumes the run) |
| `event <topic> [json]` | `POST /v1/events/:topic` |
| `flows` | list deployed flows and versions |

## How `deploy` works

1. **Bundle** the entry module with esbuild (ESM, node target).
2. **Resolve** the flows in the bundle via `@flow/sdk`'s `resolveFlow` to extract each
   `FlowManifest` and its `FlowId`/version.
3. **Build** a Docker image `flows/<id>:<hash>` `FROM platform/flow-runtime:latest`, layering
   the bundle at `/app/flows/index.mjs`.
4. **Register** by `POST /v1/deployments` (one per manifest), recording the image ref so
   workers know which image to run for each flow version.

### Custom execution environments (`--dockerfile`)

When a flow needs system tools the base runtime lacks (compilers, CLIs, language runtimes),
pass `--dockerfile <path>`. That file becomes the build's Dockerfile in place of the default
`FROM platform/flow-runtime + COPY` — so each flow can have its own environment without one
shared image accumulating conflicting dependencies:

- It **must** `FROM platform/flow-runtime:latest` (or an image derived from it): the base
  carries the runner that the container boots into.
- Declare only the environment (`RUN`, `ENV`, …). flowctl **appends** the bundle
  `COPY index.mjs /app/flows/index.mjs`; don't add it yourself or override the `ENTRYPOINT`.
- The Dockerfile content is folded into the image hash, so a dependency change yields a new
  image and a new flow version (older runs keep resuming on their original image).

See [`examples/cowsay`](../../examples/cowsay) for a flow that installs
`fortune | cowsay | lolcat` this way.

| source | role |
|---|---|
| [`src/main.ts`](src/main.ts) | commander CLI wiring for the commands above |
| [`src/deploy.ts`](src/deploy.ts) | esbuild bundle → manifest extraction → image build → register |
| [`src/client.ts`](src/client.ts) | thin REST client; reads `FLOW_API_URL` and `FLOW_API_KEY` |

## Interactions

```
flowctl deploy ─► esbuild bundle ─► docker build (flows/<id>:<hash>) ─► POST /v1/deployments ─► api
flowctl run/respond/event/... ────────────────────────────────────── REST ──────────────────► api
```

- **`apps/api`** is the only service flowctl talks to, over REST. `FLOW_API_URL` (default
  `http://localhost:4000`) and the optional `FLOW_API_KEY` Bearer token configure the client.
- **`@flow/sdk`** is used at build time only, to turn a bundle into manifests.
- The image it builds is consumed later by **`@flow/sandbox`** inside the worker.
