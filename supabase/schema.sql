-- ============================================================================
-- GPD — Geo-Political Domination : Supabase (PostgreSQL) schema
-- Run in the Supabase SQL editor (or `supabase db push`).
--
-- Design notes
--  * Point values live in code. `scoring_rules` is read-only to clients and
--    only a server operator (service_role) can change them or recalculate the
--    leaderboard — see the "Admin-only scoring" section at the bottom.
--  * Bots are never stored and never appear on the leaderboard.
--  * Games are either Classic or Tournament (the two rulebook presets).
--  * Public games may carry an optional room password; private games are sent
--    to specific usernames and never listed publicly.
-- ============================================================================
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles ---
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  email         text,
  created_at    timestamptz not null default now(),
  global_score  integer not null default 0,
  settings      jsonb   not null default '{}'::jsonb
);
alter table public.profiles add column if not exists email text;

-- --------------------------------------------------------------- scoring -----
-- Point values are data, not client code. They are readable by everyone but
-- writable only with the service-role key (no insert/update RLS policy exists,
-- and the grants below lock it down further).
create table if not exists public.scoring_rules (
  id             text primary key,
  name           text not null,
  multiplier     numeric not null default 1,
  claim_unoccupied integer not null default 50,
  lose_country     integer not null default -50,
  claim_occupied   integer not null default 75,
  fail_to_win      integer not null default -20,
  claim_continent  integer not null default 200,
  win_game         integer not null default 500,
  lose_game        integer not null default -200,
  created_at     timestamptz not null default now()
);
insert into public.scoring_rules (id, name) values ('default', 'Default')
  on conflict (id) do nothing;

-- ------------------------------------------------------------------ games ----
create table if not exists public.games (
  id            uuid primary key default gen_random_uuid(),
  host_id       uuid references public.profiles(id) on delete set null,
  mode          text not null,                -- online-solo | online-teams
  map_preset    text not null,
  preset        text not null default 'classic',   -- classic | tournament
  timer         text not null default 'none',
  fog_of_war    boolean not null default false,
  blindfold     boolean not null default false,
  tournament    boolean not null default false,
  visibility    text not null default 'public',    -- public | private
  has_password  boolean not null default false,
  capacity      integer not null default 12,    -- seats before the lobby is full
  rng           bigint,                        -- PRNG state, so a resumed game keeps its dice
  scoring_id    text references public.scoring_rules(id) default 'default',
  status        text not null default 'lobby', -- lobby | placement | active | finished
  state         jsonb,                         -- authoritative engine snapshot
  version       integer not null default 0,    -- bumped on every mutation
  winner_id     uuid references public.profiles(id),
  winning_team  integer,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
alter table public.games add column if not exists preset text not null default 'classic';
alter table public.games add column if not exists visibility text not null default 'public';
alter table public.games add column if not exists has_password boolean not null default false;
alter table public.games add column if not exists capacity integer not null default 12;
alter table public.games add column if not exists rng bigint;

-- Room passwords are stored here, never on `games`, and never selectable by
-- clients. Only the security-definer functions below touch this table.
create table if not exists public.game_secrets (
  game_id       uuid primary key references public.games(id) on delete cascade,
  password_hash text not null
);

-- Private games are "sent" to specific usernames through this table.
create table if not exists public.game_invites (
  game_id    uuid not null references public.games(id) on delete cascade,
  invitee_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (game_id, invitee_id)
);

create table if not exists public.game_players (
  game_id  uuid not null references public.games(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  seat     integer not null,
  team     integer not null default 0,
  score    integer not null default 0,
  placement integer,
  joined_at timestamptz not null default now(),
  primary key (game_id, user_id)
);

-- Every scoring event, so totals are always reproducible. Only humans record.
create table if not exists public.score_events (
  id         bigserial primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  score_key  text not null,
  created_at timestamptz not null default now()
);
create index if not exists score_events_user_idx on public.score_events (user_id);

-- ------------------------------------------------------------------- chat ----
create table if not exists public.messages (
  id         bigserial primary key,
  game_id    uuid not null references public.games(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  team       integer,                          -- null = global chat
  body       text not null check (char_length(body) <= 400),
  created_at timestamptz not null default now()
);
create index if not exists messages_game_idx on public.messages (game_id, id);

-- ------------------------------------------------------------------ social ---
create table if not exists public.friendships (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  status    text not null default 'pending',   -- pending | accepted | blocked
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  body       text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Functions
-- ============================================================================

-- Points for one key under one rule set.
create or replace function public.score_value(p_rules public.scoring_rules, p_key text)
returns integer language plpgsql immutable as $$
begin
  return case p_key
    when 'claimUnoccupied' then p_rules.claim_unoccupied
    when 'loseCountry'     then p_rules.lose_country
    when 'claimOccupied'   then p_rules.claim_occupied
    when 'failToWin'       then p_rules.fail_to_win
    when 'claimContinent'  then p_rules.claim_continent
    when 'winGame'         then p_rules.win_game
    when 'loseGame'        then p_rules.lose_game
    else 0 end;
end $$;

-- Recalculate a player's global score from scratch using a chosen rule set.
create or replace function public.recalculate_player_score(p_user uuid, p_rules_id text default 'default')
returns integer language sql stable as $$
  select coalesce(round(sum(public.score_value(r, e.score_key) * r.multiplier)), 0)::int
  from public.score_events e
  join public.scoring_rules r on r.id = p_rules_id
  where e.user_id = p_user;
$$;

-- Recalculate every player's global score (admin/operator only — see grants).
create or replace function public.recalculate_leaderboard(p_rules_id text default 'default')
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.profiles p
     set global_score = public.recalculate_player_score(p.id, p_rules_id);
end $$;

-- ------------------------------------------------------------------ lobbies --
-- Hash and attach a room password. Only the host of the game may do this.
create or replace function public.set_game_password(p_game uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.games g where g.id = p_game and g.host_id = auth.uid()) then
    raise exception 'only the host may set a room password';
  end if;
  insert into public.game_secrets (game_id, password_hash)
  values (p_game, crypt(p_password, gen_salt('bf')))
  on conflict (game_id) do update set password_hash = excluded.password_hash;
  update public.games set has_password = true where id = p_game;
end $$;

-- Join a game, enforcing invite-only privacy and the optional room password.
-- p_seat < 0 auto-seats the player in the next free seat, so two players can never
-- claim the same seat and a returning player is recognised instead of duplicated.
create or replace function public.join_game(p_game uuid, p_seat integer default -1,
                                            p_team integer default 0, p_password text default '')
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.games;
  stored_hash text;
  v_seat integer;
  v_count integer;
  v_capacity integer;
begin
  select * into g from public.games where id = p_game;
  if not found then return 'unknown'; end if;
  if g.status = 'finished' then return 'closed'; end if;

  if g.visibility = 'private' then
    if g.host_id <> auth.uid()
       and not exists (select 1 from public.game_invites gi
                        where gi.game_id = p_game and gi.invitee_id = auth.uid()) then
      return 'invite-only';
    end if;
  elsif g.has_password then
    select password_hash into stored_hash from public.game_secrets where game_id = p_game;
    if stored_hash is null or stored_hash <> crypt(coalesce(p_password, ''), stored_hash) then
      return 'wrong-password';
    end if;
  end if;

  v_capacity := coalesce(g.capacity, 12);

  -- Already seated: this is a reconnect (or a re-join from the lobby list), not a
  -- new seat, so keep the old seat and just refresh the team.
  select seat into v_seat from public.game_players
   where game_id = p_game and user_id = auth.uid();
  if v_seat is not null then
    if coalesce(p_team, -1) >= 0 then
      update public.game_players set team = p_team
       where game_id = p_game and user_id = auth.uid();
    end if;
    return 'ok';
  end if;

  select count(*) into v_count from public.game_players where game_id = p_game;
  if v_count >= v_capacity then return 'full'; end if;

  if coalesce(p_seat, -1) < 0 then
    select coalesce(max(seat) + 1, 0) into v_seat from public.game_players where game_id = p_game;
  else
    v_seat := p_seat;
  end if;

  insert into public.game_players (game_id, user_id, seat, team)
  values (p_game, auth.uid(), v_seat, greatest(coalesce(p_team, 0), 0));
  return 'ok';
end $$;

-- Send a private game to a username: invite row + notification. Host only.
create or replace function public.invite_to_game(p_game uuid, p_username text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid;
  v_host uuid;
  v_status text;
begin
  select id into v_uid from public.profiles where lower(username) = lower(p_username) limit 1;
  if v_uid is null then return false; end if;
  select host_id, status into v_host, v_status from public.games where id = p_game;
  if v_host is null or v_host <> auth.uid() then return false; end if;
  if v_status = 'finished' then return false; end if;
  insert into public.game_invites (game_id, invitee_id) values (p_game, v_uid)
    on conflict (game_id, invitee_id) do nothing;
  insert into public.notifications (user_id, kind, body)
    values (v_uid, 'invite', 'You were invited to a private GPD game.');
  return true;
end $$;

-- Tell a player it is their turn. Only the host of that game may call it, and
-- only for a seat that exists, so a client cannot spam other players.
create or replace function public.notify_turn(p_game uuid, p_seat integer, p_body text default '')
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  v_host uuid;
  v_user uuid;
begin
  select host_id into v_host from public.games where id = p_game;
  if v_host is null or v_host <> auth.uid() then return false; end if;
  select gp.user_id into v_user from public.game_players gp
   where gp.game_id = p_game and gp.seat = p_seat;
  if v_user is null then return false; end if;
  insert into public.notifications (user_id, kind, body)
  values (v_user, 'turn', coalesce(nullif(p_body, ''), 'It is your turn in a GPD game.'));
  return true;
end $$;
grant execute on function public.notify_turn(uuid, integer, text) to authenticated;

-- Backend self-check. A client holding only the publishable key cannot read the
-- schema, so this function is how `tools/check-supabase.mjs` (and anyone
-- debugging "Could not host the game") can tell a healthy project from a
-- half-applied one.
--
-- It reports the schema of pgcrypto and the effective search_path of every
-- security-definer function: Supabase installs pgcrypto into the `extensions`
-- schema, so a function pinned to `search_path = public` cannot see
-- `crypt()`/`gen_salt()` and room passwords break.
create or replace function public.gpd_healthcheck()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'schema', 'gpd-1',
    'pgcrypto_schema', (
      select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
       where e.extname = 'pgcrypto'
    ),
    'search_paths', (
      select coalesce(jsonb_object_agg(p.proname, coalesce(array_to_string(p.proconfig, ' '), '')),
                      '{}'::jsonb)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
    ),
    'tables', (select count(*)::int from information_schema.tables
                where table_schema = 'public' and table_type = 'BASE TABLE'),
    'rules', (select count(*)::int from public.scoring_rules)
  );
$$;
grant execute on function public.gpd_healthcheck() to anon, authenticated;

-- Leaderboard view, ranked by global score (humans only — bots are never stored).
create or replace view public.leaderboard as
  select p.id, p.username, p.global_score,
         rank() over (order by p.global_score desc) as rank
  from public.profiles p;

-- Keep profiles in sync with new auth users (username from sign-up metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, username, email)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
          new.email)
  on conflict (id) do nothing;
  return new;
end $$;

-- Backfill: give any account that predates the trigger a profile row, keeping
-- usernames unique. Idempotent — a no-op once every account has one.
do $$
declare
  r record;
  base text;
  candidate text;
  n int;
begin
  for r in select u.id, u.email, u.raw_user_meta_data
             from auth.users u
            where not exists (select 1 from public.profiles p where p.id = u.id)
  loop
    base := coalesce(nullif(r.raw_user_meta_data->>'username', ''), split_part(r.email, '@', 1));
    candidate := base;
    n := 1;
    while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
      n := n + 1;
      candidate := base || n::text;
    end loop;
    insert into public.profiles (id, username, email) values (r.id, candidate, r.email);
  end loop;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------- realtime --
-- Supabase only streams `postgres_changes` for tables in the realtime publication.
-- Game snapshots and chat history use it; the lobby/game channels otherwise rely on
-- Realtime broadcast, which needs no publication.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_rel r join pg_publication p on p.oid = r.prpubid
                    where p.pubname = 'supabase_realtime' and r.prrelid = 'public.games'::regclass) then
      alter publication supabase_realtime add table public.games;
    end if;
    if not exists (select 1 from pg_publication_rel r join pg_publication p on p.oid = r.prpubid
                    where p.pubname = 'supabase_realtime' and r.prrelid = 'public.messages'::regclass) then
      alter publication supabase_realtime add table public.messages;
    end if;
  end if;
end $$;

-- ============================================================================
-- Row level security
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.games         enable row level security;
alter table public.game_players  enable row level security;
alter table public.score_events  enable row level security;
alter table public.messages      enable row level security;
alter table public.friendships   enable row level security;
alter table public.notifications enable row level security;
alter table public.scoring_rules enable row level security;
alter table public.game_secrets  enable row level security;
alter table public.game_invites  enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);
drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
-- A player may create their own profile row. The auth trigger normally does this,
-- but `games.host_id` references `profiles(id)`, so an account that predates the
-- trigger (or signs up while it is briefly absent) could not host a game at all
-- until its profile existed. The client self-heals through this policy.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (auth.uid() = id);

-- Lobbies: public ones are visible to everyone; private ones only to the host,
-- the players already seated, and the invited usernames.
drop policy if exists games_read on public.games;
create policy games_read on public.games for select using (
  visibility = 'public'
  or host_id = auth.uid()
  or exists (select 1 from public.game_players gp where gp.game_id = id and gp.user_id = auth.uid())
  or exists (select 1 from public.game_invites gi where gi.game_id = id and gi.invitee_id = auth.uid())
);
drop policy if exists games_insert on public.games;
create policy games_insert on public.games for insert with check (auth.uid() = host_id);
drop policy if exists games_update on public.games;
create policy games_update on public.games for update
  using (auth.uid() = host_id or exists (
    select 1 from public.game_players gp where gp.game_id = id and gp.user_id = auth.uid()));

drop policy if exists gp_read on public.game_players;
create policy gp_read on public.game_players for select using (true);
drop policy if exists gp_join on public.game_players;
create policy gp_join on public.game_players for insert with check (auth.uid() = user_id);
drop policy if exists gp_leave on public.game_players;
create policy gp_leave on public.game_players for delete using (auth.uid() = user_id);

-- Invitations: you can only see the ones addressed to you. (The host never
-- needs to read this table, and referencing `games` here would recurse into the
-- `games_read` policy, which itself reads `game_invites`.)
drop policy if exists gi_read on public.game_invites;
create policy gi_read on public.game_invites for select using (invitee_id = auth.uid());

-- `game_secrets` has RLS enabled with no policies: no client can read a hash.

drop policy if exists se_read on public.score_events;
create policy se_read on public.score_events for select using (true);
drop policy if exists se_insert on public.score_events;
create policy se_insert on public.score_events for insert with check (auth.uid() = user_id);

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select using (true);
drop policy if exists messages_write on public.messages;
create policy messages_write on public.messages for insert with check (auth.uid() = user_id);

drop policy if exists friends_read on public.friendships;
create policy friends_read on public.friendships for select using (auth.uid() = user_id or auth.uid() = friend_id);
drop policy if exists friends_write on public.friendships;
create policy friends_write on public.friendships for insert with check (auth.uid() = user_id);
drop policy if exists friends_del on public.friendships;
create policy friends_del on public.friendships for delete using (auth.uid() = user_id or auth.uid() = friend_id);

drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select using (auth.uid() = user_id);
drop policy if exists notif_write on public.notifications;
create policy notif_write on public.notifications for update using (auth.uid() = user_id);

drop policy if exists rules_read on public.scoring_rules;
create policy rules_read on public.scoring_rules for select using (true);

-- ============================================================================
-- Admin-only scoring (server operators with the service-role key)
-- ============================================================================
-- Clients can read point values but never change them. Recalculation is
-- reserved for the service role, which bypasses RLS. Run these once:
revoke insert, update, delete on public.scoring_rules from anon, authenticated;
revoke execute on function public.recalculate_leaderboard(text) from public, anon, authenticated;
grant  execute on function public.recalculate_leaderboard(text) to service_role;
grant  execute on function public.recalculate_player_score(uuid, text) to service_role;

-- Operator procedure to change the point values and rebuild the leaderboard:
--   update public.scoring_rules
--      set claim_unoccupied = 60, lose_country = -60, claim_occupied = 90,
--          fail_to_win = -25, claim_continent = 250, win_game = 600, lose_game = -250
--    where id = 'default';
--   select public.recalculate_leaderboard('default');
-- (Also available as `node tools/admin-recalc.mjs`, which uses the service key.)
