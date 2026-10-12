"""Shared colours for the desktop client."""

OCEAN = (10, 20, 29)
BACKGROUND = (11, 16, 22)
PANEL = (24, 35, 47)
PANEL_DARK = (18, 26, 36)
PANEL_LIGHT = (32, 46, 61)
LINE = (36, 49, 63)
TEXT = (231, 238, 246)
MUTED = (142, 163, 184)
ACCENT = (47, 129, 247)
ACCENT_DARK = (31, 111, 235)
GOOD = (63, 185, 80)
BAD = (248, 81, 73)
WARN = (210, 153, 34)
TOP_BAR = (15, 22, 30)
HIGHLIGHT = (255, 213, 74)
TARGET = (126, 231, 135)
NEUTRAL_COUNTRY = (43, 59, 77)
BORDER = (12, 20, 28)
SELECTED_OUTLINE = (255, 213, 74)


def hex_to_rgb(value: str) -> tuple:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
