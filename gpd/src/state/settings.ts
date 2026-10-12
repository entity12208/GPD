export interface Settings {
  fps: 30 | 60;
  sfxVolume: number; // 0..1
  liveChat: boolean;
  showTroopCounts: boolean;
  confirmBeforeEndingTurn: boolean;
}

const KEY = 'gpd.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  fps: 60,
  sfxVolume: 0.5,
  liveChat: true,
  showTroopCounts: true,
  confirmBeforeEndingTurn: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
