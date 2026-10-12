# GPD — web client (TypeScript + React)

```bash
npm install
npm run dev        # dev server on http://localhost:3000
npm test           # vitest: engine rules + jsdom UI tests
npm run build      # tsc --noEmit && vite build
```

`npm run dev` and `npm run build` copy `.env.example` to `.env` automatically when `.env` is
missing, so a fresh clone works immediately.

## Screens

* **Menu** — Play, Online multiplayer, Resume, Settings, Stats, Leaderboard, Friends, Notifications,
  My Games, Rules, **Desktop app** (a download button for the Python client), Sign In / Sign Up.
* **Play** — mode (online solo/teams, offline multiplayer, offline singleplayer, offline
  simulation), the **Classic / Tournament preset**, seats, selectable continent, turn timer, the host's
  Fog of War / Blindfold modifiers, player names and an optional seed. For online games the host also
  picks the lobby **visibility** (public with an optional room password, or private and sent to
  specific usernames). Tournament needs at least six players and Classic at least two. Point values are
  never editable here.
* **Lobby** — what an online game opens as. A live roster of the real usernames who joined (with seat
  and team), a lobby chat, the preset/map/timer in force, and the host's **Start game** button, which
  unlocks at the preset's minimum player count. The game only begins when the host presses it.
* **Board** — a real geographic map (world-atlas shapes, projected with d3-geo) coloured by owner,
  troop counts, `!` markers under Fog of War / Blindfold, selectable countries with live cost
  quotes, the four actions, and a tabbed side panel (turn log / players / chat) that highlights your
  own turn, with `P`/`G`/`E`/`N` shortcuts for the four actions and `Esc` to close a dialog. Under Fog
  of War or Blindfold every country you have not claimed reads as *Unidentified territory* — in the
  tooltip, the log and any error — so a name can never leak (`src/engine/vision.ts`).
* **Settings** — 30/60 FPS, SFX volume, live chat, troop counts.
* **Leaderboard** — local ranking plus the online board. Bots are never listed, and there is no
  rule editor: point values are fixed in code and only a server operator can rescore the board.
* **Rules** — the full rulebook. Typed orders (spelling the destination country) are always on.
* **Resume** — offline games exited with **Save & exit** are listed here and rebuilt exactly (PRNG
  state included) with a fresh turn clock. Online games are listed under **Online multiplayer →
  Your online games** instead: the host keeps the authoritative snapshot *and* the PRNG state on the
  server, so **Step away** keeps your seat and **Rejoin** puts you back on the same board, on the same
  seat, with the same dice. Reachable from the topbar **Online** button, the menu card and Play.
* **Notifications** — invitations, friend requests and **turn reminders**: the host files one for
  whoever's turn it is, so a player who stepped away is told to come back.

## Online play

`src/net/supabase.ts` wraps Supabase Auth with the **email + username + password** flow,
`src/net/online.ts` covers public/private lobbies (room passwords and username invitations),
the leaderboard, friends, notifications, chat and the Realtime channel, and `src/net/protocol.ts`
defines the action payloads a guest sends to the host. Room passwords are hashed by the
`set_game_password` SQL function and joined through `join_game`, so they never reach a client.
There are no bots online, and the online leaderboard only ranks human profiles.

Lobbies are real screens, not just database rows: `src/ui/LobbyPanel.tsx` polls
`online.listSeats()` for the roster (real usernames, in seat order), chats over the `messages`
table, and renders the host's **Start game** button. Pressing it takes the final roster, derives the
names from the accounts and broadcasts `sendStart`, which is what moves every guest off the lobby and
onto the board.

The **host owns the authoritative `GPDGame`**: it applies each payload through
`applyPayload(game, seat, payload)`, which rejects anything sent by a player who may not act — in
Tournament mode `game.canAct(seat)` allows **any living teammate** of the acting player, and
placement is the only action that stays strictly personal — then broadcasts the full state snapshot
to everyone else. Every move is written back with `online.pushState(...)` (snapshot + PRNG state) so
a host that stepped away can rebuild the game exactly, and `online.notifyTurn(...)` files a turn
reminder for whoever is up. Guests run their runner in `readOnly` mode: only the host advances the
turn clock. A guest that connects to a game already in
progress broadcasts a `hello` the moment it subscribes, and the host answers with the current
snapshot — without that handshake a late joiner would sit on an empty board until the next move.
The Realtime channel also has a readiness timeout, so an unreachable or unconfigured Realtime
service reports a real error instead of hanging on "Working…".

### Backend setup (required for online play)

`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` live in `.env`. **The schema is not applied
automatically** — on a fresh project there are no tables and hosting fails. Apply it once, then
check it:

```bash
psql "$SUPABASE_DB_URL" -f ../supabase/schema.sql   # or SQL editor → paste → Run
npm run check:backend                               # tools/check-supabase.mjs
```

`check:backend` uses only the publishable key the browser has and names anything missing, including
the two traps that break hosting: pgcrypto sitting in Supabase's `extensions` schema (so the
security-definer functions must use `search_path = public, extensions`), and a signed-in account that
has no `profiles` row (which `games.host_id` requires).

Failures from the backend used to collapse into "Could not host the game" because Supabase returns
plain error objects rather than `Error` instances; `errorMessage()` in `src/net/supabase.ts` now
surfaces the real cause ("Could not find the table 'public.games'…", "new row violates row-level
security policy…").

## Tests

`src/engine/__tests__/engine.test.ts` covers the rulebook (starting positions, Peace income and the
continent bonus, the `random(1,20)` gather cap, land/water/ocean pricing, the 1-in-10 sea attrition
rate measured over 200 seeded games, dice battles, vulnerable garrisons, typed-order forfeits,
scoring values, recalculation from a different rule set, turn-timer kicks, fog/blindfold views,
determinism and full bot games that always produce one winner).

`src/ui/__tests__/app.test.tsx` renders the real app with jsdom and walks the menu → setup →
presets → placement → a full human turn → a simulation to completion, checks that email is required
to sign in, that the Classic/Tournament presets restrict timers, and that there is no longer a
rule-recalculation UI.
`src/state/__tests__/local.test.ts` checks that bots never appear on the leaderboard.
`src/net/__tests__/errors.test.ts` checks that backend failures produce their real message instead of
a generic one, and `src/net/__tests__/online.test.ts` covers the Realtime channel (subscribe
readiness, the readiness timeout, the guest `hello` handshake and the host's snapshot broadcast), and
`src/engine/__tests__/teams.test.ts` covers the Tournament rules (balanced team sizes, the six-player
minimum, any-teammate-may-act, opponent rejection, personal placement, and a full six-player
tournament resolving to a single winning team).

Run with `npm test` (67 tests) or `npx vitest run`.
