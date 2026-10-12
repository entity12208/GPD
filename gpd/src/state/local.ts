import type { GameResult } from '../ui/GameScreen';

export interface LocalProfile {
  username: string;
  createdAt: string;
  /** Set when the account is backed by Supabase. */
  remoteId?: string;
}

export interface CareerStats {
  games: number;
  wins: number;
  losses: number;
  points: number;
  bestScore: number;
  countriesClaimed: number;
  continentsClaimed: number;
}

const PROFILE_KEY = 'gpd.profile.v1';
const GAMES_KEY = 'gpd.games.v1';

export function loadProfile(): LocalProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as LocalProfile) : null;
  } catch { return null; }
}

export function saveProfile(p: LocalProfile | null) {
  try {
    if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROFILE_KEY);
  } catch { /* ignore */ }
}

export function loadGames(): GameResult[] {
  try {
    const raw = localStorage.getItem(GAMES_KEY);
    return raw ? (JSON.parse(raw) as GameResult[]) : [];
  } catch { return []; }
}

export function recordGame(r: GameResult, localUsername: string | null): GameResult[] {
  const all = [r, ...loadGames()].slice(0, 100);
  try { localStorage.setItem(GAMES_KEY, JSON.stringify(all)); } catch { /* ignore */ }
  void localUsername;
  return all;
}

export function computeStats(games: GameResult[], username: string | null): CareerStats {
  const mine = games.filter((g) => !g.standings.every((x) => x.isBot));
  const stats: CareerStats = { games: 0, wins: 0, losses: 0, points: 0, bestScore: 0, countriesClaimed: 0, continentsClaimed: 0 };
  for (const g of mine) {
    const me = g.standings.find((p) => !p.isBot && (username === null || p.name === username)) ?? g.standings.find((p) => !p.isBot);
    if (!me) continue;
    stats.games++;
    stats.points += me.score;
    stats.bestScore = Math.max(stats.bestScore, me.score);
    if (g.winner === me.id) stats.wins++; else stats.losses++;
  }
  return stats;
}

/** Global score per human player. Bots are never ranked. */
export function localLeaderboard(games: GameResult[]) {
  const byName = new Map<string, number>();
  for (const g of games)
    for (const p of g.standings) {
      if (p.isBot) continue; // bots must not appear on any leaderboard
      byName.set(p.name, (byName.get(p.name) ?? 0) + p.score);
    }
  return [...byName.entries()]
    .map(([username, score]) => ({ username, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}
