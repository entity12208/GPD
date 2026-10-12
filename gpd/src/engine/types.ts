/** Core types for Geo-Political Domination (GPD). */

export type ContinentId =
  | 'North America' | 'South America' | 'America'
  | 'Africa' | 'Europe' | 'Asia' | 'Oceania' | 'World';

export type MapPreset = ContinentId;

/** Water classification for a sea lane between two countries. */
export type WaterKind = 'sea' | 'ocean';

export interface SeaLane { id: string; km: number; water: WaterKind }

/** Static geography for one country. */
export interface CountryDef {
  id: string;            // ISO alpha-3 (or synthetic)
  n: string;             // ISO numeric
  name: string;
  cont: Exclude<ContinentId, 'America' | 'World'>;
  lat: number;
  lng: number;
  area: number;
  land: string[];        // land borders
  sea: SeaLane[];        // candidate sea lanes (recomputed per map)
}

export type GameMode =
  | 'online-solo' | 'online-teams'
  | 'offline-multi' | 'offline-solo' | 'offline-sim';

export type TurnTimer = 'none' | '1d' | '10min' | '5min' | '1min';

/* ----------------------------------------------------------------- presets -- */
/**
 * The rulebook defines exactly two ways to play: Classic and Tournament.
 * Players never choose point values or other rules; the only per-game choices
 * are the map, the seats and (for the host) the modifiers below.
 */
export type ModePreset = 'classic' | 'tournament';

export interface PresetSpec {
  id: ModePreset;
  label: string;
  blurb: string;
  /** Which chat scopes exist in this preset. */
  chat: 'global+team' | 'team';
  /** Turn timers this preset allows, in menu order. */
  timers: TurnTimer[];
  /** Maximum human players that may share one team. */
  maxPerTeam: number;
  /** Maximum number of teams. */
  maxTeams: number;
  /** Fewest players the preset can be played properly with. */
  minPlayers: number;
}

export const PRESETS: Record<ModePreset, PresetSpec> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    blurb: '1 player per team, up to 12 teams. Global and team chat. Every timer available.',
    chat: 'global+team',
    timers: ['none', '1d', '10min', '5min', '1min'],
    maxPerTeam: 1,
    maxTeams: 12,
    minPlayers: 2,
  },
  tournament: {
    id: 'tournament',
    label: 'Tournament',
    blurb: 'Up to 3 players per team, 4 teams. Team chat only. Daily, Rapid and Blitz timers.',
    chat: 'team',
    timers: ['1d', '10min', '5min'],
    maxPerTeam: 3,
    maxTeams: 4,
    // A team of three needs at least one opponent of the same size, so six
    // players is the smallest tournament that is actually a fair game.
    minPlayers: 6,
  },
};

export const DEFAULT_PRESET: ModePreset = 'classic';

export const PRESET_LIST: PresetSpec[] = [PRESETS.classic, PRESETS.tournament];

/** Total seat capacity of a preset (teams × players per team). */
export function presetCapacity(preset: ModePreset): number {
  const spec = PRESETS[preset];
  return spec.maxTeams * spec.maxPerTeam;
}

/** Narrow a turn timer to the ones a preset allows. */
export function timerAllowed(preset: ModePreset, timer: TurnTimer): boolean {
  return PRESETS[preset].timers.includes(timer);
}

export function minPlayers(preset: ModePreset): number {
  return PRESETS[preset].minPlayers;
}

/**
 * The team a player sits on, balanced so team sizes differ by at most one and no
 * team exceeds `maxPerTeam`. In Classic (one per team) a player is their own team.
 */
export function teamFor(preset: ModePreset, index: number, players: number): number {
  const spec = PRESETS[preset];
  if (spec.maxPerTeam <= 1) return index % Math.max(1, spec.maxTeams);
  const teams = Math.max(1, Math.min(spec.maxTeams, Math.ceil(Math.max(1, players) / spec.maxPerTeam)));
  return index % teams;
}

/** Number of teams a preset will use for a given player count. */
export function teamCountFor(preset: ModePreset, players: number): number {
  const spec = PRESETS[preset];
  if (spec.maxPerTeam <= 1) return Math.max(1, players);
  return Math.max(1, Math.min(spec.maxTeams, Math.ceil(Math.max(1, players) / spec.maxPerTeam)));
}

/** Why these settings cannot be played, or null when they are legal. */
export function configProblem(config: GameConfig): string | null {
  const preset = config.preset ?? (config.tournament ? 'tournament' : 'classic');
  const spec = PRESETS[preset];
  const players = config.playerCount ?? config.humanPlayers;
  if (players < spec.minPlayers) {
    return preset === 'tournament'
      ? `Tournament plays teams of ${spec.maxPerTeam}, so it needs at least ${spec.minPlayers} players — one full team to play against another.`
      : `${spec.label} mode needs at least ${spec.minPlayers} players.`;
  }
  if (players > presetCapacity(preset)) {
    return `${spec.label} mode allows at most ${presetCapacity(preset)} players.`;
  }
  return null;
}

/* ----------------------------------------------------------------- scoring -- */
/**
 * The canonical point values. These live in code on purpose: no client lets a
 * player edit them, and only a server-side operator can recalculate the
 * leaderboard with a different rule set (see supabase/schema.sql).
 */
export interface ScoringRules {
  claimUnoccupied: number;
  loseCountry: number;
  claimOccupied: number;
  failToWin: number;
  claimContinent: number;
  winGame: number;
  loseGame: number;
}

export const DEFAULT_SCORING: ScoringRules = {
  claimUnoccupied: 50,
  loseCountry: -50,
  claimOccupied: 75,
  failToWin: -20,
  claimContinent: 200,
  winGame: 500,
  loseGame: -200,
};

export interface GameConfig {
  mapPreset: MapPreset;
  mode: GameMode;
  /** Classic or Tournament — fixed once the host starts the game. */
  preset?: ModePreset;
  timer: TurnTimer;
  /** Modifiers are chosen by the game's host and apply to everyone joining. */
  fogOfWar: boolean;
  blindfold: boolean;
  /** Derived from `preset`; kept on the config because the engine reads it. */
  tournament: boolean;
  seed?: number;
  /** Server-side / programmatic override only. Never exposed in any UI. */
  scoring?: ScoringRules;
  /** Number of humans in the game; seats at index >= this are bots. */
  humanPlayers: number;
  /** Total seats. Defaults to humanPlayers when omitted. */
  playerCount?: number;
}

export interface TerritoryState {
  id: string;
  owner: number | null;
  troops: number;
  vulnerable: boolean;
  everOccupied: boolean;
}

export interface PlayerState {
  id: number;
  name: string;
  color: string;
  team: number;
  isBot: boolean;
  alive: boolean;
  money: number;
  score: number;
  /** Unrounded point total, so scores can be shown live without re-summing events. */
  scoreRaw: number;
  /** Peace income is paid at the beginning of the owner's next turn. */
  pendingPeace: boolean;
  /** Continents fully owned at the end of this player's last turn. */
  continents: string[];
  stats: { claimed: number; lost: number; won: number; failed: number; continents: number };
}

export type ActionType = 'peace' | 'gather' | 'expand' | 'nothing';

export interface PeaceAction { type: 'peace'; territory: string }
export interface GatherAction { type: 'gather'; distribution: Record<string, number>; typed?: string }
export interface ExpandAction { type: 'expand'; from: string; to: string; troops: number; typed?: string }
export interface NothingAction { type: 'nothing' }
export type Action = PeaceAction | GatherAction | ExpandAction | NothingAction;

export type TurnPhase = 'placement' | 'awaiting-action' | 'gather-distribution' | 'finished';

export interface ScoreEvent { player: number; key: keyof ScoringRules }

export interface GameEvent {
  turn: number;
  type:
    | 'peace' | 'gather' | 'expand' | 'combat' | 'claim' | 'loss' | 'income'
    | 'eliminated' | 'win' | 'timeout' | 'turn' | 'continent' | 'forfeit';
  player: number | null;
  territory?: string;
  from?: string;
  to?: string;
  amount?: number;
  troops?: number;
  text: string;
  /** teams that should flash a "!" marker on this territory (fog / blindfold) */
  markerTeams?: number[];
  private?: boolean;
}

export interface GameState {
  config: GameConfig;
  players: PlayerState[];
  territories: Record<string, TerritoryState>;
  active: string[];
  turn: number;              // index into turnOrder
  turnOrder: number[];
  round: number;
  phase: TurnPhase;
  gatherCap: number;
  log: GameEvent[];
  markers: { territory: string; team: number; turn: number }[];
  winner: number | null;
  winningTeam: number | null;
  turnDeadline: number | null;
  pendingType: ActionType | null;
  scoreEvents: ScoreEvent[];
  placementQueue: number[];
  scoring: ScoringRules;
}
