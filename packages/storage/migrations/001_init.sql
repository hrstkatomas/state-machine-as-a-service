create table flows (
  id           text not null,
  version      int  not null,
  graph        jsonb not null,
  triggers     jsonb not null,
  image_ref    text,
  created_at   timestamptz not null default now(),
  primary key (id, version)
);

create type run_status as enum (
  'queued', 'running', 'interrupted', 'waiting_event', 'completed', 'failed', 'cancelled'
);

create table runs (
  id                uuid primary key default gen_random_uuid(),
  flow_id           text not null,
  flow_version      int  not null,
  status            run_status not null default 'queued',
  input             jsonb,
  trigger           jsonb not null,
  current_step      int  not null default 0,
  error             text,
  cancel_requested  boolean not null default false,
  locked_by         text,
  lease_until       timestamptz,
  workspace_volume  text,
  workspace_host    text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz,
  foreign key (flow_id, flow_version) references flows (id, version)
);
create index runs_claim_idx on runs (status, lease_until, created_at)
  where status in ('queued', 'running');
create index runs_list_idx on runs (flow_id, created_at desc);

create table checkpoints (
  run_id        uuid not null references runs(id) on delete cascade,
  step          int  not null,
  state         jsonb not null,
  frontier      jsonb not null,
  pending_joins jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  primary key (run_id, step)
);

create type task_status as enum ('dispatched', 'succeeded', 'failed', 'interrupted');

create table tasks (
  id          text primary key,
  run_id      uuid not null references runs(id) on delete cascade,
  step        int  not null,
  node        text not null,
  attempt     int  not null default 1,
  status      task_status not null,
  writes      jsonb,
  error       jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index tasks_run_step_idx on tasks (run_id, step);

create table interrupts (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references runs(id) on delete cascade,
  step            int  not null,
  node            text not null,
  ordinal         int  not null,
  payload         jsonb not null,
  response_schema jsonb,
  event_topic     text,
  resume_value    jsonb,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (run_id, step, node, ordinal)
);
create index interrupts_pending_topic_idx on interrupts (event_topic)
  where resolved_at is null and event_topic is not null;

create table run_events (
  seq      bigint generated always as identity primary key,
  run_id   uuid not null,
  type     text not null,
  data     jsonb not null,
  at       timestamptz not null default now()
);
create index run_events_run_idx on run_events (run_id, seq);

create table run_logs (
  seq      bigint generated always as identity primary key,
  run_id   uuid not null,
  step     int,
  node     text,
  level    text not null,
  message  text not null,
  at       timestamptz not null default now()
);
create index run_logs_run_idx on run_logs (run_id, seq);

create table triggers (
  id            uuid primary key default gen_random_uuid(),
  flow_id       text not null,
  flow_version  int  not null,
  kind          text not null,
  schedule      text,
  timezone      text,
  topic         text,
  input         jsonb,
  enabled       boolean not null default true,
  next_fire_at  timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (flow_id, flow_version) references flows (id, version)
);
create index triggers_cron_idx on triggers (next_fire_at) where kind = 'cron' and enabled;
create index triggers_topic_idx on triggers (topic) where kind = 'event' and enabled;

create table external_events (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  payload     jsonb not null,
  matched     boolean not null default false,
  received_at timestamptz not null default now()
);
create index external_events_topic_idx on external_events (topic, received_at);

create table api_keys (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  key_hash   text not null unique,
  created_at timestamptz not null default now()
);
