"""Local settings, profile and game history for the desktop client."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

DATA_DIR = Path(os.environ.get("GPD_DATA_DIR", Path.home() / ".gpd"))
STATE_FILE = DATA_DIR / "desktop-state.json"


@dataclass
class Settings:
    fps: int = 60
    sfx_volume: float = 0.5
    live_chat: bool = True
    show_troop_counts: bool = True
    bot_delay: float = 0.7


@dataclass
class Profile:
    username: Optional[str] = None
    guest: bool = True


@dataclass
class GameRecord:
    finished_at: str
    mode: str
    map_preset: str
    winner: Optional[int]
    rounds: int
    standings: List[dict] = field(default_factory=list)
    score_events: List[dict] = field(default_factory=list)
    multiplier: float = 1.0


SAVED_META_KEYS = ("id", "saved_at", "mode", "map_preset", "preset", "round", "phase",
                   "alive_count", "player_count")


@dataclass
class AppState:
    settings: Settings = field(default_factory=Settings)
    profile: Profile = field(default_factory=Profile)
    games: List[GameRecord] = field(default_factory=list)
    leaderboard: List[dict] = field(default_factory=list)
    # Paused games the player exited with "Save & exit"; each is a snapshot dict.
    saved: List[dict] = field(default_factory=list)

    # ------------------------------------------------------------- storage ---
    @classmethod
    def load(cls) -> "AppState":
        state = cls()
        try:
            if STATE_FILE.exists():
                raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                state.settings = Settings(**raw.get("settings", {}))
                state.profile = Profile(**raw.get("profile", {}))
                state.games = [GameRecord(**g) for g in raw.get("games", [])]
                state.saved = list(raw.get("saved", []))
        except Exception:
            pass
        state.rebuild_leaderboard()
        return state

    def save(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(json.dumps({
                "settings": asdict(self.settings),
                "profile": asdict(self.profile),
                "games": [asdict(g) for g in self.games[:100]],
                "saved": self.saved[:20],
            }, indent=1), encoding="utf-8")
        except Exception:
            pass

    # ----------------------------------------------------------- leaderboard -
    def record(self, record: GameRecord) -> None:
        self.games = [record] + [g for g in self.games if g.finished_at != record.finished_at][:99]
        self.rebuild_leaderboard()
        self.save()

    def rebuild_leaderboard(self, rules: Optional[Dict[str, int]] = None,
                            multiplier_from_game: bool = True) -> None:
        """Scores are always derived from the stored events, so any rule set works."""
        from .engine import DEFAULT_SCORING, ScoringRules

        ruleset = ScoringRules(**rules) if rules else DEFAULT_SCORING
        totals: Dict[str, int] = {}
        for game in self.games:
            for entry in game.standings:
                if entry.get("is_bot"):
                    continue
                name = entry.get("name", "?")
                events = [e for e in game.score_events if e.get("player") == entry.get("id")]
                if events:
                    mult = game.multiplier if multiplier_from_game else 1.0
                    value = sum(ruleset.value(e.get("key", "")) for e in events)
                    totals[name] = totals.get(name, 0) + int(round(value * mult))
                else:
                    totals[name] = totals.get(name, 0) + int(entry.get("score", 0))
        self.leaderboard = sorted(
            ({"name": k, "score": v} for k, v in totals.items()),
            key=lambda row: row["score"], reverse=True,
        )

    # --------------------------------------------------------------- resume --
    def save_game(self, snapshot: dict) -> dict:
        """Store a paused game (with its engine snapshot) and return its meta."""
        self.saved = [snapshot] + [s for s in self.saved if s.get("id") != snapshot.get("id")]
        self.saved = self.saved[:20]
        self.save()
        return {k: snapshot.get(k) for k in SAVED_META_KEYS}

    def delete_saved(self, game_id: str) -> None:
        self.saved = [s for s in self.saved if s.get("id") != game_id]
        self.save()

    def saved_meta(self) -> List[dict]:
        return [{k: s.get(k) for k in SAVED_META_KEYS} for s in self.saved]

    def get_saved(self, game_id: str) -> Optional[dict]:
        return next((s for s in self.saved if s.get("id") == game_id), None)

    def stats(self) -> Dict[str, int]:
        games = [g for g in self.games if not all(p.get("is_bot") for p in g.standings)]
        wins = sum(1 for g in games if g.winner is not None)
        points = sum(p.get("score", 0) for g in games for p in g.standings if not p.get("is_bot"))
        return {"games": len(games), "wins": wins, "losses": len(games) - wins, "points": points}
