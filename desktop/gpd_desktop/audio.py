"""Tiny synthesised sound effects (no bundled assets, no numpy)."""

from __future__ import annotations

import math
import os
import struct
import tempfile
import wave
from typing import Dict

TONES = {
    "click": (520, 0.05, "square"),
    "claim": (440, 0.12, "triangle"),
    "expand": (300, 0.16, "saw"),
    "battle": (140, 0.30, "saw"),
    "win": (523, 0.50, "triangle"),
    "lose": (220, 0.40, "sine"),
    "coin": (880, 0.10, "square"),
    "peace": (392, 0.35, "sine"),
    "error": (160, 0.18, "square"),
    "turn": (660, 0.12, "triangle"),
}


def _samples(freq: float, seconds: float, kind: str, rate: int = 22050):
    frames = int(rate * seconds)
    for i in range(frames):
        t = i / rate
        phase = 2 * math.pi * freq * t
        if kind == "square":
            value = 1.0 if math.sin(phase) >= 0 else -1.0
        elif kind == "saw":
            value = 2 * ((freq * t) % 1.0) - 1.0
        elif kind == "triangle":
            value = 2 * abs(2 * ((freq * t) % 1.0) - 1) - 1
        else:
            value = math.sin(phase)
        envelope = min(1.0, i / 200.0) * max(0.0, 1.0 - i / frames)
        yield int(max(-1.0, min(1.0, value * envelope)) * 12000)


class Sfx:
    """Volume-aware sound effects; silently no-ops without an audio device."""

    def __init__(self, volume: float = 0.5) -> None:
        self.volume = volume
        self.enabled = True
        self._sounds: Dict[str, object] = {}
        self._paths: Dict[str, str] = {}
        self._dir = tempfile.mkdtemp(prefix="gpd-sfx-")
        self._built = False

    def build_tone_files(self) -> None:
        """Render the effects to WAV files (works without an audio device)."""
        if self._paths:
            return
        for name, (freq, seconds, kind) in TONES.items():
            path = os.path.join(self._dir, f"{name}.wav")
            with wave.open(path, "wb") as fh:
                fh.setnchannels(1)
                fh.setsampwidth(2)
                fh.setframerate(22050)
                fh.writeframes(b"".join(struct.pack("<h", s) for s in _samples(freq, seconds, kind)))
            self._paths[name] = path

    def build(self) -> None:
        if self._built:
            return
        self._built = True
        self.build_tone_files()
        try:
            import arcade
        except Exception:  # pragma: no cover - arcade missing/headless
            self.enabled = False
            return
        for name, path in self._paths.items():
            try:
                self._sounds[name] = arcade.load_sound(path)
            except Exception:  # pragma: no cover
                self.enabled = False
                return

    def play(self, name: str) -> None:
        if not self.enabled or self.volume <= 0:
            return
        sound = self._sounds.get(name)
        if sound is None:
            return
        try:  # pragma: no cover - audio device dependent
            import arcade

            arcade.play_sound(sound, volume=self.volume)
        except Exception:
            pass


SFX = Sfx()
