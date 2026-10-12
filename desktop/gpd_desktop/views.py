"""Arcade views: the main menu, the play setup, the game board and the
information panels (settings, stats, leaderboard, friends, notifications,
my games and the rulebook)."""

from __future__ import annotations

import datetime as _dt
import os
import tempfile
import time as _time
from typing import TYPE_CHECKING, Callable, Dict, List, Optional, Sequence

import arcade

from . import mapdata as geo
from . import theme
from .audio import SFX
from .bots import bot_act
from .engine import (DEFAULT_PRESET, DEFAULT_SCORING, PRESETS, TROOP_COST, GPDGame, min_players,
                     GameConfig, preset_capacity, score_multiplier, timer_allowed)
from .render import WorldMapRender
from .state import GameRecord

# Fog of War and Blindfold are information rules: a player must never learn the
# name of a country they have not claimed. Every place a name is drawn goes
# through these helpers, so the rule lives in one place.
HIDDEN_NAME = "Unidentified territory"


def hidden_country_names(game: GPDGame, viewer_id: int) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not (game.config.fog_of_war or game.config.blindfold):
        return out
    for cid in game.active:
        territory = game.territories.get(cid)
        if territory is not None and territory.owner == viewer_id:
            continue
        country = geo.BY_ID.get(cid)
        if country is not None:
            out[country.name] = HIDDEN_NAME
    return out


def redact_country_names(text: str, hidden: Dict[str, str]) -> str:
    if not text or not hidden:
        return text
    # Longest names first so "United Kingdom" is not eaten by a shorter name inside it.
    for name in sorted(hidden, key=len, reverse=True):
        if name in text:
            text = text.replace(name, hidden[name])
    return text
from .widgets import (Button, Selector, Slider, TextField, Toggle, Widget,
                      draw_label, draw_panel)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .__main__ import GPDApp

WINDOW_W = 1440
WINDOW_H = 900
TOPBAR_H = 52
SIDE_W = 356
MAP_AREA_W = WINDOW_W - SIDE_W
ACTIONBAR_H = 176
MAP_IMG_W = 1400
MAP_IMG_H = 800

RUNES = [
    ("North America", "North America"), ("South America", "South America"),
    ("America", "America"), ("Africa", "Africa"), ("Europe", "Europe"),
    ("Asia", "Asia"), ("Oceania", "Oceania"), ("World", "World"),
]
MODE_OPTIONS = [
    ("offline-solo", "Offline Singleplayer"),
    ("offline-multi", "Offline Multiplayer"),
    ("offline-sim", "Offline Simulation"),
]
TIMER_OPTIONS = [
    ("none", "Disabled (Normal)"), ("1d", "1d (Daily)"), ("10min", "10min (Rapid)"),
    ("5min", "5min (Blitz)"), ("1min", "1min (Bullet)"),
]
PRESET_OPTIONS = [(p["id"], f"{p['label']} mode") for p in PRESETS.values()]

EVENT_SFX = {
    "combat": "battle", "claim": "claim", "expand": "expand", "win": "win", "loss": "lose",
    "income": "coin", "peace": "peace", "timeout": "lose", "forfeit": "error", "turn": "turn",
    "continent": "win",
}


class ViewBase(arcade.View):
    """Common widget plumbing."""

    def __init__(self, app: "GPDApp") -> None:
        super().__init__()
        self.app = app
        self.widgets: List[Widget] = []
        self.background_color = theme.BACKGROUND

    def on_show_view(self) -> None:
        self.layout()

    def layout(self) -> None:
        self.widgets = []

    def on_mouse_press(self, x: int, y: int, button: int, modifiers: int) -> None:
        for widget in reversed(self.widgets):
            if widget.enabled and widget.on_mouse_press(x, y, button):
                return

    def on_mouse_motion(self, x: int, y: int, dx: int, dy: int) -> None:
        for widget in self.widgets:
            widget.on_mouse_motion(x, y)

    def on_mouse_release(self, x: int, y: int, button: int, modifiers: int) -> None:
        for widget in self.widgets:
            if isinstance(widget, Slider):
                widget.release()

    def on_mouse_scroll(self, x: int, y: int, scroll_x: int, scroll_y: int) -> None:
        for widget in reversed(self.widgets):
            if widget.on_mouse_scroll(x, y, scroll_y):
                return

    def on_key_press(self, symbol: int, modifiers: int) -> None:
        for widget in reversed(self.widgets):
            if widget.on_key(symbol, modifiers):
                return

    def on_text_input(self, text: str) -> None:
        for widget in reversed(self.widgets):
            if widget.on_text(text):
                return

    def button(self, x, y, w, h, label, on_click, **kw) -> Button:
        b = Button(x, y, w, h, label, on_click, **kw)
        self.widgets.append(b)
        return b

    def draw_topbar(self, title: str, on_back: Optional[Callable[[], None]] = None) -> None:
        arcade.draw_lbwh_rectangle_filled(0, WINDOW_H - TOPBAR_H, WINDOW_W, TOPBAR_H, theme.TOP_BAR)
        arcade.draw_line(0, WINDOW_H - TOPBAR_H, WINDOW_W, WINDOW_H - TOPBAR_H, theme.LINE, 1)
        arcade.draw_circle_filled(28, WINDOW_H - TOPBAR_H / 2, 11, theme.ACCENT)
        draw_label("GPD", 46, WINDOW_H - 18, 15, theme.TEXT, bold=True)
        draw_label(title, 110, WINDOW_H - 20, 14, theme.MUTED)
        if on_back is not None:
            self.button(WINDOW_W - 110, WINDOW_H - 12, 92, 30, "Back", on_back, font_size=12)
        toast = getattr(self.app, "toast_text", "")
        if toast:
            draw_label(toast, WINDOW_W / 2, WINDOW_H - 30, 12, theme.WARN,
                       anchor_x="center", anchor_y="center", bold=True)


class MenuView(ViewBase):
    ENTRIES = [
        ("Play", "Online or offline: solo, hot-seat, bots or simulation."),
        ("Settings", "Frame rate (30/60 FPS), SFX volume and live chat."),
        ("Stats", "Career totals: games, wins, losses and points."),
        ("Leaderboard", "Ranked by global score — bots are never ranked."),
        ("Friends", "Friend requests and your friends list."),
        ("Notifications", "Invitations, friend requests and turn reminders."),
        ("My Games", "Every game played on this machine."),
        ("Rules", "The complete GPD rulebook."),
    ]

    def layout(self) -> None:
        super().layout()
        x0, y0 = 80, WINDOW_H - 110
        card_w, card_h = 520, 132
        targets = [self.app.show_setup] + [
            (lambda name=name.lower(): self.app.show_panel(name))
            for name in ("settings", "stats", "leaderboard", "friends", "notifications", "mygames", "rules")
        ]
        for i in range(len(self.ENTRIES)):
            cx = x0 + (i % 2) * (card_w + 30)
            cy = y0 - (i // 2) * (card_h + 18)
            self.button(cx, cy, card_w, card_h, "", targets[i], font_size=1)
        if self.app.state.profile.username:
            self.button(WINDOW_W - 260, WINDOW_H - 12, 148, 30,
                        f"{self.app.state.profile.username} — sign out", self.app.sign_out, font_size=11)
        else:
            self.button(WINDOW_W - 190, WINDOW_H - 12, 170, 30, "Sign In / Sign Up",
                        lambda: self.app.show_panel("signin"), primary=True, font_size=11)
        saved = self.app.state.saved_meta()
        if saved:
            self.button(WINDOW_W - 420, WINDOW_H - 12, 200, 30,
                        f"Resume game ({len(saved)})",
                        lambda: self.app.show_panel("resume"), font_size=11)

    def on_draw(self) -> None:
        self.clear()
        self.draw_topbar("Geo-Political Domination — desktop client (Python + Arcade)")
        x0, y0 = 80, WINDOW_H - 110
        card_w, card_h = 520, 132
        for i, (title, blurb) in enumerate(self.ENTRIES):
            cx = x0 + (i % 2) * (card_w + 30)
            cy = y0 - (i // 2) * (card_h + 18)
            draw_panel(cx, cy, card_w, card_h)
            draw_label(title, cx + 20, cy - 24, 17, theme.TEXT, bold=True)
            draw_label(blurb, cx + 20, cy - 56, 11, theme.MUTED)
            draw_label("Open", cx + card_w - 20, cy - card_h + 24, 11, theme.ACCENT, anchor_x="right")
        for widget in self.widgets:
            widget.draw()
        state = self.app.state
        draw_label(f"{len(state.games)} games on this machine · {state.settings.fps} FPS · "
                   f"engine shared with the web client · online play in the web client (Supabase)",
                   80, 30, 11, theme.MUTED)


class SetupView(ViewBase):
    def __init__(self, app: "GPDApp") -> None:
        super().__init__(app)
        self.mode = "offline-solo"
        self.preset = DEFAULT_PRESET
        self.map = "World"
        self.timer = "none"
        self.fog = False
        self.blindfold = False
        self.players = 4
        self.seed_text = ""
        self.names = [f"Player {i + 1}" for i in range(12)]
        self.message = ""

    def layout(self) -> None:
        super().layout()
        self.draw_topbar("Play — choose a preset and a map", self.app.show_menu)
        self.widgets.append(Selector(80, WINDOW_H - 116, 380, 62, "Mode", MODE_OPTIONS,
                                     [m[0] for m in MODE_OPTIONS].index(self.mode), self._set_mode))
        self.widgets.append(Selector(80, WINDOW_H - 206, 380, 62, "Preset", PRESET_OPTIONS,
                                     [o[0] for o in PRESET_OPTIONS].index(self.preset), self._set_preset))
        self.widgets.append(Selector(80, WINDOW_H - 296, 380, 62, "Continent", RUNES,
                                     [r[0] for r in RUNES].index(self.map), self._set_map))
        self.widgets.append(Selector(80, WINDOW_H - 386, 380, 62, "Turn timer", self._timer_options(),
                                     self._timer_index(), self._set_timer))
        self.widgets.append(Slider(80, WINDOW_H - 430, 380, 40, "Players / bots",
                                   max(self.players, min_players(self.preset)),
                                   min_players(self.preset), preset_capacity(self.preset),
                                   self._set_players, fmt=lambda v: str(int(v))))
        self.widgets.append(Toggle(80, WINDOW_H - 494, 380, 26, "Fog of War (score x1.5)", self.fog, self._set_fog))
        self.widgets.append(Toggle(80, WINDOW_H - 528, 380, 26, "Blindfold (score x2)", self.blindfold, self._set_blind))
        self.widgets.append(TextField(80, WINDOW_H - 574, 380, 34, self.seed_text,
                                      "Seed (optional) — same seed, same game", on_change=self._set_seed))
        for i in range(min(4, self._human_count())):
            self.widgets.append(TextField(500, WINDOW_H - 116 - i * 44, 300, 34, self.names[i],
                                          f"Player {i + 1} name",
                                          on_change=lambda v, idx=i: self._set_name(idx, v)))
        self.button(80, 120, 220, 46, "Start game", self._start, primary=True)
        self.button(320, 120, 200, 46, "Reset modifiers", self._reset)

    def _timer_options(self):
        spec = PRESETS.get(self.preset, PRESETS[DEFAULT_PRESET])
        allowed = spec["timers"]
        return [t for t in TIMER_OPTIONS if t[0] in allowed]

    def _timer_index(self) -> int:
        options = self._timer_options()
        ids = [t[0] for t in options]
        return ids.index(self.timer) if self.timer in ids else 0

    def _human_count(self) -> int:
        if self.mode == "offline-sim":
            return 0
        if self.mode == "offline-solo":
            return 1
        return min(12, self.players)

    def _total_players(self) -> int:
        if self.mode == "offline-sim":
            return max(1, self.players)
        if self.mode == "offline-solo":
            return max(2, self.players + 1)
        return max(2, min(12, self.players))

    def _set_mode(self, value: str) -> None:
        self.mode = value
        self.layout()

    def _set_preset(self, value: str) -> None:
        self.preset = value
        if not timer_allowed(self.preset, self.timer):
            self.timer = PRESETS[self.preset]["timers"][0]
        # Tournament needs one full team per side, so never drop below its minimum.
        self.players = min(max(self.players, min_players(self.preset)), preset_capacity(self.preset))
        self.layout()

    def _set_map(self, value: str) -> None:
        self.map = value
        self.layout()

    def _set_timer(self, value: str) -> None:
        self.timer = value

    def _set_players(self, value: float) -> None:
        if int(value) != self.players:
            self.players = int(value)
            self.layout()

    def _set_fog(self, value: bool) -> None:
        self.fog = value

    def _set_blind(self, value: bool) -> None:
        self.blindfold = value

    def _set_seed(self, value: str) -> None:
        self.seed_text = value

    def _set_name(self, index: int, value: str) -> None:
        self.names[index] = value

    def _reset(self) -> None:
        self.fog = self.blindfold = False
        self.layout()

    def _start(self) -> None:
        total = self._total_players()
        countries = len(geo.countries_for_preset(self.map))
        if total > countries:
            self.message = f"{self.map} has only {countries} countries — reduce the player count."
            return
        if total < min_players(self.preset):
            self.message = (f"{PRESETS[self.preset]['label']} plays teams of "
                            f"{PRESETS[self.preset]['max_per_team']}, so it needs at least "
                            f"{min_players(self.preset)} players.")
            return
        seed = None
        if self.seed_text.strip():
            try:
                seed = int(self.seed_text.strip())
            except ValueError:
                seed = abs(hash(self.seed_text.strip())) % (2**31)
        cfg = GameConfig(
            map_preset=self.map, mode=self.mode, preset=self.preset, timer=self.timer,
            fog_of_war=self.fog, blindfold=self.blindfold, tournament=self.preset == "tournament",
            seed=seed, human_players=self._human_count(), player_count=total,
            scoring=DEFAULT_SCORING,  # point values are canonical; players cannot edit them
        )
        names = [self.names[i].strip() or f"Player {i + 1}" for i in range(self._human_count())]
        names += [f"Bot {i + 1}" for i in range(total - self._human_count())]
        self.app.start_game(cfg, names)

    def on_draw(self) -> None:
        self.clear()
        self.draw_topbar("Play — choose a preset and a map", self.app.show_menu)
        spec = PRESETS.get(self.preset, PRESETS[DEFAULT_PRESET])
        draw_label(f"{self._total_players()} seats · {len(geo.countries_for_preset(self.map))} countries "
                   f"on this map · {self.mode}", 80, WINDOW_H - 88, 12, theme.MUTED)
        draw_label(f"{spec['label']} preset — {spec['blurb']}",
                   500, WINDOW_H - 88, 11, theme.MUTED)
        for widget in self.widgets:
            widget.draw()
        draw_label("Win condition: be the last player alive (last team alive in Tournament mode). "
                   "Everyone starts with $500 and picks a starting country before the first turn.",
                   80, 84, 11, theme.MUTED)
        draw_label("Scoring is fixed by the rules; only a server operator can recalculate the leaderboard.",
                   80, 66, 11, theme.MUTED)
        if self.message:
            draw_label(self.message, 80, 44, 12, theme.BAD)


class GameView(ViewBase):
    """The board: map on the left, players/log/chat on the right."""

    def __init__(self, app: "GPDApp", config: GameConfig, names: Sequence[str],
                 game: Optional[GPDGame] = None) -> None:
        super().__init__(app)
        self.game = game if game is not None else GPDGame(config, names)
        self.map = WorldMapRender(config.map_preset, MAP_IMG_W, MAP_IMG_H)
        self.sprite: Optional[arcade.Sprite] = None
        self.texture_path = os.path.join(tempfile.mkdtemp(prefix="gpd-map-"), "map.png")
        self.mode = "idle"
        self.from_id: Optional[str] = None
        self.to_id: Optional[str] = None
        self.send_troops = 1
        self.distribution: Dict[str, int] = {}
        self.chat: List[dict] = []
        self.chat_tab = "global"
        self.chat_field: Optional[TextField] = None
        self.typed_field: Optional[TextField] = None
        self.confirm_exit = False
        self.leave_confirm = False
        self.error = ""
        self.auto_bots = True
        self.turn_clock = 0.0
        self._log_len = len(self.game.log)
        self.showing_results = False
        self._map_dirty = True
        self._finished = False

    # --------------------------------------------------------------- helpers --
    @property
    def actor(self):
        return self.game.actor

    @property
    def is_human_turn(self) -> bool:
        actor = self.actor
        if not actor:
            return False
        if self.game.phase == "placement":
            # Placement puts a country in the picker's own colour, so it stays personal.
            return not actor.is_bot
        # Tournament hands the turn to a team: any living human teammate may move.
        return any(not p.is_bot for p in self.game.eligible_actors())

    def _viewer(self) -> int:
        actor = self.actor
        if actor is not None and not actor.is_bot:
            return actor.id
        humans = [p.id for p in self.game.players if not p.is_bot]
        return humans[0] if humans else 0

    def on_show_view(self) -> None:
        self.layout()
        self.refresh_map()

    def layout(self) -> None:
        super().layout()
        self.chat_field = None
        self.typed_field = None
        timer = "no timer" if self.game.config.timer == "none" else self.game.config.timer
        self.draw_topbar(f"{self.game.config.map_preset} · {timer} · round {self.game.round}")
        self.button(WINDOW_W - 74, WINDOW_H - 12, 62, 30, "Menu", self._open_exit, font_size=11)
        self.button(WINDOW_W - 146, WINDOW_H - 12, 66, 30,
                    "Resume" if self.app.paused else "Pause", self._toggle_pause, font_size=11)
        self.button(WINDOW_W - 232, WINDOW_H - 12, 80, 30, "Rules",
                    lambda: self.app.show_panel("rules", self), font_size=11)

        if self.game.phase == "finished":
            self.button(80, 24, 200, 44, "Play again", self._replay, primary=True)
            self.button(296, 24, 200, 44, "Back to menu", self._exit)
        elif self.game.phase == "placement":
            self.button(80, 24, 320, 40, "Pick a country on the map", lambda: None, font_size=12)
        elif self.is_human_turn:
            self._layout_actions()
        else:
            self.button(80, 24, 260, 40, "Waiting for the bots…", lambda: None, font_size=12)

        if self.app.state.settings.live_chat:
            self.chat_field = TextField(MAP_AREA_W + 16, 96, 230, 30, "", "Message…")
            self.widgets.append(self.chat_field)
            self.button(MAP_AREA_W + 254, 96, 86, 30, "Send", self._send_chat, font_size=11)
            self.button(MAP_AREA_W + 254, 62, 86, 28,
                        "Global" if self.chat_tab == "global" else "Team", self._toggle_chat_tab, font_size=10)

        if self.confirm_exit:
            cx = WINDOW_W / 2
            if not self.leave_confirm:
                self.button(cx - 330, 300, 200, 46, "Save & exit", self._save_exit, primary=True)
                self.button(cx - 110, 300, 200, 46, "Leave game", self._leave_exit)
                self.button(cx + 110, 300, 200, 46, "Cancel", self._cancel_exit)
            else:
                self.button(cx - 210, 300, 200, 46, "Yes, leave", self._leave_exit, primary=True)
                self.button(cx + 10, 300, 200, 46, "Keep playing", self._cancel_exit)

    def _layout_actions(self) -> None:
        y = 24
        if self.mode == "idle":
            self.button(60, y, 140, 44, "Peace", self._choose_peace)
            self.button(210, y, 170, 44, "Gather Troops", self._choose_gather)
            self.button(390, y, 160, 44, "Expand", self._choose_expand, primary=True)
            self.button(560, y, 140, 44, "Nothing", self._choose_nothing)
        elif self.mode == "peace":
            self.button(60, y, 160, 44, "Cancel", self._cancel_mode)
        elif self.mode == "expand":
            max_troops = 1
            if self.from_id:
                max_troops = max(1, self.game.territories[self.from_id].troops - 1)
            self.button(60, y, 120, 44, "Cancel", self._cancel_mode)
            self.button(190, y, 110, 44, "<", lambda: self._bump_send(-1), font_size=14)
            self.button(310, y, 110, 44, f"{self.send_troops}", lambda: None, font_size=14,
                        hint=f"of {max_troops}")
            self.button(430, y, 110, 44, ">", lambda: self._bump_send(1), font_size=14)
            # Typed orders are mandatory: spell the destination country exactly.
            self.typed_field = TextField(60, 84, 300, 30, "", "Type the destination country")
            self.widgets.append(self.typed_field)
            # Typed orders are mandatory — unless the target's name was never shown.
            typed_required = bool(self.to_id and self.game.can_see_name(self._viewer(), self.to_id))
            typed_ok = bool(self.typed_field.value.strip()) or not typed_required
            self.button(560, y, 200, 44, "Send troops" if self.to_id else "Pick a target",
                        self._do_expand, primary=bool(self.to_id),
                        enabled=bool(self.from_id and self.to_id and typed_ok))
        elif self.mode == "gather":
            total = sum(self.distribution.values())
            self.button(60, y, 130, 44, "Cancel", self._cancel_mode)
            self.button(200, y, 250, 44, f"Confirm {total} troops (${total * TROOP_COST})",
                        self._confirm_gather, primary=True,
                        enabled=1 <= total <= self.game.gather_cap and total * TROOP_COST <= self.actor.money)
            self.button(460, y, 200, 44, "Spread one each", self._spread_gather)

    # -------------------------------------------------------------- lifecycle
    def _exit(self) -> None:
        self.app.show_menu()

    # ---------------------------------------------------------- exit / resume
    def _open_exit(self) -> None:
        self.confirm_exit = True
        self.leave_confirm = False
        self.app.paused = True
        self.layout()

    def _cancel_exit(self) -> None:
        self.confirm_exit = False
        self.leave_confirm = False
        self.app.paused = False
        self.layout()

    def _leave_exit(self) -> None:
        if not self.leave_confirm:
            self.leave_confirm = True
            self.layout()
            return
        self.confirm_exit = False
        self.app.paused = False
        self.app.show_menu()

    def _save_exit(self) -> None:
        snapshot = {
            "id": str(int(_time.time() * 1000)),
            "saved_at": _dt.datetime.now().isoformat(timespec="seconds"),
            "mode": self.game.config.mode,
            "map_preset": self.game.config.map_preset,
            "preset": self.game.config.preset,
            "round": self.game.round,
            "phase": self.game.phase,
            "alive_count": self.game.count_alive(),
            "player_count": len(self.game.players),
            "engine": self.game.to_dict(),
        }
        self.app.state.save_game(snapshot)
        self.confirm_exit = False
        self.app.paused = False
        self.app.notify("Game saved — resume it from the menu whenever you like.")
        self.app.show_menu()

    def _toggle_pause(self) -> None:
        self.app.paused = not self.app.paused
        self.layout()

    def _replay(self) -> None:
        self.app.start_game(self.game.config, [p.name for p in self.game.players])

    def on_update(self, delta_time: float) -> None:
        if self.app.paused:
            return
        self.game.tick()
        if self.auto_bots and self.game.phase != "finished":
            self.turn_clock += delta_time
            sim = self.game.config.mode == "offline-sim"
            delay = 0.03 if sim else self.app.state.settings.bot_delay
            steps = 40 if sim else 1
            if self.turn_clock >= delay:
                self.turn_clock = 0.0
                for _ in range(steps):
                    actor = self.actor
                    if actor is None or not actor.is_bot:
                        break
                    bot_act(self.game)
        self._drain_log()
        if self._map_dirty:
            self.refresh_map()
        if self.game.phase == "finished" and not self._finished:
            self._finish()

    def _drain_log(self) -> None:
        if len(self.game.log) <= self._log_len:
            self._log_len = len(self.game.log)
            return
        for event in self.game.log[self._log_len:]:
            name = EVENT_SFX.get(event.type)
            if name:
                SFX.play(name)
            if self.app.state.settings.live_chat and event.text:
                team = event.marker_teams[0] if event.marker_teams else None
                self.chat.append({"name": "log", "body": self._redact(event.text), "team": team})
        self._log_len = len(self.game.log)
        self._map_dirty = True

    def _finish(self) -> None:
        self._finished = True
        game = self.game
        record = GameRecord(
            finished_at=_dt.datetime.now().isoformat(timespec="seconds"),
            mode=game.config.mode,
            map_preset=game.config.map_preset,
            winner=game.winner,
            rounds=game.round,
            standings=[{"id": p.id, "name": p.name, "score": p.score,
                        "territories": len(game.owned_by(p.id)), "is_bot": p.is_bot}
                       for p in game.players],
            score_events=[{"player": e.player, "key": e.key} for e in game.score_events],
            multiplier=score_multiplier(game.config),
        )
        self.app.state.record(record)
        self.showing_results = True
        self.layout()
        SFX.play("win")

    # -------------------------------------------------------------- map layer
    def _transform(self):
        scale = min((MAP_AREA_W - 24) / MAP_IMG_W,
                    (WINDOW_H - TOPBAR_H - ACTIONBAR_H - 24) / MAP_IMG_H)
        return scale, MAP_AREA_W / 2, ACTIONBAR_H + (WINDOW_H - TOPBAR_H - ACTIONBAR_H) / 2

    def refresh_map(self) -> None:
        game = self.game
        view = game.view_for(self._viewer())
        owners = {cid: view["visible"][cid]["owner"] for cid in game.active}
        vulnerable = {cid for cid in game.active if view["visible"][cid].get("vulnerable")}
        image = self.map.image(owners, [p.color for p in game.players],
                               selected=self.from_id, targets=self._targets(),
                               vulnerable=vulnerable)
        image.convert("RGB").save(self.texture_path)
        texture = arcade.load_texture(self.texture_path)
        scale, cx, cy = self._transform()
        if self.sprite is None:
            self.sprite = arcade.Sprite(texture, scale=scale)
            self.sprite.center_x = cx
            self.sprite.center_y = cy
        else:
            self.sprite.texture = texture
        self._map_dirty = False

    def _targets(self) -> set:
        if self.mode != "expand" or not self.from_id or not self.is_human_turn:
            return set()
        out = set()
        for lane in self.game.graph.adj.get(self.from_id, ()):
            quote = self.game.quote_expand(self.actor.id, self.from_id, lane.id, 1)
            if not isinstance(quote, str):
                out.add(lane.id)
        return out

    def _image_to_screen(self, px: float, py: float):
        if self.sprite is None:
            return px, py
        scale = self.sprite.scale
        left = self.sprite.center_x - MAP_IMG_W * scale / 2
        bottom = self.sprite.center_y - MAP_IMG_H * scale / 2
        return left + px * scale, bottom + (MAP_IMG_H - py) * scale

    def _screen_to_country(self, x: float, y: float) -> Optional[str]:
        if self.sprite is None:
            return None
        scale = self.sprite.scale
        left = self.sprite.center_x - MAP_IMG_W * scale / 2
        bottom = self.sprite.center_y - MAP_IMG_H * scale / 2
        img_x = (x - left) / scale
        img_y = MAP_IMG_H - (y - bottom) / scale
        if not (0 <= img_x <= MAP_IMG_W and 0 <= img_y <= MAP_IMG_H):
            return None
        return self.map.hit_test(img_x, img_y)

    # ------------------------------------------------------------ interaction
    def on_mouse_press(self, x: int, y: int, button: int, modifiers: int) -> None:
        for widget in reversed(self.widgets):
            if widget.enabled and widget.on_mouse_press(x, y, button):
                return
        cid = self._screen_to_country(x, y)
        if cid:
            self._click_country(cid)

    def _click_country(self, cid: str) -> None:
        game = self.game
        if game.phase == "finished" or not self.is_human_turn:
            SFX.play("error")
            return
        SFX.play("click")
        actor = self.actor
        if game.phase == "placement":
            ok, err = game.place_starting_country(actor.id, cid)
            self._set_error(None if ok else err)
            return
        if self.mode == "peace":
            if game.territories[cid].owner == actor.id:
                ok, err = game.submit_peace(cid)
                self._set_error(None if ok else err)
                if ok:
                    self._after_action()
            else:
                self._set_error("Peace must be declared in a country you own.")
            return
        if self.mode == "gather":
            if game.territories[cid].owner == actor.id:
                self.distribution[cid] = self.distribution.get(cid, 0) + 1
                self.layout()
            else:
                self._set_error("You can only reinforce countries you own.")
            return
        if self.mode == "idle":
            self.mode = "expand"
        if game.territories[cid].owner == actor.id:
            self.from_id = cid
            self.to_id = None
            self.send_troops = max(1, min(self.send_troops, max(1, game.territories[cid].troops - 1)))
            self._set_error(None)
            self.layout()
            self._map_dirty = True
            return
        if not self.from_id:
            self._set_error("Select one of your own countries first.")
            return
        if cid not in self._targets():
            self._set_error(f"{self._label(cid)} does not border {self._label(self.from_id)}.")
            return
        self.to_id = cid
        self._set_error(None)
        self.layout()
        self._map_dirty = True

    def _hidden_names(self) -> Dict[str, str]:
        return hidden_country_names(self.game, self._viewer())

    def _label(self, country_id: Optional[str]) -> str:
        """The name to show this viewer, or the placeholder."""
        if not country_id:
            return "—"
        if self.game.can_see_name(self._viewer(), country_id):
            country = geo.BY_ID.get(country_id)
            return country.name if country is not None else country_id
        return HIDDEN_NAME

    def _redact(self, text: str) -> str:
        return redact_country_names(text, self._hidden_names())

    def _set_error(self, message: Optional[str]) -> None:
        # Engine messages can name countries, so they are redacted for this viewer.
        self.error = self._redact(message) if message else ""
        if message:
            SFX.play("error")

    def _cancel_mode(self) -> None:
        self.mode = "idle"
        self.from_id = self.to_id = None
        self.distribution = {}
        self._set_error(None)
        self.layout()
        self._map_dirty = True

    def _choose_peace(self) -> None:
        self.mode = "peace"
        self.layout()

    def _choose_gather(self) -> None:
        ok, err = self.game.choose_action("gather")
        if ok:
            self.mode = "gather"
            self.distribution = {}
        self._set_error(None if ok else err)
        self.layout()

    def _choose_expand(self) -> None:
        self.mode = "expand"
        self.layout()

    def _choose_nothing(self) -> None:
        self.game.submit_nothing()
        self._after_action()

    def _bump_send(self, delta: int) -> None:
        if not self.from_id:
            return
        maximum = max(1, self.game.territories[self.from_id].troops - 1)
        self.send_troops = max(1, min(maximum, self.send_troops + delta))
        self.layout()

    def _do_expand(self) -> None:
        if not self.from_id or not self.to_id:
            return
        typed = (self.typed_field.value if self.typed_field else "").strip()
        if not typed and self.game.can_see_name(self._viewer(), self.to_id):
            self._set_error("Type the destination country's name to expand.")
            return
        ok, err = self.game.submit_expand(self.from_id, self.to_id, self.send_troops, typed)
        self._set_error(None if ok else err)
        if ok:
            self._after_action()

    def _spread_gather(self) -> None:
        self.distribution = {t.id: 1 for t in self.game.owned_by(self.actor.id)}
        self.layout()

    def _confirm_gather(self) -> None:
        ok, err = self.game.submit_gather(self.distribution)
        self._set_error(None if ok else err)
        if ok:
            self._after_action()

    def _after_action(self) -> None:
        self.mode = "idle"
        self.from_id = self.to_id = None
        self.distribution = {}
        self.turn_clock = 0.0
        self._map_dirty = True
        self.layout()

    def _toggle_chat_tab(self) -> None:
        self.chat_tab = "team" if self.chat_tab == "global" else "global"
        self.layout()

    def _send_chat(self) -> None:
        if self.chat_field and self.chat_field.value.strip():
            actor = self.actor
            self.chat.append({
                "name": actor.name if actor else "host",
                "body": self.chat_field.value.strip(),
                "team": None if self.chat_tab == "global" else (actor.team if actor else 0),
            })
            self.chat_field.value = ""
        self.layout()

    # ------------------------------------------------------------------ draw --
    def on_draw(self) -> None:
        self.clear()
        timer = "no timer" if self.game.config.timer == "none" else self.game.config.timer
        self.draw_topbar(f"{self.game.config.map_preset} · {timer} · round {self.game.round}")
        if self.sprite is not None:
            arcade.draw_sprite(self.sprite)
            self._draw_outlines()
            self._draw_map_labels()
        self._draw_action_bar()
        self._draw_side_panel()
        for widget in self.widgets:
            widget.draw()
        self._draw_results()
        self._draw_exit_dialog()

    def _draw_outlines(self) -> None:
        for cid, color, width in ((self.from_id, theme.SELECTED_OUTLINE, 3),
                                  (self.to_id, theme.TARGET, 3)):
            if not cid:
                continue
            pts = self.map.outline(cid)
            if len(pts) < 3:
                continue
            screen = [self._image_to_screen(x, y) for x, y in pts]
            for i in range(len(screen)):
                x1, y1 = screen[i]
                x2, y2 = screen[(i + 1) % len(screen)]
                arcade.draw_line(x1, y1, x2, y2, color, width)
        for cid in self._targets():
            pts = self.map.outline(cid)
            if len(pts) < 3:
                continue
            screen = [self._image_to_screen(x, y) for x, y in pts]
            for i in range(len(screen)):
                x1, y1 = screen[i]
                x2, y2 = screen[(i + 1) % len(screen)]
                arcade.draw_line(x1, y1, x2, y2, theme.TARGET, 1)

    def _draw_map_labels(self) -> None:
        view = self.game.view_for(self._viewer())
        if self.app.state.settings.show_troop_counts:
            for cid in self.game.active:
                troops = view["visible"][cid]["troops"]
                if troops is None:
                    continue
                point = self.map.centroid(cid)
                if not point:
                    continue
                sx, sy = self._image_to_screen(*point)
                if 0 <= sx <= MAP_AREA_W:
                    draw_label(str(troops), sx, sy, 11, theme.TEXT, anchor_x="center",
                               anchor_y="center", bold=True)
        for marker in view["markers"]:
            point = self.map.centroid(marker["territory"])
            if not point:
                continue
            sx, sy = self._image_to_screen(*point)
            if not (0 <= sx <= MAP_AREA_W):
                continue
            color = "#ffffff"
            if 0 <= marker["team"] < len(self.game.players):
                color = self.game.players[marker["team"]].color
            draw_label("!", sx + 14, sy + 12, 16, theme.hex_to_rgb(color),
                       anchor_x="center", anchor_y="center", bold=True)

    def _draw_action_bar(self) -> None:
        arcade.draw_lbwh_rectangle_filled(0, 0, MAP_AREA_W, ACTIONBAR_H, theme.PANEL_DARK)
        arcade.draw_line(0, ACTIONBAR_H, MAP_AREA_W, ACTIONBAR_H, theme.LINE, 1)
        actor = self.actor
        if actor is None:
            return
        continents = ", ".join(self.game.full_continents(actor.id)) or "no continent"
        draw_label(f"{actor.name} — ${actor.money} · {len(self.game.owned_by(actor.id))} countries · {continents}",
                   16, ACTIONBAR_H - 10, 13, theme.TEXT, bold=True)
        if self.game.turn_deadline is not None:
            remaining = max(0, int(self.game.turn_deadline - _time.time()))
            draw_label(f"{remaining // 60}:{remaining % 60:02d}", MAP_AREA_W - 16, ACTIONBAR_H - 12,
                       18, theme.BAD if remaining < 15 else theme.TEXT, anchor_x="right", bold=True)
        hint = ""
        if self.mode == "gather":
            hint = (f"Gather: buy 1–{self.game.gather_cap} troops (cap is a fresh random(1,20) draw), "
                    f"${TROOP_COST} each — click your countries on the map or use the map list.")
        elif self.mode == "expand":
            hint = "Select one of your countries, then a bordering country you do not own."
            if self.from_id and self.to_id:
                quote = self.game.quote_expand(self.actor.id, self.from_id, self.to_id, self.send_troops)
                if not isinstance(quote, str):
                    kind = ("land border" if quote.water is None
                            else "body of water ($100)" if quote.water == "sea"
                            else "major ocean ($50/troop)")
                    hint = (f"{self._label(self.from_id)} → {self._label(self.to_id)}: {kind} · "
                            f"{quote.km} km · {self.send_troops} troops = ${quote.total}")
        elif self.mode == "peace":
            hint = ("Peace: the chosen country is vulnerable until your next turn, when you collect $100 per "
                    "territory plus $10 × countries in every continent you fully own.")
        elif self.game.phase == "placement":
            hint = "Every player picks any country before the first turn; it starts with 1 troop."
        elif not self.is_human_turn:
            hint = "Bots are moving…"
        draw_label(hint, 16, ACTIONBAR_H - 36, 11, theme.MUTED)
        if self.error:
            draw_label(self.error, 16, 10, 11, theme.BAD)
        if self.game.log:
            draw_label(self._redact(self.game.log[-1].text), MAP_AREA_W - 16, 10, 11, theme.MUTED, anchor_x="right")

    def _draw_side_panel(self) -> None:
        x = MAP_AREA_W
        arcade.draw_lbwh_rectangle_filled(x, 0, SIDE_W, WINDOW_H - TOPBAR_H, theme.PANEL_DARK)
        arcade.draw_line(x, 0, x, WINDOW_H - TOPBAR_H, theme.LINE, 1)
        y = WINDOW_H - TOPBAR_H - 14
        draw_label("Players", x + 16, y, 12, theme.MUTED)
        y -= 20
        actor = self.actor
        for player in self.game.players:
            color = theme.hex_to_rgb(player.color) if player.alive else (70, 80, 92)
            arcade.draw_circle_filled(x + 22, y - 8, 6, color)
            name = player.name + (" [bot]" if player.is_bot else "")
            if self.game.config.tournament:
                name += f" (T{player.team + 1})"
            draw_label(name, x + 36, y - 2, 12,
                       theme.TEXT if player.alive else theme.MUTED, anchor_y="center")
            draw_label(f"${player.money} · {len(self.game.owned_by(player.id))} · {player.score} pts",
                       x + SIDE_W - 16, y - 2, 10, theme.MUTED, anchor_x="right", anchor_y="center")
            if actor is not None and player.id == actor.id:
                arcade.draw_lbwh_rectangle_outline(x + 12, y - 18, SIDE_W - 24, 22, theme.ACCENT, 1)
            y -= 24

        y -= 10
        draw_label(f"Turn log — round {self.game.round} · {self.game.count_alive()} alive",
                   x + 16, y, 12, theme.MUTED)
        y -= 18
        arcade.draw_lbwh_rectangle_filled(x + 12, y - 186, SIDE_W - 24, 186, theme.BACKGROUND)
        ly = y - 8
        for line in [self._redact(e.text) for e in self.game.log if e.text][-10:]:
            draw_label(line[:46], x + 18, ly, 10, theme.TEXT)
            ly -= 17
        y -= 200

        if self.app.state.settings.live_chat:
            draw_label(f"Chat — {self.chat_tab}", x + 16, y, 12, theme.MUTED)
            y -= 16
            arcade.draw_lbwh_rectangle_filled(x + 12, y - 118, SIDE_W - 24, 118, theme.BACKGROUND)
            my_team = self.game.players[self._viewer()].team
            visible = [m for m in self.chat if m["team"] is None or m["team"] == my_team]
            ly = y - 8
            for msg in visible[-6:]:
                draw_label(f"{msg['name']}: {msg['body']}"[:48], x + 18, ly, 10, theme.TEXT)
                ly -= 17

    def _draw_exit_dialog(self) -> None:
        if not self.confirm_exit:
            return
        w, h = 780, 230
        x = (WINDOW_W - w) / 2
        y = (WINDOW_H + h) / 2
        arcade.draw_lbwh_rectangle_filled(x, y - h, w, h, theme.PANEL)
        arcade.draw_lbwh_rectangle_outline(x, y - h, w, h, theme.ACCENT, 2)
        draw_label("Exit game", x + w / 2, y - 34, 22, theme.TEXT, anchor_x="center", bold=True)
        if not self.leave_confirm:
            draw_label("Save your progress and resume from the menu later, or leave the game for good.",
                       x + w / 2, y - 74, 13, theme.MUTED, anchor_x="center")
        else:
            draw_label("Leave without saving? This game will be lost and cannot be resumed.",
                       x + w / 2, y - 74, 13, theme.MUTED, anchor_x="center")

    def _draw_results(self) -> None:
        if not self.showing_results or self.game.phase != "finished":
            return
        w, h = 640, 440
        x = (WINDOW_W - w) / 2
        y = (WINDOW_H + h) / 2 - 30
        arcade.draw_lbwh_rectangle_filled(x, y - h, w, h, theme.PANEL)
        arcade.draw_lbwh_rectangle_outline(x, y - h, w, h, theme.ACCENT, 2)
        winner = self.game.winner
        title = "Draw" if winner is None else f"{self.game.players[winner].name} wins!"
        draw_label(title, x + w / 2, y - 30, 22, theme.TEXT, anchor_x="center", bold=True)
        draw_label(f"Game over after {self.game.round} rounds",
                   x + w / 2, y - 62, 11, theme.MUTED, anchor_x="center")
        draw_label("Player", x + 72, y - 92, 10, theme.MUTED)
        draw_label("Countries", x + 430, y - 92, 10, theme.MUTED)
        draw_label("Score", x + w - 28, y - 92, 10, theme.MUTED, anchor_x="right")
        ly = y - 116
        for i, player in enumerate(sorted(self.game.players, key=lambda p: p.score, reverse=True)):
            draw_label(f"{i + 1}.", x + 28, ly, 12, theme.MUTED)
            arcade.draw_circle_filled(x + 58, ly - 6, 6, theme.hex_to_rgb(player.color))
            draw_label(player.name + (" [bot]" if player.is_bot else ""), x + 72, ly, 13, theme.TEXT)
            draw_label(str(len(self.game.owned_by(player.id))), x + 430, ly, 12, theme.MUTED)
            draw_label(str(player.score), x + w - 28, ly, 13, theme.TEXT, anchor_x="right")
            ly -= 26
        rules = self.game.config.scoring
        draw_label(f"Scoring in force — claim {rules.claim_unoccupied} · occupied {rules.claim_occupied} · "
                   f"continent {rules.claim_continent} · win {rules.win_game} · lose {rules.lose_game} "
                   f"(x{score_multiplier(self.game.config):g})",
                   x + 20, y - h + 28, 10, theme.MUTED)


RULEBOOK: List[tuple] = [
    ("General", [
        "Win condition: be the last player alive on the map (the last team alive in Tournament mode).",
        "Starting money: $500.",
        "Before the first turn every player picks any country; it is highlighted in their colour and starts with 1 troop.",
        "Leaving and resuming: exit a game with Save & exit to keep it for later (the menu shows a Resume button), "
        "or Leave game (with a confirmation) to abandon it for good. There is no online play in the desktop client.",
    ]),
    ("Your turn — pick one of four actions", [
        "1. Peace — at the beginning of your next turn you collect $100 per territory you own, plus $10 × countries in "
        "the continent for every continent you fully own. The country you declare Peace in is vulnerable until your next turn.",
        "2. Gather Troops — distribute X troops across your countries, where X is your choice between 1 and a fresh "
        "random(1,20) draw. Each troop costs $50.",
        "3. Expand — pick a country you own, then a country you do not. Pay $100 to send up to one less than all of the "
        "troops on the first country. Add $100 crossing a body of water, and $50 per troop crossing a major ocean. Every "
        "troop has a 1-in-10 chance of dying on a water journey. You cannot expand through other countries. Typed "
        "orders are mandatory — spell the destination country exactly; a mis-spelling loses your turn.",
        "    · Unoccupied target: claim it.",
        "    · Vulnerable target: kill all occupants and take it.",
        "    · Non-vulnerable target: every troop on both sides rolls 1–20; the highest total takes the country and all "
        "opposing troops die.",
        "4. Nothing — do nothing; your countries are not vulnerable.",
    ]),
    ("Turn timers", [
        "Miss your deadline and you are kicked: every territory you own is removed from the map.",
        "Classic Mode: global and team chat. Timers: Disabled (Normal), 1d (Daily), 10min (Rapid), 5min (Blitz), 1min "
        "(Bullet). Max 1 player per team, 12 teams.",
        "Tournament Mode: team chat only. Timers: 1d, 10min, 5min. Max 3 players per team, 4 teams.",
    ]),
    ("Modifiers", [
        "Fog of War (score x1.5) — only your own countries and their troops are visible; a brief “!” in a team's colour "
        "appears over a country when something involving that team happens there.",
        "Blindfold (score x2) — no country information at all, only the “!” markers.",
    ]),
    ("Scoring", [
        "Your global score is the sum of all of your scores; the leaderboard ranks by global score.",
        "Claim an unoccupied country +50 · lose a country −50 · claim a previously occupied country +75 · fail to win a "
        "country −20 · claim a continent +200 · win a game +500 · lose a game −200.",
        "Point values are fixed in code; players never edit them. Only a server operator can recalculate the board "
        "from a different set of calculations.",
    ]),
    ("Selectable continents", [f"{label} — {blurb}" for _id, label, blurb in geo.MAP_PRESETS]),
]


class PanelView(ViewBase):
    def __init__(self, app: "GPDApp", panel: str, back: Optional[ViewBase] = None) -> None:
        super().__init__(app)
        self.panel = panel
        self.back_view = back
        self.username_field: Optional[TextField] = None
        self.password_field: Optional[TextField] = None
        self.friends_field: Optional[TextField] = None
        self.scroll = 0.0

    def layout(self) -> None:
        super().layout()
        self.draw_topbar(self.panel.title(), self._back)
        if self.panel == "settings":
            s = self.app.state.settings
            self.widgets.append(Selector(80, WINDOW_H - 130, 380, 62, "Frame rate",
                                         [("60", "60 FPS"), ("30", "30 FPS")],
                                         0 if s.fps == 60 else 1, self._set_fps))
            self.widgets.append(Slider(80, WINDOW_H - 216, 380, 40, "SFX volume", s.sfx_volume, 0.0, 1.0,
                                       self._set_volume, fmt=lambda v: f"{int(v * 100)}%"))
            self.widgets.append(Slider(80, WINDOW_H - 280, 380, 40, "Bot move delay", s.bot_delay, 0.1, 2.0,
                                       self._set_bot, fmt=lambda v: f"{v:.1f}s"))
            self.widgets.append(Toggle(80, WINDOW_H - 340, 380, 26, "Enable live chat", s.live_chat, self._set_chat))
            self.widgets.append(Toggle(80, WINDOW_H - 408, 380, 26, "Show troop counts on the map",
                                       s.show_troop_counts, self._set_counts))
            self.button(80, WINDOW_H - 452, 200, 40, "Test SFX", lambda: SFX.play("battle"))
            self.button(300, WINDOW_H - 452, 200, 40, "Reset to defaults", self._reset_settings)
        elif self.panel == "signin":
            self.username_field = TextField(80, WINDOW_H - 150, 380, 36, "", "Username")
            self.password_field = TextField(80, WINDOW_H - 200, 380, 36, "", "Password", password=True)
            self.widgets += [self.username_field, self.password_field]
            self.button(80, WINDOW_H - 252, 180, 40, "Sign in", self._sign_in, primary=True)
            self.button(276, WINDOW_H - 252, 184, 40, "Guest mode", self._guest)
        elif self.panel == "friends":
            self.friends_field = TextField(80, WINDOW_H - 150, 300, 34, "", "Search username")
            self.widgets.append(self.friends_field)
            self.button(396, WINDOW_H - 150, 160, 34, "Add friend", self._add_friend)
        elif self.panel == "resume":
            for i, row in enumerate(self.app.state.saved_meta()[:8]):
                top = WINDOW_H - 120 - i * 44
                self.button(820, top, 170, 32, "Resume",
                            lambda gid=row["id"]: self._resume_saved(gid), primary=True, font_size=11)
                self.button(1000, top, 150, 32, "Delete",
                            lambda gid=row["id"]: self._delete_saved(gid), font_size=11)

    def _back(self) -> None:
        if self.back_view is not None:
            self.app.show_view_direct(self.back_view)
        else:
            self.app.show_menu()

    def _set_fps(self, value: str) -> None:
        self.app.state.settings.fps = int(value)
        self.app.apply_fps()
        self.app.state.save()

    def _set_volume(self, value: float) -> None:
        self.app.state.settings.sfx_volume = value
        SFX.volume = value
        self.app.state.save()

    def _set_bot(self, value: float) -> None:
        self.app.state.settings.bot_delay = value
        self.app.state.save()

    def _set_chat(self, value: bool) -> None:
        self.app.state.settings.live_chat = value
        self.app.state.save()

    def _set_counts(self, value: bool) -> None:
        self.app.state.settings.show_troop_counts = value
        self.app.state.save()

    def _reset_settings(self) -> None:
        from .state import Settings
        self.app.state.settings = Settings()
        SFX.volume = self.app.state.settings.sfx_volume
        self.app.apply_fps()
        self.app.state.save()
        self.layout()

    def _sign_in(self) -> None:
        name = (self.username_field.value if self.username_field else "").strip()
        if len(name) < 3:
            self.app.notify("Usernames are at least 3 characters.")
            return
        self.app.state.profile.username = name
        self.app.state.save()
        self.app.notify("Signed in locally. Online accounts use the web client's Supabase sign-in.")
        self.app.show_menu()

    def _guest(self) -> None:
        self.app.state.profile.username = "Guest"
        self.app.state.save()
        self.app.show_menu()

    def _add_friend(self) -> None:
        self.app.notify("Friend requests need an online account — use the web client for those.")

    def _resume_saved(self, game_id: str) -> None:
        snapshot = self.app.state.get_saved(game_id)
        if not snapshot:
            self.app.notify("That saved game is no longer available.")
            self.layout()
            return
        game = GPDGame.from_dict(snapshot["engine"])
        self.app.state.delete_saved(game_id)
        self.app.resume_game(game)

    def _delete_saved(self, game_id: str) -> None:
        self.app.state.delete_saved(game_id)
        self.app.notify("Saved game deleted.")
        self.layout()

    def on_mouse_scroll(self, x, y, sx, sy) -> None:
        self.scroll = max(0.0, self.scroll - sy * 40)
        super().on_mouse_scroll(x, y, sx, sy)

    def on_draw(self) -> None:
        self.clear()
        self.draw_topbar(self.panel.title(), self._back)
        if self.panel == "rules":
            self._draw_rulebook()
        elif self.panel == "stats":
            self._draw_stats()
        elif self.panel == "leaderboard":
            self._draw_leaderboard()
        elif self.panel == "mygames":
            self._draw_my_games()
        elif self.panel == "resume":
            self._draw_resume()
        elif self.panel == "signin":
            self._draw_signin()
        elif self.panel in ("friends", "notifications"):
            self._draw_online_notice()
        elif self.panel == "settings":
            draw_label("Settings apply immediately and are stored in ~/.gpd/desktop-state.json "
                       "(or $GPD_DATA_DIR).", 80, WINDOW_H - 112, 11, theme.MUTED)
        for widget in self.widgets:
            widget.draw()

    def _draw_rulebook(self) -> None:
        y = WINDOW_H - 112 + self.scroll
        for title, lines in RULEBOOK:
            draw_label(title, 80, y, 15, theme.TEXT, bold=True)
            y -= 24
            for line in lines:
                draw_label(line[:120], 96, y, 12, theme.MUTED)
                y -= 18
            y -= 12

    def _draw_stats(self) -> None:
        stats = self.app.state.stats()
        x = 80
        for label, key in (("Games played", "games"), ("Wins", "wins"),
                           ("Losses", "losses"), ("Total points", "points")):
            draw_panel(x, WINDOW_H - 130, 200, 84)
            draw_label(str(stats[key]), x + 16, WINDOW_H - 160, 24, theme.TEXT, bold=True)
            draw_label(label, x + 16, WINDOW_H - 116, 11, theme.MUTED)
            x += 216
        draw_label("Recent games", 80, WINDOW_H - 186, 14, theme.TEXT, bold=True)
        y = WINDOW_H - 216
        for game in self.app.state.games[:14]:
            winner = next((e.get("name", "?") for e in game.standings if e.get("id") == game.winner), "draw")
            draw_label(f"{game.finished_at}   {game.mode:<16} {game.map_preset:<15} winner: {winner}"
                       f"   ({game.rounds} rounds)", 80, y, 12, theme.MUTED)
            y -= 20

    def _draw_leaderboard(self) -> None:
        draw_label("Global score — the sum of every game's points", 80, WINDOW_H - 112, 14,
                   theme.TEXT, bold=True)
        y = WINDOW_H - 144
        rows = self.app.state.leaderboard
        if not rows:
            draw_label("Nothing ranked yet — finish a game with a human seat.", 80, y, 12, theme.MUTED)
        for i, row in enumerate(rows[:18]):
            draw_label(f"{i + 1}.", 80, y, 12, theme.MUTED)
            draw_label(row["name"], 112, y, 12, theme.TEXT)
            draw_label(str(row["score"]), 440, y, 12, theme.TEXT, anchor_x="right")
            y -= 20
        draw_label("Bots are never ranked. Scoring is fixed by the rules engine and players cannot edit "
                   "point values; only a server operator can recalculate the leaderboard from a different set "
                   "of calculations (see tools/admin-recalc.mjs).",
                   760, WINDOW_H - 108, 11, theme.MUTED)

    def _draw_resume(self) -> None:
        draw_label("Paused games — resume exactly where you left off (same dice, fresh turn clock).",
                   80, WINDOW_H - 112, 13, theme.TEXT, bold=True)
        rows = self.app.state.saved_meta()
        y = WINDOW_H - 150
        if not rows:
            draw_label("No saved games yet. Use “Save & exit” in a game to keep it for later.",
                       80, y, 12, theme.MUTED)
            return
        for row in rows[:8]:
            draw_label(f"{row['saved_at']}   {str(row['map_preset']):<12} {str(row['mode']):<15} "
                       f"{str(row['preset']):<10} round {row['round']}   {row['alive_count']}/{row['player_count']} alive",
                       80, y, 12, theme.MUTED)
            y -= 44

    def _draw_my_games(self) -> None:
        draw_label(f"{len(self.app.state.games)} games on this machine", 80, WINDOW_H - 112, 14,
                   theme.TEXT, bold=True)
        y = WINDOW_H - 144
        for game in self.app.state.games[:20]:
            winner = next((e.get("name", "?") for e in game.standings if e.get("id") == game.winner), "draw")
            draw_label(f"{game.finished_at}   {game.mode:<16} {game.map_preset:<15} winner: {winner}",
                       80, y, 12, theme.MUTED)
            y -= 20

    def _draw_online_notice(self) -> None:
        lines = [
            "Sign in with an email address, a username and a password to play online, keep a leaderboard profile,",
            "and receive notifications. Those features run against Supabase and are implemented in the web",
            "client, which shares this exact rules engine, map data and scoring rules:",
            "",
            "    gpd/                     TypeScript + React web client (online multiplayer, chat, leaderboard, friends)",
            "    supabase/schema.sql      SQL schema, row-level security and score-recalculation functions",
            "",
            "This desktop client covers the offline modes: singleplayer against 1–12 bots, hot-seat multiplayer",
            "for up to 12 players, and full simulation with bots only.",
        ]
        y = WINDOW_H - 124
        for line in lines:
            draw_label(line, 80, y, 13, theme.MUTED)
            y -= 24

    def _draw_signin(self) -> None:
        draw_label("An email address, a username and a password are required for online games; every offline "
                   "mode works without an account.", 80, WINDOW_H - 112, 11, theme.MUTED)
        draw_label("Online sign-in (Supabase auth) lives in the web client — see Friends for the details.",
                   80, WINDOW_H - 330, 11, theme.WARN)
