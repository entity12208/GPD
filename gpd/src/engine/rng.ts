/** Deterministic PRNG (mulberry32) so games can be replayed/verified from a seed. */
export class RNG {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0; }

  /** Snapshot the internal counter so a saved game resumes with identical rolls. */
  get state(): number { return this.s; }
  set state(value: number) { this.s = value >>> 0; }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inclusive integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }

  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
