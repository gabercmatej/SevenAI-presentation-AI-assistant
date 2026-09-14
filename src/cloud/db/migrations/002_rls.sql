-- 002_rls.sql — Row-level security, default-deny, on every table this
-- migration owns.
--
-- READ THIS BEFORE ADDING A POLICY.
-- ----------------------------------
-- This file enables RLS on every table created in 001_init.sql and adds
-- ZERO policies. That is not an oversight to "fix" — it is the design.
--
-- The Node cloud API (cloud/) connects to Postgres with the Supabase
-- SERVICE ROLE key, which bypasses RLS by definition. All authorization for
-- the `anon` and `authenticated` Supabase roles happens in that one Node
-- process — team scoping, role checks (admin/member), the requireUser() /
-- requireShare() split described in CLOUD-ARCHITECTURE.md §9 — not in
-- Postgres policies.
--
-- RLS here exists purely as a SECOND, INDEPENDENT layer: if the anon key
-- ever leaks (into the client viewer bundle, a log line, a screenshot, a
-- committed .env), it must be able to read and write NOTHING. Enabling RLS
-- with no permissive policy is exactly that — every row is denied to every
-- role except the one that owns the table (the service role, via
-- BYPASSRLS) and the Postgres superuser used to run migrations.
--
-- If a future need arises for the browser to talk to Supabase directly
-- (skipping the Node backend), that is a deliberate, separate decision and
-- needs its own reviewed migration with narrow, explicit policies — not a
-- relaxation of this file. Until then: no policies here, on purpose, and if
-- you find yourself about to add `for select using (true)` to make local
-- testing easier, use the service role locally instead.
--
-- auth.users is intentionally NOT touched here — it belongs to Supabase
-- Auth, which manages its own RLS.

alter table teams                  enable row level security;
alter table profiles               enable row level security;
alter table presentations          enable row level security;
alter table presentation_versions  enable row level security;
alter table sessions               enable row level security;
alter table transcript_segments    enable row level security;
alter table session_events         enable row level security;
alter table assistant_interactions enable row level security;
alter table share_links            enable row level security;
alter table share_sessions         enable row level security;
alter table view_events            enable row level security;

-- Belt and braces: force RLS even for the table owner, so a table created
-- (or re-created) by a non-service-role login in some future migration
-- cannot accidentally read its own rows unchecked. The service role still
-- bypasses everything via BYPASSRLS regardless of this setting.
alter table teams                  force row level security;
alter table profiles               force row level security;
alter table presentations          force row level security;
alter table presentation_versions  force row level security;
alter table sessions               force row level security;
alter table transcript_segments    force row level security;
alter table session_events         force row level security;
alter table assistant_interactions force row level security;
alter table share_links            force row level security;
alter table share_sessions         force row level security;
alter table view_events            force row level security;
