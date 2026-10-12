import { BY_ID, countriesForPreset, continentMembers, graphForPreset } from './data';
import { teamFor } from './types';
import { RNG } from './rng';
import { DEFAULT_SCORING, scoreMultiplier } from './scoring';
import type {
  Action, ActionType, ExpandAction, GatherAction, GameConfig, GameEvent, GameState,
  NothingAction, PeaceAction, PlayerState, ScoringRules, TerritoryState,
  TurnTimer, WaterKind,
} from './types';

export const PLAYER_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#00b8b8',
  '#f032e6', '#bfef45', '#fabebe', '#469990', '#9a6324', '#800000',
];

export const DEFAULT_NAMES = [
  'Red', 'Green', 'Blue', 'Orange', 'Purple', 'Teal',
  'Magenta', 'Lime', 'Pink', 'Mint', 'Brown', 'Maroon',
];

/** Cost table for the Expand action. */
export const EXPAND_BASE = 100;
export const SEA_EXTRA = 100;
export const OCEAN_PER_TROOP = 50;
export const TROOP_COST = 50;
export const STARTING_MONEY = 500;
export const ATTRITION = 0.1; // each troop has a 1-in-10 chance of dying on a water crossing

export const TIMER_SECONDS: Record<TurnTimer, number | null> = {
  none: null, '1d': 86400, '10min': 600, '5min': 300, '1min': 60,
};

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

export interface ExpandQuote {
  from: string;
  to: string;
  water: WaterKind | null;
  km: number;
  base: number;
  waterFee: number;
  oceanFee: number;
  total: number;
  maxTroops: number;
}

export class GPDGame {
  state: GameState;
  rng: RNG;

  constructor(config: GameConfig, names?: string[]) {
    // The Classic/Tournament preset is the single source of truth for teams;
    // normalise `tournament` from it so the rest of the engine stays simple.
    const preset = config.preset ?? (config.tournament ? 'tournament' : 'classic');
    const normalized: GameConfig = { ...config, preset, tournament: preset === 'tournament' };
    this.rng = new RNG(normalized.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.state = this.createState(normalized, names);
  }

  private createState(config: GameConfig, names?: string[]): GameState {
    const active = countriesForPreset(config.mapPreset).map((c) => c.id);
    const territories: Record<string, TerritoryState> = {};
    for (const id of active)
      territories[id] = { id, owner: null, troops: 0, vulnerable: false, everOccupied: false };

    const preset = config.preset ?? (config.tournament ? 'tournament' : 'classic');
    const n = Math.max(1, Math.min(12, config.playerCount ?? config.humanPlayers));
    const players: PlayerState[] = [];
    for (let i = 0; i < n; i++) {
      players.push({
        id: i,
        name: names?.[i] ?? DEFAULT_NAMES[i % DEFAULT_NAMES.length],
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        team: teamFor(preset, i, n),
        isBot: i >= config.humanPlayers || config.mode === 'offline-sim',
        alive: true,
        money: STARTING_MONEY,
        score: 0,
        scoreRaw: 0,
        pendingPeace: false,
        continents: [],
        stats: { claimed: 0, lost: 0, won: 0, failed: 0, continents: 0 },
      });
    }
    // in simulation mode every seat is a bot
    if (config.mode === 'offline-sim') players.forEach((p) => (p.isBot = true));
    if (config.mode === 'offline-solo') players.forEach((p, i) => (p.isBot = i !== 0));

    const turnOrder = this.buildTurnOrder(players, config.tournament);

    return {
      config: { ...config, scoring: config.scoring ?? DEFAULT_SCORING },
      players,
      territories,
      active,
      turn: 0,
      turnOrder,
      round: 1,
      phase: 'placement',
      gatherCap: 0,
      log: [],
      markers: [],
      winner: null,
      winningTeam: null,
      turnDeadline: null,
      pendingType: null,
      scoreEvents: [],
      placementQueue: turnOrder.slice(),
      scoring: config.scoring ?? DEFAULT_SCORING,
    };
  }

  /** Tournament mode alternates teams so allies act in sequence. */
  private buildTurnOrder(players: PlayerState[], tournament: boolean): number[] {
    if (!tournament) return players.map((p) => p.id);
    const byTeam = new Map<number, number[]>();
    for (const p of players) {
      if (!byTeam.has(p.team)) byTeam.set(p.team, []);
      byTeam.get(p.team)!.push(p.id);
    }
    const teams = [...byTeam.keys()].sort((a, b) => a - b);
    const maxSize = Math.max(...[...byTeam.values()].map((v) => v.length));
    const order: number[] = [];
    for (let i = 0; i < maxSize; i++)
      for (const t of teams) {
        const member = byTeam.get(t)![i];
        if (member !== undefined) order.push(member);
      }
    return order;
  }

  // ---------------------------------------------------------------- placement
  get currentPlayer(): PlayerState | null {
    if (this.state.phase === 'finished' || this.state.placementQueue.length > 0)
      return null;
    const id = this.state.turnOrder[this.state.turn % this.state.turnOrder.length];
    return this.state.players[id] ?? null;
  }

  /** Whose turn it is during placement, otherwise the active player. */
  get actor(): PlayerState | null {
    if (this.state.phase === 'placement') {
      const id = this.state.placementQueue[0];
      return id === undefined ? null : this.state.players[id];
    }
    return this.currentPlayer;
  }

  /**
   * Everyone allowed to submit the current move. In Tournament mode the turn
   * belongs to a team, so any living member of the acting player's team may move
   * for it; Classic hands each player their own turn.
   */
  eligibleActors(): PlayerState[] {
    const a = this.actor;
    if (!a) return [];
    if (!this.state.config.tournament) return this.state.players[a.id] ? [a] : [];
    return this.state.players.filter((p) => p.alive && p.team === a.team);
  }

  /** May this seat submit the current move? */
  canAct(playerId: number): boolean {
    return this.eligibleActors().some((p) => p.id === playerId);
  }

  /**
   * May this player be told the name of this country? Under Fog of War and
   * Blindfold a player only ever learns the names of countries they own.
   */
  canSeeName(playerId: number, countryId: string): boolean {
    const { fogOfWar, blindfold } = this.state.config;
    if (!fogOfWar && !blindfold) return true;
    return this.state.territories[countryId]?.owner === playerId;
  }

  placeStartingCountry(playerId: number, countryId: string): { ok: boolean; error?: string } {
    if (this.state.phase !== 'placement') return { ok: false, error: 'Placement is over' };
    if (this.state.placementQueue[0] !== playerId) return { ok: false, error: 'Not your pick' };
    const t = this.state.territories[countryId];
    if (!t) return { ok: false, error: 'Unknown country' };
    if (t.owner !== null) return { ok: false, error: 'Country already taken' };

    t.owner = playerId;
    t.troops = 1;
    t.everOccupied = true;
    this.state.placementQueue.shift();
    this.log('turn', playerId, `${this.state.players[playerId].name} starts in ${BY_ID[countryId].name}`, { territory: countryId });

    if (this.state.placementQueue.length === 0) this.startGame();
    return { ok: true };
  }

  /** Auto-pick for bots / AFK players. */
  autoPlace(playerId: number): string | null {
    const free = this.state.active.filter((id) => this.state.territories[id].owner === null);
    if (!free.length) return null;
    const id = this.rng.pick(free);
    const res = this.placeStartingCountry(playerId, id);
    return res.ok ? id : null;
  }

  private startGame() {
    this.state.phase = 'awaiting-action';
    this.state.turn = 0;
    this.state.round = 1;
    this.beginTurn();
  }

  // --------------------------------------------------------------------- turns
  private beginTurn() {
    const p = this.currentPlayer;
    if (!p) return;
    if (!p.alive) { this.state.turn = this.nextTurnIndex(); this.beginTurn(); return; }

    // Peace income lands at the beginning of the owner's next turn.
    if (p.pendingPeace) {
      const owned = this.ownedBy(p.id);
      let income = 100 * owned.length;
      const full = this.fullContinents(p.id);
      for (const c of full) income += 10 * this.continentSize(c);
      p.money += income;
      p.pendingPeace = false;
      this.log('income', p.id, `${p.name} collects $${income} from Peace`, { amount: income });
    }
    // vulnerability from a Peace expires now
    for (const t of Object.values(this.state.territories))
      if (t.owner === p.id && t.vulnerable) t.vulnerable = false;

    this.state.phase = 'awaiting-action';
    this.state.pendingType = null;
    this.state.gatherCap = 0;
    const secs = TIMER_SECONDS[this.state.config.timer];
    this.state.turnDeadline = secs === null ? null : Date.now() + secs * 1000;
    this.log('turn', p.id, `${p.name}'s turn`, {});
  }

  private nextTurnIndex(): number {
    const order = this.state.turnOrder;
    const n = order.length;
    const idx = this.state.turn;
    for (let k = 1; k <= n; k++) {
      const next = (idx + k) % n;
      if (this.state.players[order[next]].alive) {
        if (next <= idx) this.state.round++;
        return next;
      }
    }
    return idx;
  }

  endTurn() {
    if (this.state.phase === 'finished') return;
    this.state.turnDeadline = null;
    if (this.checkWin()) return;
    this.state.turn = this.nextTurnIndex();
    this.beginTurn();
  }

  tick(now = Date.now()): boolean {
    const { turnDeadline } = this.state;
    if (!turnDeadline || this.state.phase === 'finished' || this.state.phase === 'placement') return false;
    if (now < turnDeadline) return false;
    const p = this.currentPlayer;
    if (!p) return false;
    this.timeout(p.id);
    return true;
  }

  timeout(playerId: number) {
    const p = this.state.players[playerId];
    const owned = this.ownedBy(playerId);
    for (const t of owned) { t.owner = null; t.troops = 0; t.vulnerable = false; }
    p.alive = false;
    this.log('timeout', playerId, `${p.name} ran out of time and was removed from the game`, {});
    this.award(playerId, 'loseGame');
    if (!this.checkWin()) { this.state.turnDeadline = null; this.endTurn(); }
  }

  /**
   * A player quits for good: their countries leave the map and they are out of the
   * game. Only advances the turn when it was actually their move.
   */
  forfeit(playerId: number) {
    const p = this.state.players[playerId];
    if (!p || !p.alive || this.state.phase === 'finished') return;
    const wasTheirTurn = this.state.phase !== 'placement' && this.currentPlayer?.id === playerId;
    for (const t of this.ownedBy(playerId)) { t.owner = null; t.troops = 0; t.vulnerable = false; }
    p.alive = false;
    this.log('eliminated', playerId, `${p.name} left the game`, {});
    this.award(playerId, 'loseGame');
    if (this.checkWin()) return;
    if (wasTheirTurn) { this.state.turnDeadline = null; this.endTurn(); }
  }

  /** The host closes the table: nobody wins. */
  abandon() {
    if (this.state.phase === 'finished') return;
    this.state.phase = 'finished';
    this.state.turnDeadline = null;
    this.state.winner = null;
    this.state.winningTeam = null;
    this.log('win', null, 'The host closed the game', {});
  }

  // ------------------------------------------------------------------ actions
  availableActionTypes(): ActionType[] {
    const p = this.actor;
    if (!p) return [];
    return ['peace', 'gather', 'expand', 'nothing'];
  }

  /** Step 1: the player picks one of the four actions. */
  chooseAction(type: ActionType): { ok: boolean; error?: string } {
    const p = this.actor;
    if (!p) return { ok: false, error: 'No active player' };
    if (this.state.phase !== 'awaiting-action') return { ok: false, error: 'Not accepting actions' };
    if (this.state.pendingType && this.state.pendingType !== type)
      return { ok: false, error: 'Finish the current action' };

    if (type === 'gather') {
      // X is bounded by a fresh random(1,20) draw
      this.state.gatherCap = this.rng.int(1, 20);
      this.state.phase = 'gather-distribution';
      this.state.pendingType = 'gather';
      this.log('gather', p.id, `${p.name} may buy up to ${this.state.gatherCap} troops`, { troops: this.state.gatherCap });
      return { ok: true };
    }
    if (type === 'peace') { this.state.pendingType = 'peace'; return { ok: true }; }
    if (type === 'expand') { this.state.pendingType = 'expand'; return { ok: true }; }
    return this.submitNothing();
  }

  submitNothing(): { ok: boolean; error?: string } {
    const p = this.actor;
    if (!p) return { ok: false, error: 'No active player' };
    if (this.state.phase !== 'awaiting-action') return { ok: false, error: 'Not accepting actions' };
    this.log('turn', p.id, `${p.name} does nothing`, {});
    this.state.pendingType = null;
    this.endTurn();
    return { ok: true };
  }

  canPeace(playerId: number, territoryId: string): boolean {
    const t = this.state.territories[territoryId];
    return !!t && t.owner === playerId;
  }

  submitPeace(territoryId: string): { ok: boolean; error?: string } {
    const p = this.actor;
    if (!p) return { ok: false, error: 'No active player' };
    if (this.state.pendingType !== 'peace' && this.state.phase !== 'awaiting-action')
      return { ok: false, error: 'Not choosing Peace' };
    const t = this.state.territories[territoryId];
    if (!t || t.owner !== p.id) return { ok: false, error: 'You do not own that country' };

    t.vulnerable = true;
    p.pendingPeace = true;
    this.log('peace', p.id, `${p.name} declares Peace in ${BY_ID[territoryId].name} — vulnerable until their next turn`, {
      territory: territoryId, markerTeams: [p.team],
    });
    this.state.pendingType = null;
    this.endTurn();
    return { ok: true };
  }

  submitGather(distribution: Record<string, number>): { ok: boolean; error?: string } {
    const p = this.actor;
    if (!p) return { ok: false, error: 'No active player' };
    if (this.state.phase !== 'gather-distribution') return { ok: false, error: 'Not gathering troops' };

    let total = 0;
    for (const [id, n] of Object.entries(distribution)) {
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { ok: false, error: 'Invalid troop count' };
      const t = this.state.territories[id];
      if (!t || t.owner !== p.id) return { ok: false, error: `You do not own ${BY_ID[id]?.name ?? id}` };
      total += n;
    }
    if (total < 1) return { ok: false, error: 'Buy at least 1 troop' };
    if (total > this.state.gatherCap)
      return { ok: false, error: `At most ${this.state.gatherCap} troops this turn` };
    const cost = total * TROOP_COST;
    if (cost > p.money) return { ok: false, error: `Not enough money (need $${cost})` };

    p.money -= cost;
    for (const [id, n] of Object.entries(distribution)) if (n > 0) this.state.territories[id].troops += n;
    this.log('gather', p.id, `${p.name} gathered ${total} troops for $${cost}`, { troops: total, amount: cost });
    this.state.pendingType = null;
    this.state.phase = 'awaiting-action';
    this.endTurn();
    return { ok: true };
  }

  /** Quote the cost / legality of an expansion. */
  quoteExpand(playerId: number, from: string, to: string, troops: number): ExpandQuote | { error: string } {
    const t = this.state.territories[from];
    const d = this.state.territories[to];
    if (!t || !d) return { error: 'Unknown country' };
    if (t.owner !== playerId) return { error: 'You do not own the origin country' };
    if (to === from) return { error: 'Pick a different country' };
    if (d.owner === playerId) return { error: 'You already own that country' };
    if (d.owner !== null && this.state.players[d.owner].team === this.state.players[playerId].team && this.state.config.tournament)
      return { error: 'That country belongs to an ally' };
    const lane = graphForPreset(this.state.config.mapPreset).adj[from].find((x) => x.id === to);
    if (!lane) return { error: `${BY_ID[to].name} does not border ${BY_ID[from].name} — you cannot expand through other countries` };
    const maxTroops = Math.max(0, t.troops - 1);
    if (troops < 1) return { error: 'Send at least 1 troop' };
    if (troops > maxTroops) return { error: `You may send at most ${maxTroops} troops` };
    const waterFee = lane.water === 'sea' ? SEA_EXTRA : 0;
    const oceanFee = lane.water === 'ocean' ? OCEAN_PER_TROOP * troops : 0;
    const total = EXPAND_BASE + waterFee + oceanFee;
    return { from, to, water: lane.water, km: lane.km, base: EXPAND_BASE, waterFee, oceanFee, total, maxTroops };
  }

  submitExpand(from: string, to: string, troops: number, typed?: string): { ok: boolean; error?: string } {
    const p = this.actor;
    if (!p) return { ok: false, error: 'No active player' };
    if (this.state.phase !== 'awaiting-action') return { ok: false, error: 'Not accepting actions' };

    // Typed orders: a misspelled country name costs you the turn — but a name you
    // were never shown cannot be misspelled, so under Fog of War / Blindfold the
    // order only has to be issued.
    if (typed !== undefined && this.canSeeName(p.id, to)) {
      const matches = normalizeName(typed) === normalizeName(BY_ID[to]?.name ?? '');
      if (!matches) {
        this.log('forfeit', p.id, `${p.name} mis-spelled "${typed}" and loses the turn`, {});
        this.state.pendingType = null;
        this.endTurn();
        return { ok: false, error: 'Mis-spelled country name — turn lost' };
      }
    }

    const quote = this.quoteExpand(p.id, from, to, troops);
    if ('error' in quote) return { ok: false, error: quote.error };
    if (quote.total > p.money) return { ok: false, error: `Not enough money (need $${quote.total})` };

    const src = this.state.territories[from];
    const dst = this.state.territories[to];
    p.money -= quote.total;
    src.troops -= troops;

    // attrition across water
    let arriving = troops;
    if (quote.water !== null) {
      let lost = 0;
      for (let i = 0; i < troops; i++) if (this.rng.next() < ATTRITION) lost++;
      arriving = troops - lost;
      if (lost > 0)
        this.log('expand', p.id, `${lost} of ${troops} troops were lost crossing the ${quote.water === 'sea' ? 'water' : 'ocean'}`, { from, to, troops: lost });
    }

    this.log('expand', p.id, `${p.name} expands from ${BY_ID[from].name} into ${BY_ID[to].name} with ${troops} troops ($${quote.total})`, {
      from, to, troops, amount: quote.total, markerTeams: [p.team],
    });

    const attackerTeam = p.team;
    if (dst.owner === null) {
      this.claim(p.id, to, arriving, dst.everOccupied);
      this.state.pendingType = null;
      this.endTurn();
      return { ok: true };
    }

    const defender = this.state.players[dst.owner];
    if (dst.vulnerable) {
      this.log('combat', p.id, `${BY_ID[to].name} was vulnerable — ${defender.name}'s garrison is wiped out`, {
        territory: to, markerTeams: [defender.team, attackerTeam],
      });
      this.loseCountry(defender.id, to, dst.troops);
      this.claim(p.id, to, arriving, true);
      this.state.pendingType = null;
      this.endTurn();
      return { ok: true };
    }

    // dice battle: every troop rolls 1..20, highest total wins the country
    let atkSum = 0;
    for (let i = 0; i < arriving; i++) atkSum += this.rng.int(1, 20);
    let defSum = 0;
    for (let i = 0; i < dst.troops; i++) defSum += this.rng.int(1, 20);
    const atkWin = atkSum > defSum;
    this.log('combat', p.id, `Battle for ${BY_ID[to].name}: ${p.name} rolls ${atkSum} (${arriving} troops) vs ${defender.name} ${defSum} (${dst.troops} troops)`, {
      territory: to, markerTeams: [attackerTeam, defender.team],
    });

    if (atkWin) {
      this.loseCountry(defender.id, to, dst.troops);
      this.claim(p.id, to, Math.max(arriving, 0), true);
      this.log('combat', p.id, `${p.name} takes ${BY_ID[to].name}`, { territory: to, markerTeams: [attackerTeam, defender.team] });
    } else {
      this.award(p.id, 'failToWin');
      this.state.players[p.id].stats.failed++;
      this.log('combat', p.id, `${defender.name} holds ${BY_ID[to].name}; all attacking troops die`, {
        territory: to, markerTeams: [attackerTeam, defender.team],
      });
    }
    this.state.pendingType = null;
    this.endTurn();
    return { ok: true };
  }

  private claim(playerId: number, id: string, troops: number, wasOccupied: boolean) {
    const t = this.state.territories[id];
    t.owner = playerId;
    t.troops = wasOccupied ? troops : Math.max(troops, 1);
    t.vulnerable = false;
    t.everOccupied = true;
    const p = this.state.players[playerId];
    p.stats.claimed++;
    this.award(playerId, wasOccupied ? 'claimOccupied' : 'claimUnoccupied');
    this.log('claim', playerId, `${p.name} claims ${BY_ID[id].name}`, { territory: id, markerTeams: [p.team] });
    this.syncContinents(playerId);
  }

  /** A player with no territories left is out of the game. */
  private checkElimination(playerId: number) {
    if (this.state.phase === 'placement') return;
    const p = this.state.players[playerId];
    if (!p.alive) return;
    if (this.ownedBy(playerId).length > 0) return;
    p.alive = false;
    this.log('eliminated', playerId, `${p.name} has been eliminated`, {});
  }

  private loseCountry(playerId: number, id: string, _troops: number) {
    const t = this.state.territories[id];
    if (t.owner === null) return;
    const p = this.state.players[playerId];
    p.stats.lost++;
    this.award(playerId, 'loseCountry');
    this.log('loss', playerId, `${p.name} loses ${BY_ID[id].name}`, { territory: id, markerTeams: [p.team] });
    t.owner = null;
    t.troops = 0;
    t.vulnerable = false;
    this.syncContinents(playerId);
    this.checkElimination(playerId);
  }

  // ------------------------------------------------------------------ scoring
  award(playerId: number, key: keyof ScoringRules) {
    this.state.scoreEvents.push({ player: playerId, key });
    const m = scoreMultiplier(this.state.config);
    const p = this.state.players[playerId];
    p.scoreRaw += this.state.scoring[key] ?? 0;
    p.score = Math.round(p.scoreRaw * m);
  }

  /** Rebuild every total from the recorded events (used when rules change). */
  recomputeScores(rules?: ScoringRules) {
    const ruleset = rules ?? this.state.scoring;
    this.state.scoring = ruleset;
    const m = scoreMultiplier(this.state.config);
    for (const p of this.state.players) {
      p.scoreRaw = this.state.scoreEvents
        .filter((e) => e.player === p.id)
        .reduce((sum, e) => sum + (ruleset[e.key] ?? 0), 0);
      p.score = Math.round(p.scoreRaw * m);
    }
  }

  /** Alias exposing the recalculation-from-different-calculations requirement. */
  recalculateLeaderboard(rules: ScoringRules) {
    this.recomputeScores(rules);
  }

  // ----------------------------------------------------------- geography maths
  ownedBy(playerId: number): TerritoryState[] {
    return Object.values(this.state.territories).filter((t) => t.owner === playerId);
  }

  continentSize(cont: string): number {
    const active = new Set(this.state.active);
    return continentMembers(cont).filter((c) => active.has(c.id)).length;
  }

  private activeContinents(): string[] {
    const set = new Set<string>();
    for (const id of this.state.active) set.add(BY_ID[id].cont);
    return [...set];
  }

  fullContinents(playerId: number): string[] {
    const out: string[] = [];
    for (const cont of this.activeContinents()) {
      const members = continentMembers(cont).filter((c) => this.state.territories[c.id]);
      if (members.length && members.every((c) => this.state.territories[c.id].owner === playerId))
        out.push(cont);
    }
    return out;
  }

  /** Recompute continent ownership for a player (used by the engine and by tests). */
  syncContinentsFor(playerId: number) { this.syncContinents(playerId); }

  private syncContinents(playerId: number) {
    const p = this.state.players[playerId];
    const now = new Set(this.fullContinents(playerId));
    for (const c of now) {
      if (!p.continents.includes(c)) {
        p.continents.push(c);
        p.stats.continents++;
        this.award(playerId, 'claimContinent');
        const size = this.continentSize(c);
        this.log('continent', playerId, `${p.name} controls all of ${c} (+${10 * size}/turn)`, { amount: 10 * size });
      }
    }
    p.continents = p.continents.filter((c) => now.has(c));
  }

  // --------------------------------------------------------- end / win checks
  teamAlive(team: number): boolean {
    return this.state.players.some((p) => p.team === team && p.alive);
  }

  checkWin(): boolean {
    if (this.state.phase === 'finished') return true;
    const aliveTeams = [...new Set(this.state.players.map((p) => p.team))].filter((t) => this.teamAlive(t));
    const alivePlayers = this.state.players.filter((p) => p.alive);
    const tournament = this.state.config.tournament;
    const over = tournament ? aliveTeams.length <= 1 : alivePlayers.length <= 1;
    if (!over) return false;

    this.state.phase = 'finished';
    this.state.turnDeadline = null;
    const winningTeam = tournament ? (aliveTeams[0] ?? null) : (alivePlayers[0]?.team ?? null);
    const winner = tournament
      ? (this.state.players.find((p) => p.team === winningTeam && p.alive)?.id ?? null)
      : (alivePlayers[0]?.id ?? null);
    this.state.winner = winner;
    this.state.winningTeam = winningTeam;

    for (const p of this.state.players) {
      if (winningTeam !== null && p.team === winningTeam && p.alive) {
        this.state.scoreEvents.push({ player: p.id, key: 'winGame' });
      } else {
        this.state.scoreEvents.push({ player: p.id, key: 'loseGame' });
      }
    }
    this.recomputeScores();
    const wname = winningTeam !== null
      ? this.state.players.filter((p) => p.team === winningTeam).map((p) => p.name).join(' & ')
      : 'nobody';
    this.log('win', winner, `${wname} wins the game!`, {});
    return true;
  }

  countAlive(): number {
    return this.state.players.filter((p) => p.alive).length;
  }

  // -------------------------------------------------------------------- events
  private log(
    type: GameEvent['type'],
    player: number | null,
    text: string,
    extra: Partial<GameEvent> = {},
  ) {
    this.state.log.push({ turn: this.state.round, type, player, text, ...extra });
    if (extra.markerTeams && extra.territory)
      for (const team of extra.markerTeams)
        this.state.markers.push({ territory: extra.territory, team, turn: this.state.round });
    if (this.state.log.length > 4000) this.state.log.splice(0, 1000);
  }

  // ------------------------------------------------------------------- vision
  /** Fog of war / blindfold aware snapshot for one viewer. */
  viewFor(playerId: number) {
    const { fogOfWar, blindfold } = this.state.config;
    const visible: Record<string, { owner: number | null; troops: number | null; vulnerable: boolean | null }> = {};
    for (const id of this.state.active) {
      const t = this.state.territories[id];
      const mine = t.owner === playerId;
      if (blindfold) visible[id] = { owner: null, troops: null, vulnerable: null };
      else if (fogOfWar && !mine) visible[id] = { owner: null, troops: null, vulnerable: null };
      else visible[id] = { owner: t.owner, troops: t.troops, vulnerable: t.vulnerable };
    }
    const myTeam = this.state.players[playerId]?.team;
    const markers = this.state.markers
      .filter((m) => m.turn >= this.state.round - 1)
      .map((m) => ({ ...m, isMine: m.team === myTeam }));
    return { visible, markers };
  }

  // -------------------------------------------------------------- serialization
  toJSON(): string { return JSON.stringify(this.state); }

  static fromJSON(json: string): GPDGame {
    const g: GPDGame = Object.create(GPDGame.prototype) as GPDGame;
    g.state = JSON.parse(json) as GameState;
    g.rng = new RNG(Math.floor(Math.random() * 2 ** 31));
    return g;
  }
}

export type { Action, GatherAction, PeaceAction, ExpandAction, NothingAction };
