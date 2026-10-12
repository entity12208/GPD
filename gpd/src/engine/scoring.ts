import { DEFAULT_SCORING, type ScoringRules, type ScoreEvent, type GameConfig } from './types';

export { DEFAULT_SCORING };

export function scoreMultiplier(cfg: Pick<GameConfig, 'fogOfWar' | 'blindfold'>): number {
  if (cfg.blindfold) return 2;
  if (cfg.fogOfWar) return 1.5;
  return 1;
}

/**
 * Points are always derived from the recorded score events, so the whole
 * leaderboard can be recalculated from a different rule set at any time.
 */
export function calculateScore(
  events: ScoreEvent[],
  player: number,
  rules: ScoringRules = DEFAULT_SCORING,
  multiplier = 1,
): number {
  let total = 0;
  for (const e of events) {
    if (e.player !== player) continue;
    total += rules[e.key] ?? 0;
  }
  return Math.round(total * multiplier);
}

export function recalculate(
  events: ScoreEvent[],
  players: number,
  rules: ScoringRules = DEFAULT_SCORING,
  multiplier = 1,
): Record<number, number> {
  const out: Record<number, number> = {};
  for (let p = 0; p < players; p++) out[p] = calculateScore(events, p, rules, multiplier);
  return out;
}
