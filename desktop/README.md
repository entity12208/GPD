# GPD — desktop client (Python + Arcade)

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

python -m gpd_desktop                                             # game window
python -m gpd_desktop --simulate --preset World --players 8 --seed 5   # headless, no GL needed
pytest tests -q
```

## What is here

* `gpd_desktop/engine.py` — the rules engine, a line-for-line port of the TypeScript version:
  Peace, Gather Troops (`random(1,20)` cap), Expand with land/water/ocean pricing, 1-in-10 sea
  attrition, dice battles, vulnerability, continent bonuses, per-turn timers, elimination and the
  full scoring table with recalculation.
* `gpd_desktop/rng.py` — the same mulberry32 PRNG as the web client, verified to produce identical
  values for a given seed, so a seed means the same game in both clients.
* `gpd_desktop/mapdata.py` — loads the shared `countries.json` and builds the adjacency graph
  (land borders plus k-nearest sea lanes, made mutual and connectivity-guaranteed per preset).
* `gpd_desktop/bots.py`, `gpd_desktop/sim.py` — bot opponents and headless play-outs.
* `gpd_desktop/topo.py`, `render.py` — a small TopoJSON decoder and a Pillow rasteriser that bakes
  the whole map (country fills, borders, selection/target/vulnerable outlines) into one texture,
  which keeps the Arcade client at a steady frame rate.
* `gpd_desktop/views.py`, `widgets.py`, `appwindow.py` — the Arcade window: animated menu, play
  setup (Classic / Tournament preset, host-chosen modifiers), the board with map + action bar +
  players/log/chat side panel, and the settings, stats, read-only leaderboard,
  friends, notifications, my-games and rulebook panels.
* **Information rules.** Fog of War and Blindfold hide the name of every country the viewer has not
  claimed (`views.py`: `HIDDEN_NAME`, `redact`, `can_see_name`); the map tooltip, the turn log and any
  engine error go through the same filter, and the typed-order rule only applies to a name the player
  has actually been shown. This mirrors `gpd/src/engine/vision.ts` on the web side.
* `gpd_desktop/audio.py` — synthesised sound effects written to temporary WAV files (no bundled
  assets, no numpy); playback is skipped when there is no audio device.

## Getting the desktop client

The web app ships this client as a single zip: **Download for Windows, macOS & Linux** in the menu
(or the footer link) fetches `/gpd-desktop.zip`. It is produced by `tools/build-desktop-zip.mjs`,
which is the dependency-free zip writer behind `npm run setup:desktop`; unzip it anywhere, then
follow the commands above.

## Platforms and limitations

* The window needs OpenGL (Arcade/pyglet). `--simulate` is fully headless.
* Online play, friends and notifications run against Supabase and live in the web client; this
  client covers the offline modes from the rulebook (singleplayer vs 1–12 bots, hot-seat multiplayer
  for up to 12 players, and simulation with bots only). The Friends/Notifications panels explain this.
* Settings, the local profile, game history and any games you paused with **Save & exit** are stored
  in `~/.gpd/desktop-state.json` (override with `GPD_DATA_DIR`). Saved games appear behind a
  **Resume** button in the menu and restore the exact board and PRNG; **Leave game** asks for
  confirmation and discards the game. Point values are fixed: the Leaderboard panel is read-only and
  bots are never ranked. Rebuilding scores from a different rule set is a server-side operator action
  (`tools/admin-recalc.mjs`), not a player-facing control.

## Tests

`tests/test_engine.py` covers the rulebook in Python (starting positions, Peace income and the
continent bonus, gather cap and costs, land/water/ocean pricing, the measured 1-in-10 attrition
rate, dice battles, vulnerable garrisons, typed-order forfeits, scoring and recalculation, timer
kicks, fog/blindfold views, determinism and full bot games on every preset).

`tests/test_ui_headless.py` installs a stubbed `arcade` module (this environment has no X11/EGL) so
the **real** views and widgets can be driven: the menu renders every entry, every panel draws and
scrolls, Play → setup → placement → a full human turn (gather and expand) works through clicks, a
simulation runs to completion and is recorded, settings apply to the window, the Classic/Tournament
presets constrain timers and build the right teams, and bots are excluded
from the leaderboard. `tests/test_engine.py` also checks the recalculation *function* directly,
which remains available to code and server operators but to no UI.
