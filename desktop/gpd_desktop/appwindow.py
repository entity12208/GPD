"""The Arcade window and the view router.

Kept apart from :mod:`gpd_desktop.__main__` so the headless commands
(``--simulate``) work on machines with no display, OpenGL or audio device.
"""

from __future__ import annotations

import time
from typing import Optional, Sequence

import arcade

from .audio import SFX
from .engine import GameConfig
from .state import AppState
from .views import WINDOW_H, WINDOW_W, GameView, MenuView, PanelView, SetupView, ViewBase


class GPDApp(arcade.Window):
    """The application window; also the tiny router between views."""

    def __init__(self, state: Optional[AppState] = None) -> None:
        super().__init__(WINDOW_W, WINDOW_H, "GPD — Geo-Political Domination", update_rate=1 / 60)
        self.state = state or AppState.load()
        self.paused = False
        self.toast = ""
        self._toast_until = 0.0
        self._game_view: Optional[GameView] = None
        SFX.volume = self.state.settings.sfx_volume
        SFX.build()
        self.apply_fps()
        self.show_menu()

    # -------------------------------------------------------------- routing --
    def show_view_direct(self, view: arcade.View) -> None:
        self.show_view(view)

    def show_menu(self) -> None:
        self._game_view = None
        self.show_view(MenuView(self))

    def show_setup(self) -> None:
        self.show_view(SetupView(self))

    def show_panel(self, panel: str, back: Optional[ViewBase] = None) -> None:
        target_back = back if back is not None else self._game_view
        self.show_view(PanelView(self, panel, target_back))

    def start_game(self, config: GameConfig, names: Sequence[str]) -> None:
        view = GameView(self, config, names)
        self._game_view = view
        self.paused = False
        self.show_view(view)

    def resume_game(self, game) -> None:
        """Open a game rebuilt from a saved snapshot (see GPDGame.from_dict)."""
        view = GameView(self, game.config, [p.name for p in game.players], game=game)
        self._game_view = view
        self.paused = False
        self.show_view(view)

    def sign_out(self) -> None:
        self.state.profile.username = None
        self.state.save()
        self.show_menu()

    # ------------------------------------------------------------- settings --
    def apply_fps(self) -> None:
        self.set_update_rate(1 / (30 if self.state.settings.fps == 30 else 60))

    def notify(self, message: str, seconds: float = 3.5) -> None:
        self.toast = message
        self._toast_until = time.time() + seconds

    # --------------------------------------------------------------- events --
    def on_text(self, text: str) -> None:  # type: ignore[override]
        """Arcade views never receive ``on_text``; forward it to the current view."""
        handler = getattr(self.current_view, "on_text_input", None)
        if callable(handler):
            handler(text)

    def on_draw(self) -> None:
        super().on_draw()
        if self.toast and time.time() > self._toast_until:
            self.toast = ""

    @property
    def toast_text(self) -> str:
        if self.toast and time.time() <= self._toast_until:
            return self.toast
        return ""


__all__ = ["GPDApp"]
