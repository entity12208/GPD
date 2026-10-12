import type { GameConfig, ModePreset } from '../engine/types';

/**
 * A game this device has already joined. Online games live on the server, so
 * "resuming" one just means opening its channel again and taking back our seat —
 * this record is only the pointer that makes it reachable from the menu.
 */
export interface OnlineSession {
  gameId: string;
  userId: string;
  username: string;
  seat: number;
  isHost: boolean;
  preset: ModePreset;
  mapPreset: GameConfig['mapPreset'];
  mode: GameConfig['mode'];
  /** Last status we saw, so the list can say "your turn" / "finished". */
  status: 'lobby' | 'placement' | 'active' | 'finished';
  savedAt: string;
}

const KEY = 'gpd.sessions.v1';
const MAX = 20;

function read(): OnlineSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OnlineSession[]) : [];
  } catch { return []; }
}

function write(rows: OnlineSession[]) {
  try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX))); } catch { /* ignore */ }
}

export function listOnlineSessions(): OnlineSession[] {
  return read().sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

export function getOnlineSession(gameId: string): OnlineSession | null {
  return read().find((s) => s.gameId === gameId) ?? null;
}

/** Remember (or refresh) an online game so it can be reopened later. */
export function saveOnlineSession(session: Omit<OnlineSession, 'savedAt'>): OnlineSession {
  const rows = read().filter((s) => s.gameId !== session.gameId);
  const record: OnlineSession = { ...session, savedAt: new Date().toISOString() };
  rows.unshift(record);
  write(rows);
  return record;
}

export function deleteOnlineSession(gameId: string) {
  write(read().filter((s) => s.gameId !== gameId));
}
