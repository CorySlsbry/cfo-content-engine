-- engine_viral_playbook — weekly teardown of what's going viral per persona.
--
-- viral.js populates one row per persona per run. creative.js reads the most
-- recent row and injects the playbook into the script-generation system
-- prompt so Claude adapts to what's actually winning this week (hook shape,
-- length, pacing, CTA style) instead of always applying hand-coded patterns.
--
-- `playbook` is intentionally unstructured jsonb so we can evolve the shape
-- without a migration. The viral.js schema is the source of truth.

create table if not exists public.engine_viral_playbook (
  id            bigserial primary key,
  persona       text not null check (persona in ('BUILDER', 'SELLER')),
  generated_at  timestamptz not null default now(),
  sample_count  integer not null default 0,
  source_window_days integer not null default 7,
  playbook      jsonb not null,
  notes         text
);

create index if not exists engine_viral_playbook_persona_generated_idx
  on public.engine_viral_playbook (persona, generated_at desc);
