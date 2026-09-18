-- ===========================================================================
-- Danes Arcade — database schema for Supabase (PostgreSQL)
-- ---------------------------------------------------------------------------
-- HOW TO APPLY
--   1. Create a free project at https://supabase.com  (Free tier: 500 MB
--      database, 50k monthly active users — plenty for an arcade).
--   2. Open the project's SQL Editor, paste this whole file, press Run.
--   3. Copy Project URL + anon key from Settings -> API into assets/config.js.
--
-- This script is idempotent: running it again is safe.
--
-- SECURITY MODEL
--   The browser holds only the anon key, so every table below has Row Level
--   Security switched on. The rules, not the client, decide what is allowed:
--     * anyone may read profiles, games and the leaderboard
--     * a player may insert scores only for themselves
--     * scores are append-only — nobody can edit or delete a score from the
--       browser, so a bad run cannot be erased and a good one cannot be
--       retroactively inflated
--     * a score must fall within the max declared for that game, which blocks
--       the laziest form of cheating (posting a billion)
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. PROFILES — the public face of an auth.users row
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null unique
                check (username ~ '^[A-Za-z0-9_ -]{3,20}$'),
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Display names for players. One row per auth user, created automatically on sign-up.';

-- Case-insensitive uniqueness: "Danes" and "danes" must not both exist.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));


-- ---------------------------------------------------------------------------
-- 2. GAMES — the catalogue. Must match assets/games.js
-- ---------------------------------------------------------------------------
create table if not exists public.games (
  id          text primary key,
  title       text not null,
  tagline     text,
  score_label text not null default 'Score',
  max_score   integer not null default 1000000,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on column public.games.max_score is
  'Upper bound accepted by the score insert policy. Set it a little above the
   best score the game can legitimately produce.';

-- Seed the catalogue. on conflict keeps re-runs harmless.
-- max_score is the ceiling the insert policy enforces, set a little above the
-- best score each game can legitimately produce:
--   danes-rocket    theoretical max 4,950 (three missions played perfectly)
--   asteroid-run    endless, so this is a generous ceiling rather than a max
--   orbital-puzzle  theoretical max 10,440 (twelve puzzles, first try, all
--                   seventeen crystals)
insert into public.games (id, title, tagline, score_label, max_score, sort_order)
values
  ('danes-rocket', 'Danes Rocket', 'Build it, launch it, land it on Mars.',
   'Campaign score', 6000, 1),
  ('asteroid-run', 'Asteroid Run', 'Fly the belt. Break the rocks. Stay alive.',
   'High score', 500000, 2),
  ('orbital-puzzle', 'Orbital Puzzle', 'Aim once. Let gravity do the rest.',
   'Campaign score', 15000, 3)
on conflict (id) do update
  set title       = excluded.title,
      tagline     = excluded.tagline,
      score_label = excluded.score_label,
      max_score   = excluded.max_score,
      sort_order  = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- 3. SCORES — one row per submitted run, append-only
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  game_id     text not null references public.games (id) on delete cascade,
  score       integer not null check (score >= 0),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on column public.scores.details is
  'Free-form per-game breakdown, e.g. {"missions":{"m1":940,"m2":1210}}.
   The UI renders what it recognises and ignores the rest.';

-- Leaderboard reads are always "best scores for one game", and account reads
-- are always "all scores for one player" — one index for each.
create index if not exists scores_game_score_idx
  on public.scores (game_id, score desc, created_at asc);
create index if not exists scores_user_idx
  on public.scores (user_id, game_id);


-- ---------------------------------------------------------------------------
-- 4. LEADERBOARD — one row per player per game, their personal best
-- ---------------------------------------------------------------------------
-- security_invoker makes the view run under the caller's permissions, so the
-- RLS policies below still apply through it.
create or replace view public.leaderboard
with (security_invoker = on) as
select distinct on (s.game_id, s.user_id)
  s.game_id,
  s.user_id,
  p.username,
  s.score,
  s.details,
  s.created_at
from public.scores s
join public.profiles p on p.id = s.user_id
order by s.game_id, s.user_id, s.score desc, s.created_at asc;

comment on view public.leaderboard is
  'Deduplicated scores: each player appears once per game with their best run.';


-- ---------------------------------------------------------------------------
-- 5. AUTO-CREATE A PROFILE ON SIGN-UP
-- ---------------------------------------------------------------------------
-- The client passes the chosen name in options.data.username at sign-up; this
-- trigger turns it into a profile row. If the name is missing or already taken
-- we fall back to a derived, suffixed name so sign-up never hard-fails.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text;
  final  text;
  n      integer := 0;
begin
  wanted := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    split_part(new.email, '@', 1)
  );

  -- Strip anything the username check constraint would reject, then pad short
  -- results so the constraint is always satisfiable.
  wanted := regexp_replace(wanted, '[^A-Za-z0-9_ -]', '', 'g');
  wanted := left(wanted, 20);
  if char_length(wanted) < 3 then
    wanted := 'Player';
  end if;

  final := wanted;
  while exists (select 1 from public.profiles where lower(username) = lower(final)) loop
    n := n + 1;
    final := left(wanted, 16) || n::text;
  end loop;

  insert into public.profiles (id, username) values (new.id, final);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.scores   enable row level security;

-- ---- profiles -------------------------------------------------------------
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
  on public.profiles for select
  using (true);

drop policy if exists "players update their own profile" on public.profiles;
create policy "players update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- The trigger runs as security definer and bypasses RLS, so no insert policy
-- is needed here. Leaving inserts closed stops anyone minting spare profiles.

-- ---- games ----------------------------------------------------------------
drop policy if exists "games are public" on public.games;
create policy "games are public"
  on public.games for select
  using (true);

-- The catalogue is edited from the Supabase dashboard, never from the browser.

-- ---- scores ---------------------------------------------------------------
drop policy if exists "scores are public" on public.scores;
create policy "scores are public"
  on public.scores for select
  using (true);

drop policy if exists "players submit their own scores" on public.scores;
create policy "players submit their own scores"
  on public.scores for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and score >= 0
    and exists (
      select 1 from public.games g
      where g.id = scores.game_id
        and g.active
        and scores.score <= g.max_score
    )
  );

-- No update or delete policy: scores are append-only from the browser.

grant select on public.leaderboard to anon, authenticated;


-- ===========================================================================
-- OPTIONAL — rate limiting
-- ---------------------------------------------------------------------------
-- RLS cannot express "at most N inserts per minute", so if score spam ever
-- becomes a problem, add this trigger. It is left commented out because it
-- costs a query on every submit and most arcades never need it.
-- ===========================================================================
--
-- create or replace function public.limit_score_rate()
-- returns trigger language plpgsql as $$
-- begin
--   if (select count(*) from public.scores
--        where user_id = new.user_id
--          and created_at > now() - interval '1 minute') >= 10 then
--     raise exception 'Too many scores submitted — slow down.';
--   end if;
--   return new;
-- end;
-- $$;
--
-- create trigger scores_rate_limit
--   before insert on public.scores
--   for each row execute function public.limit_score_rate();
