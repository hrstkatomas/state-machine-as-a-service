# @flow/dashboard

The web UI: a React 19 SPA for watching runs live, inspecting checkpointed state, and
answering interrupts. The only package it depends on is `@flow/contracts` — it shares the
exact request/response types with the API, so the UI and server can't drift. Everything
else (data fetching, the live graph) is talked to the API over HTTP; it never touches
Postgres or the worker.

## Pages

| route | source | what it shows |
|---|---|---|
| `/runs` | [`src/pages/runs.tsx`](src/pages/runs.tsx) | filterable live run table |
| `/runs/:id` | [`src/pages/run-detail.tsx`](src/pages/run-detail.tsx) | flow graph (live node status) · checkpoint timeline + JSON state · log tail · interrupt response form |
| `/flows` | [`src/pages/flows.tsx`](src/pages/flows.tsx) | deployed flows, versions, static graph, start-run form |
| `/triggers` | [`src/pages/triggers.tsx`](src/pages/triggers.tsx) | cron next-fire times, recent events, enable/disable |

| source | role |
|---|---|
| [`src/api.ts`](src/api.ts) | typed REST client + view types (`Run`, `Checkpoint`, `Interrupt`, `RunDetail`) built on `@flow/contracts` |
| [`src/use-run-stream.ts`](src/use-run-stream.ts) | subscribes to `GET /v1/runs/:id/stream` (SSE), replays history, invalidates queries |
| [`src/run-graph.tsx`](src/run-graph.tsx) | `@xyflow/react` graph laid out by `elkjs` from `flows.graph`, colored by node status |
| [`src/ui.tsx`](src/ui.tsx) · [`src/main.tsx`](src/main.tsx) | shared components; router + query-client bootstrap |

## Interactions

```
dashboard ──REST (TanStack Query)──► api      (runs, flows, triggers, respond to interrupts)
dashboard ──SSE (EventSource)──────► api      GET /v1/runs/:id/stream  → live node/status updates
```

- **`apps/api`** is the sole backend. Reads go through TanStack Query; the SSE stream pushes
  `EngineEvent`s that update node colors and trigger a debounced query invalidation so the
  detail panes refresh in step with the run.
- **`@flow/contracts`** supplies `RunStatus`, `EngineEvent`, `FlowManifest`, `TriggerDef`,
  `Json` — the same types the API serializes — keeping client and server in lockstep.

## Develop

```sh
pnpm --filter @flow/dashboard dev   # Vite dev server on :5173, proxying /v1 to the API
```
