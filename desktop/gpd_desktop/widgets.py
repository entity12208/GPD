"""Small immediate-mode style widgets drawn with Arcade primitives.

Keeping the HUD self-contained means the desktop client only depends on the
core Arcade drawing API (rectangles, lines and text).
"""

from __future__ import annotations

from typing import Callable, List, Optional, Sequence, Tuple

import arcade

from . import theme

Font = Tuple[str, ...]
DEFAULT_FONT: Font = ("calibri", "arial", "dejavusans")


def text_width(value: str, size: int = 12) -> float:
    return len(value) * size * 0.56


def draw_label(
    value: str,
    x: float,
    y: float,
    size: int = 12,
    color=theme.TEXT,
    anchor_x: str = "left",
    anchor_y: str = "top",
    bold: bool = False,
    font_name: Font = DEFAULT_FONT,
) -> None:
    """Draw a single line of text. (x, y) is the top-left corner by default."""
    arcade.draw_text(
        value, x, y, color, size,
        font_name=font_name, bold=bold,
        anchor_x=anchor_x, anchor_y=anchor_y,
    )


def draw_panel(x: float, y: float, w: float, h: float, fill=theme.PANEL,
               border=theme.LINE, radius: float = 0) -> None:
    """Panel with a top-left origin."""
    arcade.draw_lbwh_rectangle_filled(x, y - h, w, h, fill)
    arcade.draw_lbwh_rectangle_outline(x, y - h, w, h, border, 1)


def draw_divider(x: float, y: float, w: float, color=theme.LINE) -> None:
    arcade.draw_line(x, y, x + w, y, color, 1)


class Widget:
    def __init__(self, x: float, y: float, w: float, h: float) -> None:
        self.x, self.y, self.w, self.h = x, y, w, h
        self.enabled = True
        self.visible = True

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y - self.h <= py <= self.y

    def draw(self) -> None:  # pragma: no cover - drawing only
        raise NotImplementedError

    # event hooks; return True when the event was consumed
    def on_mouse_press(self, px: float, py: float, button: int) -> bool:
        return False

    def on_mouse_motion(self, px: float, py: float) -> bool:
        return False

    def on_mouse_scroll(self, px: float, py: float, dy: float) -> bool:
        return False

    def on_key(self, symbol: int, modifiers: int) -> bool:
        return False

    def on_text(self, value: str) -> bool:
        return False


class Button(Widget):
    def __init__(self, x, y, w, h, label: str, on_click: Callable[[], None],
                 primary: bool = False, danger: bool = False, font_size: int = 12,
                 hint: str = "", enabled: bool = True, visible: bool = True) -> None:
        super().__init__(x, y, w, h)
        self.label = label
        self.on_click = on_click
        self.primary = primary
        self.danger = danger
        self.font_size = font_size
        self.hint = hint
        self.enabled = enabled
        self.visible = visible
        self.hover = False
        self.active = False  # "selected" styling

    def draw(self) -> None:
        if not self.visible:
            return
        if not self.enabled:
            fill = theme.PANEL_DARK
        elif self.primary:
            fill = theme.ACCENT_DARK if self.hover else theme.ACCENT
        elif self.danger:
            fill = (170, 42, 34)
        elif self.active:
            fill = theme.PANEL_LIGHT
        else:
            fill = theme.PANEL_LIGHT if self.hover else theme.PANEL
        border = theme.ACCENT if self.active else theme.LINE
        arcade.draw_lbwh_rectangle_filled(self.x, self.y - self.h, self.w, self.h, fill)
        arcade.draw_lbwh_rectangle_outline(self.x, self.y - self.h, self.w, self.h, border, 1)
        color = theme.MUTED if not self.enabled else theme.TEXT
        draw_label(self.label, self.x + self.w / 2, self.y - self.h / 2, self.font_size,
                   color, anchor_x="center", anchor_y="center")
        if self.hint:
            draw_label(self.hint, self.x + self.w / 2, self.y - self.h - 3, 10,
                       theme.MUTED, anchor_x="center", anchor_y="top")

    def on_mouse_press(self, px, py, button) -> bool:
        if not self.visible or not self.enabled or not self.contains(px, py):
            return False
        self.on_click()
        return True

    def on_mouse_motion(self, px, py) -> bool:
        if not self.visible:
            return False
        self.hover = self.contains(px, py)
        return False


class Toggle(Widget):
    def __init__(self, x, y, w, h, label: str, value: bool,
                 on_change: Callable[[bool], None], note: str = "") -> None:
        super().__init__(x, y, w, h)
        self.label = label
        self.value = value
        self.on_change = on_change
        self.note = note

    def draw(self) -> None:
        draw_label(self.label, self.x, self.y - self.h / 2, 12, theme.TEXT, anchor_y="center")
        if self.note:
            draw_label(self.note, self.x, self.y - self.h / 2 + 14, 10, theme.MUTED, anchor_y="center")
        cx = self.x + self.w - 42
        cy = self.y - self.h / 2
        fill = theme.ACCENT if self.value else (38, 51, 63)
        arcade.draw_lbwh_rectangle_filled(cx, cy - 11, 42, 22, fill)
        arcade.draw_lbwh_rectangle_outline(cx, cy - 11, 42, 22, theme.LINE, 1)
        knob_x = cx + 32 if self.value else cx + 10
        arcade.draw_circle_filled(knob_x, cy, 8, theme.TEXT)

    def on_mouse_press(self, px, py, button) -> bool:
        if not self.contains(px, py):
            return False
        self.value = not self.value
        self.on_change(self.value)
        return True


class Slider(Widget):
    def __init__(self, x, y, w, h, label: str, value: float, low: float, high: float,
                 on_change: Callable[[float], None], fmt: Callable[[float], str] = str) -> None:
        super().__init__(x, y, w, h)
        self.label = label
        self.value = value
        self.low = low
        self.high = high
        self.on_change = on_change
        self.fmt = fmt
        self.dragging = False

    def _set_from(self, px: float) -> None:
        ratio = (px - self.x - 8) / max(1.0, self.w - 16)
        ratio = max(0.0, min(1.0, ratio))
        self.value = self.low + ratio * (self.high - self.low)
        self.on_change(self.value)

    def draw(self) -> None:
        draw_label(f"{self.label}: {self.fmt(self.value)}", self.x, self.y - 4, 12, theme.TEXT)
        track_y = self.y - self.h + 8
        arcade.draw_lbwh_rectangle_filled(self.x + 8, track_y - 2, self.w - 16, 4, (46, 60, 76))
        ratio = (self.value - self.low) / max(1e-6, self.high - self.low)
        knob_x = self.x + 8 + ratio * (self.w - 16)
        arcade.draw_lbwh_rectangle_filled(self.x + 8, track_y - 2, knob_x - self.x - 8, 4, theme.ACCENT)
        arcade.draw_circle_filled(knob_x, track_y, 7, theme.TEXT)

    def on_mouse_press(self, px, py, button) -> bool:
        if not self.contains(px, py):
            return False
        self.dragging = True
        self._set_from(px)
        return True

    def on_mouse_motion(self, px, py) -> bool:
        if self.dragging:
            self._set_from(px)
            return True
        return False

    def release(self) -> None:
        self.dragging = False


class TextField(Widget):
    def __init__(self, x, y, w, h, value: str = "", placeholder: str = "",
                 on_change: Optional[Callable[[str], None]] = None, password: bool = False) -> None:
        super().__init__(x, y, w, h)
        self.value = value
        self.placeholder = placeholder
        self.on_change = on_change
        self.password = password
        self.focused = False

    def draw(self) -> None:
        border = theme.ACCENT if self.focused else theme.LINE
        arcade.draw_lbwh_rectangle_filled(self.x, self.y - self.h, self.w, self.h, theme.PANEL_DARK)
        arcade.draw_lbwh_rectangle_outline(self.x, self.y - self.h, self.w, self.h, border, 1)
        shown = ("•" * len(self.value)) if self.password else self.value
        if shown:
            draw_label(shown, self.x + 10, self.y - self.h / 2, 13, theme.TEXT, anchor_y="center")
        elif self.placeholder:
            draw_label(self.placeholder, self.x + 10, self.y - self.h / 2, 13, theme.MUTED, anchor_y="center")
        if self.focused:
            cx = self.x + 12 + text_width(shown, 13)
            arcade.draw_line(cx, self.y - self.h + 7, cx, self.y - 7, theme.TEXT, 1)

    def on_mouse_press(self, px, py, button) -> bool:
        self.focused = self.contains(px, py)
        return self.focused

    def on_text(self, value: str) -> bool:
        if not self.focused:
            return False
        self.value += value
        if self.on_change:
            self.on_change(self.value)
        return True

    def on_key(self, symbol: int, modifiers: int) -> bool:
        if not self.focused:
            return False
        if symbol == arcade.key.BACKSPACE:
            self.value = self.value[:-1]
            if self.on_change:
                self.on_change(self.value)
            return True
        if symbol in (arcade.key.ENTER, arcade.key.TAB, arcade.key.ESCAPE):
            self.focused = False
            return True
        return False


class Selector(Widget):
    """Left/right option selector."""

    def __init__(self, x, y, w, h, label: str, options: Sequence[Tuple[str, str]],
                 index: int, on_change: Callable[[str], None]) -> None:
        super().__init__(x, y, w, h)
        self.label = label
        self.options = list(options)
        self.index = index
        self.on_change = on_change

    @property
    def value(self) -> str:
        return self.options[self.index][0]

    def draw(self) -> None:
        draw_label(self.label, self.x, self.y - 4, 11, theme.MUTED)
        top = self.y - 20
        arcade.draw_lbwh_rectangle_filled(self.x, top - self.h + 20, self.w, self.h - 20, theme.PANEL_DARK)
        arcade.draw_lbwh_rectangle_outline(self.x, top - self.h + 20, self.w, self.h - 20, theme.LINE, 1)
        draw_label(self.options[self.index][1], self.x + self.w / 2, top - (self.h - 20) / 2,
                   12, theme.TEXT, anchor_x="center", anchor_y="center")
        arcade.draw_lbwh_rectangle_filled(self.x, top - self.h + 20, 26, self.h - 20, theme.PANEL_LIGHT)
        arcade.draw_lbwh_rectangle_filled(self.x + self.w - 26, top - self.h + 20, 26, self.h - 20, theme.PANEL_LIGHT)
        draw_label("<", self.x + 13, top - (self.h - 20) / 2, 13, theme.TEXT, anchor_x="center", anchor_y="center")
        draw_label(">", self.x + self.w - 13, top - (self.h - 20) / 2, 13, theme.TEXT,
                   anchor_x="center", anchor_y="center")

    def _step(self, delta: int) -> None:
        self.index = (self.index + delta) % len(self.options)
        self.on_change(self.value)

    def on_mouse_press(self, px, py, button) -> bool:
        if not self.contains(px, py):
            return False
        mid = self.x + self.w / 2
        self._step(-1 if px < mid else 1)
        return True


class ListView(Widget):
    """Scrolling list with an optional action column."""

    def __init__(self, x, y, w, h, row_height: int = 26) -> None:
        super().__init__(x, y, w, h)
        self.rows: List[dict] = []
        self.row_height = row_height
        self.scroll = 0.0
        self.actions: List[Button] = []
        self.buttons: List[Button] = []

    def set_rows(self, rows: List[dict], actions: Optional[List[Button]] = None) -> None:
        self.rows = rows
        self.buttons = actions or []
        visible = self._visible_rows()
        for b in self.buttons:
            if b not in visible:
                b.visible = False

    def _visible_rows(self) -> List[Button]:
        return [b for b in self.buttons if b.visible]

    def sync_actions(self, build: Callable[[int, dict, float, float], List[Button]]) -> None:
        self.buttons = []
        for i, row in enumerate(self.rows):
            top = self.y - i * self.row_height + self.scroll
            if top < self.y - self.h or top - self.row_height > self.y:
                continue
            self.buttons.extend(build(i, row, self.x, top))

    def draw(self) -> None:
        for i, row in enumerate(self.rows):
            top = self.y - i * self.row_height + self.scroll
            if top < self.y - self.h or top - self.row_height > self.y:
                continue
            if i % 2 == 0:
                arcade.draw_lbwh_rectangle_filled(self.x, top - self.row_height, self.w, self.row_height, theme.PANEL_DARK)
            draw_label(str(row.get("label", "")), self.x + 8, top - self.row_height / 2, 12,
                       theme.TEXT, anchor_y="center")
            right = row.get("right")
            if right is not None:
                draw_label(str(right), self.x + self.w - 8, top - self.row_height / 2, 12,
                           theme.MUTED, anchor_x="right", anchor_y="center")
        for b in self.buttons:
            b.draw()

    def on_mouse_press(self, px, py, button) -> bool:
        if not self.contains(px, py):
            return False
        for b in self.buttons:
            if b.on_mouse_press(px, py, button):
                return True
        return True

    def on_mouse_scroll(self, px, py, dy) -> bool:
        if not self.contains(px, py):
            return False
        max_scroll = max(0.0, len(self.rows) * self.row_height - self.h)
        self.scroll = max(0.0, min(max_scroll, self.scroll - dy * 30))
        return True

    def on_mouse_motion(self, px, py) -> bool:
        for b in self.buttons:
            b.on_mouse_motion(px, py)
        return False
