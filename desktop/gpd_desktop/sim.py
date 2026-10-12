"""Headless helpers: play games out with bots and report the result."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .bots import bot_act
from .engine import GPDGame, GameConfig


@dataclass
class SimResult:
    steps: int
    finished: bool
    winner: Optional[int]
    winning_team: Optional[int]
    standings: List[dict] = field(default_factory=list)


def run_simulation(game: GPDGame, max_steps: int = 60000) -> SimResult:
    steps = 0
    while game.phase != "finished" and steps < max_steps:
        if game.actor is None:
            break
        if not bot_act(game):
            break
        steps += 1
    return SimResult(
        steps=steps,
        finished=game.phase == "finished",
        winner=game.winner,
        winning_team=game.winning_team,
        standings=[
            {"id": p.id, "name": p.name, "score": p.score, "territories": len(game.owned_by(p.id))}
            for p in game.players
        ],
    )


def play_bot_game(player_count: int, preset: str, seed: int = 1, tournament: bool = False) -> SimResult:
    cfg = GameConfig(
        map_preset=preset, mode="offline-sim", tournament=tournament,
        human_players=0, player_count=player_count, seed=seed,
    )
    return run_simulation(GPDGame(cfg))
