import { GPDGame } from '../engine/game';
import { botAct, botFinishGather } from '../engine/bots';
import type { GameEvent, TurnPhase } from '../engine/types';
import type { NetPayload } from '../net/protocol';

export interface RunnerOptions {
  /** ms between bot moves */
  speed?: number;
  /** ms between engine ticks (turn timers) */
  tickMs?: number;
  /** how many bot moves to run per tick (simulation mode runs many) */
  stepsPerTick?: number;
}

/**
 * Drives a game forward: lets bots move, enforces per-turn timers and notifies
 * React of every state change.
 */
export class GameRunner {
  game: GPDGame;
  private listeners = new Set<() => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastBotAt = 0;
  private seenLog = 0;
  speed: number;
  tickMs: number;
  stepsPerTick: number;
  paused = false;
  autoBots = true;
  /** Guests never advance time themselves — the host owns the clock. */
  readOnly = false;
  onEvent: ((e: GameEvent) => void) | null = null;
  /** When set, player actions are sent over the network instead of applied locally. */
  remote: ((p: NetPayload) => void) | null = null;
  version = 0;

  constructor(game: GPDGame, opts: RunnerOptions = {}) {
    this.game = game;
    this.speed = opts.speed ?? 650;
    this.tickMs = opts.tickMs ?? 120;
    this.stepsPerTick = Math.max(1, opts.stepsPerTick ?? 1);
    this.seenLog = game.state.log.length;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = () => this.version;

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.step(), this.tickMs);
    this.step();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Force an immediate bot/timer step (used after a human action). */
  kick() { this.step(true); }

  private flushEvents() {
    const log = this.game.state.log;
    if (log.length > this.seenLog) {
      for (let i = this.seenLog; i < log.length; i++) this.onEvent?.(log[i]);
      this.seenLog = log.length;
    } else if (log.length < this.seenLog) {
      this.seenLog = log.length;
    }
  }

  private step(force = false) {
    if (this.paused) return;
    let changed = false;
    if (!this.readOnly && this.game.tick()) changed = true;

    const s = this.game.state;
    if (s.phase !== 'finished' && this.autoBots) {
      const now = Date.now();
      const wait = this.game.state.phase === 'placement' ? Math.max(60, this.speed / 2) : this.speed;
      if (force || now - this.lastBotAt >= wait) {
        for (let i = 0; i < this.stepsPerTick; i++) {
          const phase: TurnPhase = this.game.state.phase;
          const actor = this.game.actor;
          if (phase === 'finished' || !actor?.isBot) break;
          if (phase === 'placement') this.game.autoPlace(actor.id);
          else if (phase === 'gather-distribution') botFinishGather(this.game);
          else if (phase === 'awaiting-action') botAct(this.game);
          else break;
          changed = true;
        }
        this.lastBotAt = now;
      }
    }
    this.flushEvents();
    if (changed) this.emit();
    if (this.game.state.phase === 'finished') this.stop();
  }

  // Human-facing helpers -----------------------------------------------------
  /** Apply an action locally, or forward it to the authoritative host. */
  dispatch(payload: NetPayload | null, local: () => { ok: boolean; error?: string }) {
    if (this.remote) {
      if (payload) this.remote(payload);
      return { ok: true as const };
    }
    return this.act(local);
  }

  act<T>(fn: () => T): T {
    const before = this.game.state.log.length;
    const res = fn();
    void before;
    this.flushEvents();
    this.emit();
    if (this.game.state.phase === 'finished') this.stop();
    else this.lastBotAt = Date.now();
    return res;
  }
}
