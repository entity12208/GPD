import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRESETS, teamFor, type GameConfig, type ModePreset } from '../engine/types';
import * as online from '../net/online';
import { sfx } from '../state/sfx';

export interface LobbyViewProps {
  gameId: string;
  userId: string;
  username: string;
  isHost: boolean;
  seat: number;
  capacity: number;
  status: online.LobbyRow['status'];
  config: GameConfig;
  liveChat: boolean;
  /** Fired whenever the polled roster changes, so the host can rebroadcast it. */
  onSeats?: (seats: online.SeatRow[]) => void;
  onStart: () => void;
  onLeave: () => void;
}

const TIMER_LABEL: Record<string, string> = {
  none: 'Disabled (Normal)', '1d': '1d (Daily)', '10min': '10min (Rapid)',
  '5min': '5min (Blitz)', '1min': '1min (Bullet)',
};

function presetOf(config: GameConfig): ModePreset {
  return config.preset ?? (config.tournament ? 'tournament' : 'classic');
}

/**
 * The pre-game lobby. Everyone sits here with a live roster and chat until the
 * host starts the game (or the seats fill up); the host owns the Start button.
 */
export function LobbyPanel(props: LobbyViewProps) {
  const { gameId, userId, isHost, capacity, status, config, liveChat, onSeats, onStart, onLeave } = props;
  const preset = presetOf(config);
  const spec = PRESETS[preset];

  const [seats, setSeats] = useState<online.SeatRow[]>([]);
  const [chat, setChat] = useState<online.ChatMessage[]>([]);
  const [tab, setTab] = useState<'global' | 'team'>(spec.chat === 'team' ? 'team' : 'global');
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const lastRoster = useRef('');

  const refresh = useCallback(async () => {
    const rows = await online.listSeats(gameId);
    setSeats(rows);
    const key = rows.map((r) => `${r.seat}:${r.userId}`).join(',');
    if (key !== lastRoster.current) {
      lastRoster.current = key;
      onSeats?.(rows);
    }
  }, [gameId, onSeats]);

  // The roster is polled rather than pushed so it stays correct even if a
  // Realtime message is missed while somebody is joining.
  useEffect(() => {
    void refresh();
    const h = setInterval(() => void refresh(), 2500);
    return () => clearInterval(h);
  }, [refresh]);

  useEffect(() => {
    void online.listMessages(gameId).then(setChat);
    const cancel = online.subscribeChat(gameId, (m) => setChat((c) => (c.some((x) => x.id === m.id) ? c : [...c, m])));
    return () => cancel();
  }, [gameId]);

  const names = useMemo(() => new Map(seats.map((s) => [s.userId, s.username])), [seats]);
  const myIndex = seats.findIndex((s) => s.userId === userId);
  const myTeam = preset === 'classic' ? myIndex : teamFor(preset, Math.max(0, myIndex), seats.length || 1);
  const minPlayers = spec.minPlayers;
  const ready = seats.length >= minPlayers;
  const full = seats.length >= capacity;
  const needed = Math.max(0, minPlayers - seats.length);

  function send() {
    const body = input.trim();
    if (!body) return;
    const team = tab === 'team' ? myTeam : null;
    setInput('');
    void online.sendMessage(gameId, userId, body, team).then(refresh);
  }

  const visible = liveChat
    ? chat.filter((m) => (tab === 'team' ? m.team === myTeam : m.team === null))
    : chat.filter((m) => m.team === null || m.team === myTeam);

  const teamCount = preset === 'tournament' ? Math.max(1, Math.ceil(seats.length / 3)) : seats.length;

  return (
    <div className="menu">
      <div className="card card--wide">
        <div className="row row--between">
          <h3>{isHost ? 'Your lobby' : 'Waiting for the host'}</h3>
          <div className="btn-row">
            <span className={`pill ${status === 'lobby' ? 'pill--ok' : ''}`}>{status}</span>
            <button
              className="btn btn--sm"
              onClick={() => { void navigator.clipboard?.writeText(gameId); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            >
              {copied ? 'Copied!' : 'Copy game code'}
            </button>
            <button className="btn btn--sm btn--danger" onClick={onLeave}>Leave</button>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          <b>{spec.label}</b> · {config.mapPreset} · {TIMER_LABEL[config.timer] ?? config.timer}
          {(config.fogOfWar || config.blindfold)
            ? ` · ${[config.fogOfWar && 'Fog of War', config.blindfold && 'Blindfold'].filter(Boolean).join(' + ')}`
            : ' · no modifiers'}
          {preset === 'tournament' ? ` · ${teamCount} team${teamCount === 1 ? '' : 's'} of up to ${spec.maxPerTeam}` : ''}
        </p>
        <p className="small muted">
          Chat with the table here while the seats fill. The host starts the game with the button below.
        </p>

        <div className="row row--between" style={{ marginTop: 12 }}>
          <h3 style={{ margin: 0 }}>
            Players {seats.length}/{capacity}
            {full ? ' — full' : ''}
          </h3>
          {isHost && (
            <button
              className="btn btn--primary"
              disabled={!ready}
              title={ready ? 'Start the game' : `Needs ${needed} more player${needed === 1 ? '' : 's'}`}
              onClick={() => { sfx('win'); onStart(); }}
            >
              {ready ? (full ? 'Start game (full)' : 'Start game') : `Waiting for ${needed} more`}
            </button>
          )}
          {!isHost && (
            <span className="pill">{ready ? 'Waiting for the host to start…' : `Needs ${needed} more player${needed === 1 ? '' : 's'}`}</span>
          )}
        </div>

        <table className="data" style={{ marginTop: 10 }}>
          <thead><tr><th>Seat</th><th>Player</th>{preset === 'tournament' && <th>Team</th>}<th>Status</th></tr></thead>
          <tbody>
            {seats.map((s, i) => (
              <tr key={s.userId}>
                <td>{i + 1}</td>
                <td>
                  {s.username}
                  {s.userId === userId ? ' (you)' : ''}
                  {s.seat === 0 ? ' 👑' : ''}
                </td>
                {preset === 'tournament' && <td>Team {teamFor(preset, i, seats.length || 1) + 1}</td>}
                <td>{s.seat === 0 ? 'Host' : 'Ready'}</td>
              </tr>
            ))}
            {Array.from({ length: Math.max(0, minPlayers - seats.length) }, (_, i) => (
              <tr key={`open-${i}`}><td>{seats.length + i + 1}</td><td className="muted">Open seat</td>{preset === 'tournament' && <td className="muted">—</td>}<td className="muted">Waiting</td></tr>
            ))}
          </tbody>
        </table>
        {needed > 0 && (
          <div className="notice" style={{ marginTop: 10 }}>
            {preset === 'tournament'
              ? `Tournament plays teams of ${spec.maxPerTeam}, so ${minPlayers} players are needed so both teams start full.`
              : `A game needs at least ${minPlayers} players.`}
          </div>
        )}
      </div>

      <div className="card card--wide">
        <div className="row row--between">
          <h3>Lobby chat</h3>
          {spec.chat !== 'team' && (
            <div className="btn-row">
              <button className="btn btn--sm" data-on={tab === 'global'} onClick={() => setTab('global')}>Global</button>
              <button className="btn btn--sm" data-on={tab === 'team'} onClick={() => setTab('team')}>Team</button>
            </div>
          )}
        </div>
        <div className="chat">
          <div className="chat__list">
            {visible.map((m) => (
              <div key={m.id} className="chat__msg">
                <b>{names.get(m.user_id ?? '') ?? (m.user_id === userId ? props.username : 'Player')}{m.team !== null ? ` (Team ${m.team + 1})` : ''}:</b> {m.body}
              </div>
            ))}
            {!visible.length && <div className="muted small">Nothing said yet — say hello.</div>}
          </div>
          <div className="chat__form">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="Message the lobby"
            />
            <button className="btn btn--sm" onClick={send}>Send</button>
          </div>
          {spec.chat === 'team' && <span className="small muted">Tournament mode: team chat only.</span>}
        </div>
      </div>
    </div>
  );
}
