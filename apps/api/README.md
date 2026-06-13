# @flow/api

The control plane: a Fastify server exposing the REST API, the SSE event stream, and the
trigger machinery (cron + external events) that creates runs. Depends on `@flow/contracts`
and `@flow/storage` (plus `fastify`, `cron-parser`, `pg`, `zod`). It **never calls the
worker directly** — it enqueues work by writing rows and `NOTIFY`ing; the worker claims
from the same tables. Postgres is the only thing the two share.

## Surface

REST under `/v1` (see [`src/routes.ts`](src/routes.ts)):

- **Runs** — `POST /runs`, `GET /runs`, `GET /runs/:id` (`{ run, checkpoint, pendingInterrupts }`),
  `GET /runs/:id/checkpoints[/:step]`, `GET /runs/:id/logs`, `POST /runs/:id/cancel`,
  `POST /runs/:id/replay`.
- **Interrupts** — `POST /runs/:id/interrupts/:interruptId/respond` (`{ value }`; 409 if already
  resolved) — stores the response and re-queues the run.
- **Flows & triggers** — `GET /flows[/:id]`, `GET|PATCH /triggers`.
- **Events** — `POST /events/:topic` (resume waiters → start event-triggered flows → store),
  `GET /events`.
- **Deployments** — `POST /deployments` (flowctl registers a manifest + image ref here).
- **Live** — `GET /runs/:id/stream` (SSE; replays history then tails).

| source | role |
|---|---|
| [`src/main.ts`](src/main.ts) | wires Fastify + CORS + auth + routes + SSE hub + cron loop; graceful shutdown |
| [`src/routes.ts`](src/routes.ts) | every `/v1` route; `RoutesDeps = { pool, hub }` |
| [`src/auth.ts`](src/auth.ts) | Bearer API-key hook — open when `FLOW_API_KEY` is unset, enforced when set |
| [`src/cron.ts`](src/cron.ts) | 15s loop: fire due cron triggers (one run per fire across instances) + purge expired events |
| [`src/events.ts`](src/events.ts) | event dispatch in one transaction: resume → start → store |
| [`src/sse.ts`](src/sse.ts) | `EventHub` — one `LISTEN` on `RUN_EVENTS_CHANNEL` fanned out per run |

## Interactions

```
flowctl / external systems ──REST──► api ──read/write/NOTIFY──► Postgres ◄──claim/checkpoint── worker
dashboard ◄──SSE (run events)──────── api
```

- **`@flow/storage`** is the only package it imports for behavior — all reads, writes,
  cron locking, event dispatch, and the `LISTEN/NOTIFY` plumbing live there.
- **`apps/worker`** is decoupled: the API marks runs `queued` and `NOTIFY`s the wakeup
  channel; the worker does the rest. Cancellation is a flag (`cancel_requested`) the worker
  observes on its heartbeat.
- **`apps/dashboard`** consumes the REST API and subscribes to `GET /runs/:id/stream`.
- **`@flow/flowctl`** is just another REST client (deploy/run/respond/event).
- Triggers can also be fed by node code running in the sandbox calling back over REST —
  that is how orchestrator flows start child runs.

Runs on `PORT` (default 4000). Set `FLOW_API_KEY` to require `Authorization: Bearer <key>`.
