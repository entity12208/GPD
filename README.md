# GPD — Geo-Political Domination

A complete implementation of the GPD rulebook in both stacks it specifies:

| Client | Stack | Location |
| --- | --- | --- |
| Web | TypeScript + React + Vite, Supabase backend | `gpd/` |
| Desktop | Python + Arcade (desktop) | `desktop/` |

Both clients share the **same rules engine, the same 175-country map data and the same
seeded PRNG**, so a given seed plays out identically on either client.

```
gpd/          web client (React UI, online multiplayer, leaderboard, friends, chat)
desktop/      desktop client (Python + Arcade window with the same engine ported to Python)
supabase/     SQL schema: profiles, games, score events, chat, friends, notifications, RLS
tools/        map-data generator (real geography -> countries.json)
```

## Quick start

**Web client**

```bash
cd gpd
npm install
npm run dev        # http://localhost:3000  (.env is generated from .env.example)
npm test           # engine + UI tests (vitest, jsdom)
npm run build      # type-check and production bundle
```

The built web app also serves the desktop client as **`/gpd-desktop.zip`** — the **Desktop app**
card in the menu and the footer both link to it. `npm run setup:desktop` (run automatically by
`predev`/`prebuild`) regenerates the zip from `desktop/`, so the download always matches the source.

**Desktop client**

```bash
cd desktop
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m gpd_desktop                       # game window
python -m gpd_desktop --simulate --preset World --players 8 --seed 5
pytest tests -q                             # engine + headless-UI tests
```

## Modes and presets

* Online multiplayer — solo and teams (web client, email + username + password sign-in required)
* Offline multiplayer — up to 12 players, hot-seat
* Offline singleplayer — 1–12 bots
* Offline simulation — 1–12 bots, no players (watch it play itself)

Every game is played under one of the two rulebook presets:

| Preset | Teams | Chat | Turn timers |
| --- | --- | --- | --- |
| **Classic** | 1 player per team, up to 12 teams (minimum 2 players) | Global and team | Disabled (Normal), 1d, 10min, 5min, 1min |
| **Tournament** | 3 per team, 4 teams (minimum **6 players**) | Team only | 1d, 10min, 5min |

Teams are filled in balanced round-robin order, so team sizes differ by at most one and no team
ever exceeds three. In Tournament mode the turn belongs to a **team**: when it is a team's turn,
**any living member of that team may make the move**, played with the acting player's countries and
money. Starting-country placement stays personal — only the player picking may plant their own
country.

Selectable continents: North America, South America, America, Africa, Europe, Asia,
Oceania, World. Modifiers: Fog of War (×1.5 score) and Blindfold (×2 score) — chosen by the
game's host and applied to everyone who joins.

**Fog of War and Blindfold are information rules.** A player is never told the name of a country they
have not claimed: an unclaimed country reads as *Unidentified territory* everywhere — map tooltip,
turn log, action bar, engine errors and the results screen — and the typed-order rule is relaxed for
a name that was never shown to them, so nobody can be forced to spell something they cannot see.
`gpd/src/engine/vision.ts` is the single source of truth for both clients, and the Python client
mirrors it in `desktop/gpd_desktop/views.py`.

## Online play

Hosting opens a **lobby** rather than dropping straight onto the board: a live roster of the real
usernames who joined, seat and team assignment, and a lobby chat that carries over into the game.
The host holds the **Start game** button, which unlocks once the lobby has the preset's minimum
number of players (six for Tournament, two for Classic) or fills up.

Leaving an online game no longer means abandoning it. **Step away** keeps your seat on the server —
the host stores the authoritative snapshot plus the PRNG state after every move — so the **Your
online games** list can drop you straight back into the lobby or onto the board, on your own seat,
with the dice exactly where they were. When it becomes your turn the host tells you over Realtime,
pushes an in-app alert and a desktop notification, and files a row in **Notifications**, so you can
step away and come back when it is your move. Tournament turns belong to a team, so any teammate
may cover for an absent one.

## Saving and resuming

Exit an offline game with **Save & exit**: it is snapshotted (PRNG state included) and appears under
**Resume** in the menu, rebuilt exactly where you left off with a fresh turn clock. **Leave game**
asks for confirmation and abandons it for good.

Online games live on the server instead, and are resumed from the **Online multiplayer** screen. In
them the exit dialog offers **Step away** (keep the seat, rejoin later) or **Forfeit the game**
(give up the seat for good).

## Who can change what

Players cannot change rules or point values. The only per-game choices are the map, the seats,
the preset and — for whoever is hosting — the modifiers. Point values live in code, and the one
supported way to rescore the leaderboard is a server-side operator tool that needs the service
role key (`tools/admin-recalc.mjs`, plus the `recalculate_leaderboard()` SQL function, which is
revoked from `anon`/`authenticated`).

## The rules, as implemented

* **Win:** be the last player alive (last team alive in Tournament mode).
* **Setup:** $500 each; before the first turn every player picks any country; it starts with 1 troop.
* **Peace:** $100 per territory at the start of your next turn, plus $10 × countries in the
  continent for every continent you fully own; the chosen country is vulnerable until your next turn.
* **Gather Troops:** distribute X troops where X is your choice from 1 to a fresh `random(1,20)`
  draw; $50 per troop.
* **Expand:** $100 base, +$100 crossing a body of water, +$50 per troop crossing a major ocean,
  1-in-10 chance per troop of dying at sea, and you cannot expand through other countries. **Typed
  orders are mandatory:** you type the destination country's name, and a mis-spelling loses your turn. Unoccupied targets are claimed, vulnerable targets are
  wiped out, and non-vulnerable targets fight a 1–20-per-troop dice battle where the highest total
  takes the country and all opposing troops die.
* **Nothing:** pass; no country becomes vulnerable.
* **Scoring:** +50 unoccupied claim, −50 lose a country, +75 claim a previously occupied country,
  −20 fail to win, +200 claim a continent, +500 win, −200 lose. Global score is the sum of all game
  scores and the leaderboard ranks by it.
* **Recalculation:** every game stores its raw scoring events, so totals *can* be rebuilt from a
  different set of point values — but only by a server operator, never by a player
  (`gpd/src/engine/scoring.ts`, `desktop/gpd_desktop/state.py`, `tools/admin-recalc.mjs` and the
  `recalculate_leaderboard()` SQL function). Bots are never ranked on any leaderboard.

## Map data

`tools/build-map.mjs` builds `countries.json` from real geography:

* borders and shapes from **world-atlas** (`countries-110m.json`), adjacency derived from shared
  topology arcs — so Canada/USA touch, France/UK cross water, and nothing touches through a third country;
* names, ISO codes, continents, centroids and areas from **mledoze/countries**;
* sea lanes are the handful of nearest non-land neighbours (mutual, and the graph is guaranteed
  connected), classified as *body of water* (≤ 2000 km → flat +$100) or *major ocean* (→ $50 per troop).

Regenerate with `node tools/build-map.mjs` (writes into `gpd/` and `desktop/`).

## Backend (Supabase)

`supabase/schema.sql` creates the online tables (`profiles`, `games`, `game_players`,
`game_invites`, `game_secrets`, `score_events`, `messages`, `friendships`, `notifications`,
`scoring_rules`), row-level security for every table, a trigger that mirrors new auth users into
`profiles`, and SQL functions (`join_game`, `set_game_password`, `invite_to_game`,
`recalculate_player_score`, `recalculate_leaderboard`, the `leaderboard` view) so lobbies are
enforced server-side and scores can be recomputed from any rule set.

### Applying it (required before online play)

**A fresh Supabase project has no tables, and hosting fails until the schema has been run.**

```bash
# 1. apply the schema (any one of these)
psql "$SUPABASE_DB_URL" -f supabase/schema.sql
#     or paste supabase/schema.sql into Dashboard → SQL editor → Run
#     or supabase db push

# 2. prove the project is ready
node tools/check-supabase.mjs        # or: cd gpd && npm run check:backend
```

`tools/check-supabase.mjs` probes the project with nothing but the same publishable key the browser
holds, and reports every missing table/view/function, the missing seed row, and whether room-password
hashing can actually reach pgcrypto — with the exact fix for whatever fails. Run it first whenever
someone reports "Could not host the game".

Two setup traps it watches for:

* **pgcrypto lives in the `extensions` schema** on Supabase, so a `security definer` function pinned
  to `search_path = public` cannot see `crypt()`/`gen_salt()`. The schema's functions therefore use
  `search_path = public, extensions`. Symptom: public lobbies are fine but any lobby with a room
  password fails.
* **`games.host_id` references `profiles(id)`**, so an account with no `profiles` row cannot host at
  all. New sign-ups get one from the `on_auth_user_created` trigger; the schema also backfills
  accounts that predate it, and a `profiles_insert` policy lets the client repair itself.

The web client requires an **email address, a unique username and a password** to sign in or sign
up (Supabase auth is email-based). Lobbies are either **public** (listed for everyone, with an
optional room password that is hashed server-side and never readable by a client) or **private**
(hidden from the list and sent to specific usernames, who get an invitation). Joining runs through
the `join_game` SQL function so invite-only and password rules are enforced on the server.

Play then routes over a Supabase Realtime broadcast channel where **the host owns the authoritative
engine** — guests send action payloads, the host validates them against the rules and rebroadcasts
the full snapshot.

`gpd/.env` (generated from `.env.example`) holds `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. The publishable key is designed to be public. **The database
password in the rulebook's direct-connect string was not written to any file in this repo** — it
belongs in your secret manager, and it should be rotated if it has ever been shared.

## Verification status

Verified in this workspace:

* Web: `tsc --noEmit` clean, `vitest` **67/67** passing (engine rules, map connectivity, Classic /
  Tournament presets, balanced team sizes and the six-player tournament minimum, team turns (any
  teammate may act, opponents are rejected, placement stays personal), scoring, bots, determinism,
  leaderboard bot filtering, jsdom UI tests that walk the menu → setup → presets → placement → a
  full human turn → a simulation that finishes, plus tests for backend error surfacing and the
  Realtime channel's readiness/handshake behaviour).
* Desktop: `pyflakes` clean, `pytest` **51/51** passing (the same rule coverage in Python, plus
  headless tests that drive the real Arcade views).
* Backend, on the **live Supabase project**: `supabase/schema.sql` applied, then `gpd_healthcheck()`
  and `tools/check-supabase.mjs` both pass (10 tables + the `leaderboard` view, the seed rule set,
  pgcrypto reachable, every security-definer `search_path` correct, `games`/`messages` in the
  Realtime publication). A signed-up test host created a public lobby with a room password and a
  private lobby, invited a username, and the server-side rules held: a stranger could not see the
  private lobby and was rejected with `invite-only`, the invitee could see and join it and received a
  notification, the wrong room password was rejected and the right one accepted, and a non-host could
  not set a room password. The lobby rules were then rehearsed again with six real accounts: the host
  opened a Tournament lobby (capacity 12), five players joined through `join_game` and were
  auto-seated 0–5 with no collisions, re-joining kept the same seat, the roster query returned the
  real usernames in seat order, the lobby list reported `6/12` seated, a capacity-2 lobby rejected
  the extra player with `full`, the host could file a turn notification for the player whose turn it
  was while a guest could not, the snapshot and PRNG state round-tripped through the game row, and
  leaving freed the seat. The same lobby rules were also replayed on a local PostgreSQL 18.
* `vite build` succeeds; the dev server serves the preview host and 403s foreign hosts.

Not verified here (no display, no browser automation, no second machine):

* The Arcade window itself was never opened — this workspace has no X11/EGL, so desktop drawing is
  exercised through a stubbed Arcade module that records every draw call.
* Two browsers actually playing a move over Realtime were not driven end to end: the channel's
  handshake, readiness timeout, lobby/start/turn events and late-join snapshot request are covered by
  unit tests, and every lobby/password/invite/turn rule by the live REST rehearsals above, but the
  in-browser round trip is still exercised by hand. Supabase **Realtime must be enabled** for the
  project; if it is not, the client now says so instead of hanging.

## Layout

```
gpd/src/engine/        game rules, map graph, bots, simulation, scoring
gpd/src/ui/            React screens: menu, play setup, board, panels
gpd/src/net/           Supabase client, online sync, action protocol
gpd/src/state/         settings, sound effects, local profile/games
desktop/gpd_desktop/   Python port: engine, bots, map rasteriser, Arcade views
desktop/tests/         engine rules + headless UI tests
supabase/schema.sql    database schema, RLS, scoring functions
tools/build-map.mjs    map-data generator
tools/check-supabase.mjs  backend doctor (probes the live project with the publishable key)
tools/admin-recalc.mjs    operator-only leaderboard rescoring (service-role key)
```

## Hosting

The web client is deployed as a **static bundle plus a one-route Worker** (`deploy/worker.js`); it
keeps no server state because the backend is the hosted Supabase project. Both environments serve the
same artifacts, uploaded from `gpd/dist` with `deploy/manifest.json`.

| Environment | URL |
| --- | --- |
| Preview | https://site-845fe287975a44b791626dbea7483d3b.freebuff.page |
| Production | https://site-da65a69f9c2249e49bf1fe9e07a1e3a2.freebuff.page |

Sites project id `cf10dde0-1e3f-4814-bcdb-70dca9c10894`. To redeploy, build first — the Vite bundle
is what gets uploaded, so environment variables are read at build time, not deploy time:

```bash
cd gpd && npm ci && npm run build   # prebuild writes .env from .env.example and rebuilds the zip
```

The Worker answers `/__health` and otherwise passes through to the assets binding with `nosniff` and
`strict-origin-when-cross-origin` set; `spa: true` in the manifest routes client-side paths back to
`index.html`. `/gpd-desktop.zip` is a public build artifact, regenerated by `prebuild`.

Backend notes for the deployed origins: Supabase REST answers `Access-Control-Allow-Origin: *`, and
the project has `mailer_autoconfirm: true`, so sign-up issues a session immediately and **no Supabase
Site URL / redirect allow-list change is needed**. Realtime (enabled on the project) is reached over
its own WebSocket, which is not origin-restricted.
