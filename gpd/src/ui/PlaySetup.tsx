import { useMemo, useState } from 'react';
import { MAP_PRESETS, countriesForPreset } from '../engine/data';
import { DEFAULT_SCORING } from '../engine/scoring';
import {
  DEFAULT_PRESET, PRESETS, PRESET_LIST, presetCapacity, timerAllowed,
  type GameConfig, type GameMode, type MapPreset, type ModePreset, type TurnTimer,
} from '../engine/types';

export const MODES: { id: GameMode; label: string; blurb: string }[] = [
  { id: 'offline-solo', label: 'Offline Singleplayer', blurb: 'You against 1–12 bots on one machine.' },
  { id: 'offline-multi', label: 'Offline Multiplayer', blurb: 'Hot-seat on one machine, up to 12 players.' },
  { id: 'offline-sim', label: 'Offline Simulation', blurb: '1–12 bots, no players — just watch.' },
  { id: 'online-solo', label: 'Online Multiplayer (solo)', blurb: 'Sign in required. Every player for themselves.' },
  { id: 'online-teams', label: 'Online Multiplayer (teams)', blurb: 'Sign in required. Teams of up to 3, four teams max.' },
];

const ALL_TIMERS: { id: TurnTimer; label: string }[] = [
  { id: 'none', label: 'Disabled (Normal)' },
  { id: '1d', label: '1d (Daily)' },
  { id: '10min', label: '10min (Rapid)' },
  { id: '5min', label: '5min (Blitz)' },
  { id: '1min', label: '1min (Bullet)' },
];

export type LobbyVisibility = 'public' | 'private';

/** Everything the host sets for an online lobby; ignored for offline games. */
export interface LobbyOptions {
  visibility: LobbyVisibility;
  /** Optional room password for public games. */
  password?: string;
  /** Usernames a private game is sent to. */
  invites: string[];
}

interface Props {
  defaultMode?: GameMode;
  onStart: (cfg: GameConfig, names: string[], lobby?: LobbyOptions) => void;
  onCancel: () => void;
  onlineSlot?: React.ReactNode;
}

export function PlaySetup({ defaultMode = 'offline-solo', onStart, onCancel, onlineSlot }: Props) {
  const [mode, setMode] = useState<GameMode>(defaultMode);
  const [preset, setPreset] = useState<ModePreset>(DEFAULT_PRESET);
  const [map, setMap] = useState<MapPreset>('World');
  const [bots, setBots] = useState(4);
  const [humans, setHumans] = useState(2);
  const [timer, setTimer] = useState<TurnTimer>('none');
  const [fog, setFog] = useState(false);
  const [blind, setBlind] = useState(false);
  const [seed, setSeed] = useState('');
  const [names, setNames] = useState<string[]>(Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`));
  const [visibility, setVisibility] = useState<LobbyVisibility>('public');
  const [roomPassword, setRoomPassword] = useState('');
  const [invites, setInvites] = useState('');

  const isOnline = mode === 'online-solo' || mode === 'online-teams';
  const spec = PRESETS[preset];
  const allowedTimers = useMemo(() => ALL_TIMERS.filter((t) => timerAllowed(preset, t.id)), [preset]);
  const playerCapacity = presetCapacity(preset);
  const totalPlayers = isOnline ? Math.min(humans, playerCapacity)
    : mode === 'offline-sim' ? bots
      : mode === 'offline-solo' ? bots + 1 : humans;

  const countries = useMemo(() => countriesForPreset(map).length, [map]);
  const tooManyForMap = totalPlayers > countries;

  /** Why the settings on screen cannot be played yet, or null when they can. */
  const problem = useMemo(() => {
    const spec = PRESETS[preset];
    if (totalPlayers < spec.minPlayers) {
      return preset === 'tournament'
        ? `Tournament plays teams of ${spec.maxPerTeam}, so it needs at least ${spec.minPlayers} players — one full team to play against another.`
        : `${spec.label} mode needs at least ${spec.minPlayers} players.`;
    }
    if (tooManyForMap) return `Not enough countries for ${totalPlayers} players on this map.`;
    return null;
  }, [preset, totalPlayers, tooManyForMap]);

  function choosePreset(next: ModePreset) {
    setPreset(next);
    // Keep the timer legal for the newly chosen preset.
    if (!timerAllowed(next, timer)) setTimer(PRESETS[next].timers[0]);
    // Tournament needs one full team per side, so never drop below its minimum.
    setHumans((h) => Math.min(Math.max(h, PRESETS[next].minPlayers), presetCapacity(next)));
  }

  function chooseMode(next: GameMode) {
    setMode(next);
    // Teams modes default to the Tournament preset, solo modes to Classic.
    if (next === 'online-teams' && preset !== 'tournament') choosePreset('tournament');
    if ((next === 'online-solo' || next === 'offline-solo' || next === 'offline-sim') && preset === 'tournament') {
      choosePreset('classic');
    }
  }

  function start() {
    const humanCount = isOnline ? Math.min(humans, playerCapacity) : mode === 'offline-sim' ? 0 : mode === 'offline-solo' ? 1 : humans;
    const cfg: GameConfig = {
      mapPreset: map,
      mode,
      preset,
      timer,
      fogOfWar: fog,
      blindfold: blind,
      tournament: preset === 'tournament',
      seed: seed.trim() ? Number(seed) : undefined,
      // Point values are canonical: players may never edit them.
      scoring: DEFAULT_SCORING,
      humanPlayers: humanCount,
      playerCount: totalPlayers,
    };
    const botCount = isOnline ? 0 : mode === 'offline-sim' ? bots : mode === 'offline-solo' ? bots : Math.max(0, totalPlayers - humans);
    const all: string[] = [];
    for (let i = 0; i < humanCount; i++) all.push(names[i]?.trim() || `Player ${i + 1}`);
    for (let i = 0; i < botCount; i++) all.push(`Bot ${i + 1}`);
    const lobby: LobbyOptions | undefined = isOnline
      ? {
        visibility,
        password: visibility === 'public' && roomPassword.trim() ? roomPassword.trim() : undefined,
        invites: visibility === 'private'
          ? invites.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
          : [],
      }
      : undefined;
    onStart(cfg, all, lobby);
  }

  return (
    <div className="menu">
      <div className="card card--wide">
        <div className="row row--between">
          <h3>Play</h3>
          <button className="btn btn--sm" onClick={onCancel}>Back</button>
        </div>
        <div className="grid2" style={{ marginTop: 10 }}>
          {MODES.map((m) => (
            <button key={m.id} className="btn" style={{ justifyContent: 'flex-start', textAlign: 'left', borderColor: mode === m.id ? 'var(--accent)' : undefined }}
              onClick={() => chooseMode(m.id)}>
              <span>
                <b>{m.label}</b>
                <div className="small muted">{m.blurb}</div>
              </span>
            </button>
          ))}
        </div>
        {isOnline && <div className="notice" style={{ marginTop: 12 }}>Online games need a signed-in account. {onlineSlot}</div>}
      </div>

      <div className="card card--wide">
        <h3>Preset</h3>
        <div className="grid2" style={{ marginTop: 6 }}>
          {PRESET_LIST.map((p) => (
            <button key={p.id} className="btn" style={{ justifyContent: 'flex-start', textAlign: 'left', borderColor: preset === p.id ? 'var(--accent)' : undefined }}
              onClick={() => choosePreset(p.id)}>
              <span>
                <b>{p.label} mode</b>
                <div className="small muted">{p.blurb}</div>
              </span>
            </button>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>
          Currently: <b>{spec.label}</b> · chat {spec.chat === 'team' ? 'team only' : 'global and team'} ·
          up to {spec.maxTeams} teams of {spec.maxPerTeam} · timers {spec.timers.map((t) => ALL_TIMERS.find((x) => x.id === t)?.label ?? t).join(', ')}.
        </p>
      </div>

      {isOnline && (
        <div className="card card--wide">
          <h3>Seats</h3>
          <label className="field">
            Players in this game ({Math.min(Math.max(humans, PRESETS[preset].minPlayers), playerCapacity)}, min {PRESETS[preset].minPlayers}, max {playerCapacity})
            <input
              type="range"
              min={PRESETS[preset].minPlayers}
              max={playerCapacity}
              value={Math.min(Math.max(humans, PRESETS[preset].minPlayers), playerCapacity)}
              onChange={(e) => setHumans(Number(e.target.value))}
            />
          </label>
          <p className="small muted" style={{ marginTop: 8 }}>
            {preset === 'tournament'
              ? 'Tournament teams: up to 3 players per team, 4 teams — at least 6 players so both sides start full.'
              : 'Classic mode: 1 player per team, up to 12 teams.'}
            {' '}Players join your lobby with their own account, and the game starts when you press Start.
          </p>
        </div>
      )}

      {!isOnline && (
        <>
          <div className="card">
            <h3>Players</h3>
            {mode === 'offline-sim' && (
              <label className="field">Bots ({bots})
                <input type="range" min={1} max={Math.min(12, countries)} value={bots} onChange={(e) => setBots(Number(e.target.value))} />
              </label>
            )}
            {mode === 'offline-solo' && (
              <label className="field">Bots ({bots}) — you plus {bots} bot{bots === 1 ? '' : 's'}
                <input type="range" min={1} max={11} value={bots} onChange={(e) => setBots(Number(e.target.value))} />
              </label>
            )}
            {mode === 'offline-multi' && (
              <label className="field">Local players ({humans}, max 12)
                <input type="range" min={2} max={12} value={humans} onChange={(e) => setHumans(Number(e.target.value))} />
              </label>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>
              Turn order {preset === 'tournament' ? 'alternates between teams' : 'runs in seat order'}.
            </p>
          </div>

          <div className="card">
            <h3>Player names</h3>
            <div className="grid2">
              {Array.from({ length: mode === 'offline-sim' ? 0 : mode === 'offline-solo' ? 1 : humans }, (_, i) => (
                <label key={i} className="field">Player {i + 1}
                  <input type="text" value={names[i]} onChange={(e) => setNames((n) => n.map((x, j) => (j === i ? e.target.value : x)))} />
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h3>Map</h3>
        <label className="field">Selectable continent
          <select value={map} onChange={(e) => setMap(e.target.value as MapPreset)}>
            {MAP_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <p className="small muted" style={{ marginTop: 8 }}>{countries} countries on this map.</p>
        {problem && <div className="notice notice--bad" style={{ marginTop: 8 }}>{problem}</div>}
      </div>

      <div className="card">
        <h3>Turn timer</h3>
        <label className="field">Time per turn
          <select value={allowedTimers.some((t) => t.id === timer) ? timer : allowedTimers[0].id} onChange={(e) => setTimer(e.target.value as TurnTimer)}>
            {allowedTimers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <p className="small muted" style={{ marginTop: 8 }}>Miss the deadline and every territory you own is removed and you are kicked.</p>
      </div>

      <div className="card card--wide">
        <h3>Modifiers</h3>
        <div className="stack">
          <div className="switch"><span>Fog of War <span className="muted small">(×1.5 score)</span></span>
            <div className="toggle" data-on={fog} onClick={() => { setFog(!fog); if (!fog) setBlind(false); }} /></div>
          <div className="switch"><span>Blindfold <span className="muted small">(×2 score)</span></span>
            <div className="toggle" data-on={blind} onClick={() => { setBlind(!blind); if (!blind) setFog(false); }} /></div>
          <div className="small muted">
            {isOnline
              ? 'As the host you choose the modifiers; everyone who joins plays under exactly the same rules.'
              : 'The person starting the game chooses the modifiers for every seat.'} Fog shows only your own countries and troops.
            Blindfold shows no country information at all. Both flash a “!” over a country in a team’s colour when
            something involving that team happens there.
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Reproducibility</h3>
        <label className="field">Seed (optional)
          <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="any number" />
        </label>
        <p className="small muted" style={{ marginTop: 8 }}>The same seed produces the same dice rolls and same game.</p>
      </div>

      {isOnline && (
        <div className="card card--wide">
          <h3>Lobby visibility</h3>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className="btn btn--sm" data-on={visibility === 'public'} onClick={() => setVisibility('public')}>Public</button>
            <button className="btn btn--sm" data-on={visibility === 'private'} onClick={() => setVisibility('private')}>Private</button>
          </div>
          {visibility === 'public' ? (
            <>
              <p className="small muted">Public games show up under “Browse open games” for everyone. You may require a room password.</p>
              <label className="field">Room password (optional)
                <input type="text" value={roomPassword} onChange={(e) => setRoomPassword(e.target.value)} placeholder="leave blank for no password" />
              </label>
            </>
          ) : (
            <>
              <p className="small muted">Private games are hidden from the list. They are sent only to the usernames you list here, who receive an invitation.</p>
              <label className="field">Invite usernames (comma separated)
                <input type="text" value={invites} onChange={(e) => setInvites(e.target.value)} placeholder="e.g. Ada, Grace, Linus" />
              </label>
            </>
          )}
        </div>
      )}

      {isOnline && onlineSlot}

      <div className="card card--wide">
        <div className="btn-row">
          <button className="btn btn--primary" disabled={!!problem} onClick={start}>{isOnline ? 'Create lobby' : 'Start game'}</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
