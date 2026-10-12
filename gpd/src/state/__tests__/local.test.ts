import { describe, expect, it } from 'vitest';
import { localLeaderboard, computeStats } from '../local';
import type { GameResult } from '../../ui/GameScreen';

function result(over: Partial<GameResult> = {}): GameResult {
  return {
    mode: 'offline-solo', mapPreset: 'World', winner: 0, winningTeam: null, rounds: 5,
    standings: [
      { id: 0, name: 'Ada', score: 300, territories: 3, isBot: false },
      { id: 1, name: 'Bot 1', score: 900, territories: 0, isBot: true },
      { id: 2, name: 'Bot 2', score: 850, territories: 0, isBot: true },
    ],
    scoreEvents: [], multiplier: 1, finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('leaderboards', () => {
  it('never ranks bots, even when they would outscore humans', () => {
    const board = localLeaderboard([result()]);
    expect(board).toEqual([{ username: 'Ada', score: 300 }]);
    expect(board.some((r) => r.username.startsWith('Bot'))).toBe(false);
  });

  it('sums human scores across games and ignores all-bot games in career stats', () => {
    const board = localLeaderboard([result(), result({ finishedAt: '2026-02-01T00:00:00Z' })]);
    expect(board).toEqual([{ username: 'Ada', score: 600 }]);

    const allBots = result({
      winner: 1,
      standings: [
        { id: 0, name: 'Bot A', score: 100, territories: 0, isBot: true },
        { id: 1, name: 'Bot B', score: 200, territories: 0, isBot: true },
      ],
    });
    const stats = computeStats([result(), allBots], 'Ada');
    expect(stats.games).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.points).toBe(300);
  });
});
