import type { Settings } from './settings';

let ctx: AudioContext | null = null;
let settings: Settings | null = null;

export function initSfx(s: Settings) { settings = s; }
export function updateSfx(s: Settings) { settings = s; }

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

export type SfxName =
  | 'click' | 'claim' | 'expand' | 'battle' | 'win' | 'lose' | 'coin' | 'peace' | 'error' | 'turn';

const TONES: Record<SfxName, { f: number; d: number; type: OscillatorType; f2?: number }> = {
  click: { f: 520, d: 0.05, type: 'square' },
  claim: { f: 440, d: 0.12, type: 'triangle', f2: 660 },
  expand: { f: 300, d: 0.16, type: 'sawtooth', f2: 520 },
  battle: { f: 140, d: 0.3, type: 'sawtooth', f2: 90 },
  win: { f: 523, d: 0.5, type: 'triangle', f2: 1046 },
  lose: { f: 220, d: 0.4, type: 'sine', f2: 110 },
  coin: { f: 880, d: 0.1, type: 'square', f2: 1320 },
  peace: { f: 392, d: 0.35, type: 'sine', f2: 494 },
  error: { f: 160, d: 0.18, type: 'square' },
  turn: { f: 660, d: 0.12, type: 'triangle', f2: 880 },
};

/** Play a short synthesised sound effect, honouring the SFX volume setting. */
export function sfx(name: SfxName) {
  const vol = settings?.sfxVolume ?? 0.5;
  if (vol <= 0) return;
  const ac = audio();
  if (!ac) return;
  if (ac.state === 'suspended') void ac.resume();
  const tone = TONES[name];
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = tone.type;
  osc.frequency.setValueAtTime(tone.f, ac.currentTime);
  if (tone.f2) osc.frequency.exponentialRampToValueAtTime(tone.f2, ac.currentTime + tone.d);
  const peak = 0.18 * vol;
  gain.gain.setValueAtTime(0.0001, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(peak, ac.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + tone.d);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + tone.d + 0.02);
}
