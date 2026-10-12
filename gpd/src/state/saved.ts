import { GPDGame, TIMER_SECONDS } from '../engine/game';
import type { GameConfig, GameState, ModePreset } from '../engine/types';

/** Everything a paused game needs to be shown in the resume list. */
export interface SavedGameMeta {
  id: string;
  savedAt: string;
  mode: GameConfig['mode'];
  mapPreset: GameConfig['mapPreset'];
  preset: ModePreset;
  round: number;
  phase: GameState['phase'];
  players: { name: string; isBot: boolean; alive: boolean }[];
  aliveCount: number;
}

interface SavedGameRecord extends SavedGameMeta {
  state: GameState;
  rng: number;
}

const KEY = 'gpd.saved.v1';
const MAX = 20;

function presetOf(config: GameConfig): ModePreset {
  return config.preset ?? (config.tournament ? 'tournament' : 'classic');
}

function read(): SavedGameRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SavedGameRecord[]) : [];
  } catch { return []; }
}

function write(rows: SavedGameRecord[]) {
  try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX))); } catch { /* ignore */ }
}

function toMeta(r: SavedGameRecord): SavedGameMeta {
  return {
    id: r.id, savedAt: r.savedAt, mode: r.mode, mapPreset: r.mapPreset, preset: r.preset,
    round: r.round, phase: r.phase, players: r.players, aliveCount: r.aliveCount,
  };
}

export function listSavedGames(): SavedGameMeta[] {
  return read().map(toMeta);
}

/** Snapshot the live game so it can be resumed later. */
export function saveGame(game: GPDGame): SavedGameMeta {
  const s = game.state;
  const record: SavedGameRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
    mode: s.config.mode,
    mapPreset: s.config.mapPreset,
    preset: presetOf(s.config),
    round: s.round,
    phase: s.phase,
    players: s.players.map((p) => ({ name: p.name, isBot: p.isBot, alive: p.alive })),
    aliveCount: s.players.filter((p) => p.alive).length,
    state: s,
    rng: game.rng.state,
  };
  const rows = read();
  rows.unshift(record);
  write(rows);
  return toMeta(record);
}

/** Rebuild a paused game exactly, including the PRNG and a fresh turn clock. */
export function loadSavedGame(id: string): GPDGame | null {
  const row = read().find((r) => r.id === id);
  if (!row) return null;
  const game = GPDGame.fromJSON(JSON.stringify(row.state));
  game.rng.state = row.rng;
  const secs = TIMER_SECONDS[game.state.config.timer];
  if (game.state.phase === 'awaiting-action' || game.state.phase === 'gather-distribution') {
    game.state.turnDeadline = secs === null ? null : Date.now() + secs * 1000;
  } else {
    game.state.turnDeadline = null;
  }
  // The RNG must stay in sync after the deadline rewrite.
  return game;
}

export function deleteSavedGame(id: string) {
  write(read().filter((r) => r.id !== id));
}

export function savedGameCount(): number {
  return read().length;
}
