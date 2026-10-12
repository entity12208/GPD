"""The same mulberry32 PRNG the web client uses, so a seed produces the same
game on both clients."""

MASK = 0xFFFFFFFF


def _to_i32(x: int) -> int:
    x &= MASK
    return x - 0x100000000 if x >= 0x80000000 else x


def _imul(a: int, b: int) -> int:
    """Emulate Math.imul: 32-bit signed multiplication."""
    return _to_i32(a * b)


class RNG:
    """Deterministic PRNG (mulberry32)."""

    def __init__(self, seed: int = 1) -> None:
        self.s = seed & MASK

    def next(self) -> float:
        self.s = (self.s + 0x6D2B79F5) & MASK
        t = self.s
        t = _imul(t ^ (t >> 15), t | 1)
        inner = _imul(t ^ ((t & MASK) >> 7), t | 61)
        t = _to_i32(t ^ (t + inner))
        t &= MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296

    def int(self, low: int, high: int) -> int:
        """Inclusive integer in [low, high]."""
        return low + int(self.next() * (high - low + 1))

    def choice(self, seq):
        return seq[int(self.next() * len(seq))]

    def shuffled(self, seq):
        items = list(seq)
        for i in range(len(items) - 1, 0, -1):
            j = int(self.next() * (i + 1))
            items[i], items[j] = items[j], items[i]
        return items
