"""Headless Arcade stub.

The desktop client cannot open a GL window in CI, so a minimal stand-in module
records every drawing call. That lets the tests drive the real views, the real
widgets and the real engine exactly as a player would.
"""

from __future__ import annotations

import sys
import types


class StubTexture:
    def __init__(self, source=None, **kw) -> None:
        self.source = source


class StubSprite:
    def __init__(self, texture=None, scale: float = 1.0, center_x: float = 0, center_y: float = 0,
                 **kw) -> None:
        self.texture = texture
        self.scale = scale
        self.center_x = center_x
        self.center_y = center_y


class StubView:
    def __init__(self, window=None, background_color=None) -> None:
        self.window = window
        self.background_color = background_color

    def clear(self, *args, **kwargs) -> None:
        pass

    def on_show_view(self) -> None:  # pragma: no cover - overridden
        pass


class StubWindow(StubView):
    def __init__(self, width: int = 1440, height: int = 900, title: str = "",
                 update_rate: float = 1 / 60, **kwargs) -> None:
        super().__init__()
        self.width, self.height, self.title = width, height, title
        self.update_rate = update_rate
        self.current_view = None

    def show_view(self, view) -> None:
        view.window = self
        self.current_view = view
        view.on_show_view()

    def set_update_rate(self, rate: float) -> None:
        self.update_rate = rate

    def run(self) -> None:
        pass

    def on_draw(self) -> None:
        if self.current_view is not None:
            self.current_view.on_draw()


def install_stub() -> types.ModuleType:
    module = sys.modules.get("arcade_stub_module")
    if module is not None:
        return module

    arcade = types.ModuleType("arcade")
    arcade.calls: list = []

    arcade.View = StubView
    arcade.Window = StubWindow
    arcade.Sprite = StubSprite
    arcade.draw_sprite = lambda sprite, **kw: arcade.calls.append(("draw_sprite", sprite))

    def record(name):
        def inner(*args, **kwargs):
            arcade.calls.append((name, args))
        return inner

    for name in ("draw_text", "draw_line", "draw_lbwh_rectangle_filled",
                 "draw_lbwh_rectangle_outline", "draw_circle_filled", "draw_polygon_filled",
                 "draw_polygon_outline", "draw_lrbt_rectangle_filled"):
        setattr(arcade, name, record(name))

    arcade.load_texture = lambda path, **kw: StubTexture(path)
    arcade.load_sound = lambda path, **kw: path
    arcade.play_sound = lambda sound, volume=1.0: arcade.calls.append(("play_sound", sound))
    arcade.get_window = lambda: None
    arcade.run = lambda: None

    key = types.SimpleNamespace()
    for index, name in enumerate(("BACKSPACE", "ENTER", "TAB", "ESCAPE", "SPACE")):
        setattr(key, name, 1000 + index)
    arcade.key = key

    color = types.SimpleNamespace(WHITE=(255, 255, 255), BLACK=(0, 0, 0), RED=(255, 0, 0))
    arcade.color = color

    sys.modules["arcade"] = arcade
    sys.modules["arcade_stub_module"] = arcade
    return arcade


install_stub()
