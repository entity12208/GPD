"""Entry point for the GPD desktop client (Python + Arcade).

    python -m gpd_desktop                 # open the game window
    python -m gpd_desktop --simulate      # headless bot-only game, then exit
    python -m gpd_desktop --help
"""

from __future__ import annotations

import sys
from typing import List, Optional

USAGE = __doc__ or ""


def _flag(argv: List[str], name: str, default: str) -> str:
    if name in argv:
        index = argv.index(name) + 1
        if index < len(argv):
            return argv[index]
    return default


def run_simulate(argv: List[str]) -> int:
    """Headless bot-only simulation; needs no window, GL or audio."""
    from .engine import GPDGame, GameConfig
    from .sim import run_simulation

    preset = _flag(argv, "--preset", "World")
    players = int(_flag(argv, "--players", "6"))
    seed = int(_flag(argv, "--seed", "1"))
    cfg = GameConfig(map_preset=preset, mode="offline-sim", human_players=0,
                     player_count=players, seed=seed)
    game = GPDGame(cfg)
    result = run_simulation(game)
    print(f"preset={preset} players={players} seed={seed} finished={result.finished} "
          f"steps={result.steps} round={game.round} winner={result.winner}")
    for row in sorted(result.standings, key=lambda r: r["score"], reverse=True):
        print(f"  {row['name']:<12} {row['score']:>6} pts  {row['territories']:>4} countries")
    return 0 if result.finished else 1


def run_window(argv: List[str]) -> int:
    from .appwindow import GPDApp
    from .state import AppState

    state = AppState.load()
    if "--fps" in argv:
        try:
            state.settings.fps = 30 if int(_flag(argv, "--fps", "60")) == 30 else 60
            state.save()
        except ValueError:
            pass

    try:
        import arcade
    except Exception as error:  # pragma: no cover - no display / no OpenGL
        print("Could not start the Arcade window:", error, file=sys.stderr)
        print("Try the headless simulation instead:  python -m gpd_desktop --simulate", file=sys.stderr)
        return 2

    app = GPDApp(state)
    arcade.run()
    return 0 if app is not None else 1


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--help" in argv or "-h" in argv:
        print(USAGE)
        print("Options:")
        print("  --simulate          run a headless bot-only simulation and exit")
        print("  --preset NAME       map preset for --simulate (default World)")
        print("  --players N         seats for --simulate (default 6)")
        print("  --seed N            deterministic seed (default 1)")
        print("  --fps 30|60         window frame rate")
        return 0
    if "--simulate" in argv:
        return run_simulate(argv)
    return run_window(argv)


if __name__ == "__main__":
    raise SystemExit(main())
