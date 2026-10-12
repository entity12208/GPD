import { useEffect, useMemo, useState } from 'react';
import { MAP_PRESETS } from '../engine/data';
import { isSupabaseConfigured, supabase } from '../net/supabase';
import * as online from '../net/online';
import { computeStats, localLeaderboard, type CareerStats, type LocalProfile } from '../state/local';
import type { SavedGameMeta } from '../state/saved';
import type { OnlineSession } from '../state/sessions';
import type { Settings } from '../state/settings';
import type { GameResult } from './GameScreen';
import { sfx } from '../state/sfx';

export function Section({ title, children, onBack }: { title: string; children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="menu">
      <div className="card card--wide">
        <div className="row row--between">
          <h3>{title}</h3>
          <button className="btn btn--sm" onClick={onBack}>Back</button>
        </div>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ settings */
export function SettingsPanel({ settings, onChange, onBack }: { settings: Settings; onChange: (s: Settings) => void; onBack: () => void }) {
  return (
    <Section title="Settings" onBack={onBack}>
      <div className="card">
        <h3>Display</h3>
        <label className="field">Frame rate
          <select value={settings.fps} onChange={(e) => onChange({ ...settings, fps: Number(e.target.value) as 30 | 60 })}>
            <option value={30}>30 FPS</option>
            <option value={60}>60 FPS</option>
          </select>
        </label>
        <p className="small muted" style={{ marginTop: 8 }}>Controls how often the board refreshes. 30 FPS is friendlier on low-power machines.</p>
      </div>
      <div className="card">
        <h3>Audio</h3>
        <label className="field">SFX volume — {Math.round(settings.sfxVolume * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={settings.sfxVolume}
            onChange={(e) => { onChange({ ...settings, sfxVolume: Number(e.target.value) }); }} />
        </label>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn btn--sm" onClick={() => sfx('battle')}>Test SFX</button>
        </div>
      </div>
      <div className="card">
        <h3>Gameplay</h3>
        <div className="stack">
          <div className="switch"><span>Enable live chat</span>
            <div className="toggle" data-on={settings.liveChat} onClick={() => onChange({ ...settings, liveChat: !settings.liveChat })} /></div>
          <div className="switch"><span>Show troop counts on the map</span>
            <div className="toggle" data-on={settings.showTroopCounts} onClick={() => onChange({ ...settings, showTroopCounts: !settings.showTroopCounts })} /></div>
        </div>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------------- rules */
export function RulesPanel({ onBack }: { onBack: () => void }) {
  return (
    <Section title="Rules" onBack={onBack}>
      <div className="card card--wide rules">
        <h3>General</h3>
        <ul>
          <li><b>Win condition:</b> be the last player alive on the map (the last team alive in Tournament mode).</li>
          <li><b>Starting money:</b> $500.</li>
          <li><b>Before the first turn</b> every player picks any country as their starting country. It is highlighted in their colour and starts with 1 troop.</li>
          <li><b>Leaving and resuming:</b> an offline game offers <b>Save &amp; exit</b>, which stores it so you can resume it later from the menu exactly where you left off, or <b>Leave game</b>, which asks for confirmation and abandons it for good. An online game instead offers <b>Step away</b> — your seat is kept on the server, the board waits for you, and you are notified when it is your turn — or <b>Forfeit the game</b>, which gives up your seat for good.</li>
          <li><b>Online lobbies:</b> a hosted game opens as a lobby with a live roster of real usernames and a lobby chat. Everyone waits there until the host presses <b>Start game</b>, which is available once the lobby has the minimum number of players (or is full).</li>
          <li><b>Turn reminders:</b> when it becomes your turn in an online game you get an in-app alert, a desktop notification and an entry in <b>Notifications</b>, so you can step away and come back when it is your move.</li>
        </ul>
        <h3>On your turn — pick one of four actions</h3>
        <ul>
          <li><b>1. Peace.</b> At the beginning of your next turn you collect $100 per territory you own, plus an extra $10 × countries in the continent for every continent you fully own. The country you declare Peace in is <i>vulnerable</i> until your next turn.</li>
          <li><b>2. Gather Troops.</b> Distribute X troops across your countries, where X is your choice between 1 and a fresh <span className="mono">random(1,20)</span> draw. Each troop costs $50.</li>
          <li><b>3. Expand.</b> Pick a country you own, then a country you do not. Pay $100 to send up to one less than all of the troops on the first country. Add $100 when crossing a body of water, and $50 per troop when crossing a major ocean. Every troop has a 1-in-10 chance of dying on a water journey. You cannot expand through other countries. Typed orders are mandatory: type the destination country's name exactly — a mis-spelling loses your turn. Under Fog of War or Blindfold you can only ever be asked to spell a name you have actually been shown, so an order into an unidentified territory is never failed on spelling.
            <ul>
              <li>Into an unoccupied country: claim it.</li>
              <li>Into a <b>vulnerable</b> country: kill all occupants and take it.</li>
              <li>Into a <b>non-vulnerable</b> occupied country: every troop on both sides rolls 1–20; the highest total takes the country and all opposing troops die.</li>
            </ul>
          </li>
          <li><b>4. Nothing.</b> Do nothing. Your countries are not vulnerable.</li>
        </ul>
        <h3>Turn timers</h3>
        <ul>
          <li>Each player has a set time per turn. Miss it and you are kicked, removing all of your territories from the map.</li>
          <li><b>Classic Mode:</b> global and team chat. Timers: Disabled (Normal), 1d (Daily), 10min (Rapid), 5min (Blitz), 1min (Bullet). Max 1 player per team, 12 teams.</li>
          <li><b>Tournament Mode:</b> team chat only. Timers: 1d, 10min, 5min. Max 3 players per team, 4 teams — and at least <b>6 players</b>, so both sides start with a full team. The turn belongs to the <b>team</b>: when it is your team's turn, <b>any living teammate may make the move</b>, played with the acting player's countries and money.</li>
        </ul>
        <h3>Modifiers</h3>
        <ul>
          <li><b>Fog of War</b> (score ×1.5): shows only the countries you own and their troops; a brief “!” in a team’s colour appears over a country when something involving that team happens there. No other information is shown, and you are never told the name of a country you have not claimed — it reads as <i>Unidentified territory</i> in the map tooltip, the turn log and every message.</li>
          <li><b>Blindfold</b> (score ×2): shows no country information at all — only the “!” markers, and no country names of any kind.</li>
        </ul>
        <h3>Scoring</h3>
        <ul>
          <li>Your global score is the sum of all of your game scores, and the leaderboard ranks by global score.</li>
          <li>Claim an unoccupied country +50 · lose a country −50 · claim a previously occupied country +75 · fail to win a country −20 · claim a continent +200 · win a game +500 · lose a game −200.</li>
          <li>The calculation system can recalculate every total from a different set of calculations, but only an operator with server access can do so — players cannot change point values.</li>
        </ul>
        <h3>Selectable continents</h3>
        <ul>{MAP_PRESETS.map((p) => <li key={p.id}><b>{p.label}</b> — {p.blurb}</li>)}</ul>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------------- stats */
export function StatsPanel({ games, profile, onBack }: { games: GameResult[]; profile: LocalProfile | null; onBack: () => void }) {
  const stats: CareerStats = useMemo(() => computeStats(games, profile?.username ?? null), [games, profile]);
  return (
    <Section title="Stats" onBack={onBack}>
      <div className="card card--wide">
        <div className="stats-grid">
          <div className="stat"><b>{stats.games}</b><span>Games played</span></div>
          <div className="stat"><b>{stats.wins}</b><span>Wins</span></div>
          <div className="stat"><b>{stats.losses}</b><span>Losses</span></div>
          <div className="stat"><b>{stats.points}</b><span>Total points</span></div>
          <div className="stat"><b>{stats.bestScore}</b><span>Best single game</span></div>
        </div>
      </div>
      <div className="card card--wide">
        <h3>Recent games</h3>
        <table className="data">
          <thead><tr><th>When</th><th>Mode</th><th>Map</th><th>Winner</th><th>Rounds</th></tr></thead>
          <tbody>
            {games.slice(0, 12).map((g, i) => (
              <tr key={i}>
                <td>{new Date(g.finishedAt).toLocaleString()}</td>
                <td>{g.mode}</td>
                <td>{g.mapPreset}</td>
                <td>{g.standings.find((p) => p.id === g.winner)?.name ?? '—'}</td>
                <td>{g.rounds}</td>
              </tr>
            ))}
            {!games.length && <tr><td colSpan={5} className="muted">No games yet — play one to fill this in.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- leaderboard */
export function LeaderboardPanel({ games, profile, onBack }: { games: GameResult[]; profile: LocalProfile | null; onBack: () => void }) {
  const [remote, setRemote] = useState<{ username: string; global_score: number; rank: number }[]>([]);
  const [tab, setTab] = useState<'local' | 'online'>('local');

  useEffect(() => {
    if (tab === 'online' && isSupabaseConfigured) {
      void online.fetchLeaderboard(50).then((rows) => setRemote(rows as { username: string; global_score: number; rank: number }[]));
    }
  }, [tab]);

  // Bots are never ranked; localLeaderboard filters them out.
  const rows = useMemo(() => localLeaderboard(games), [games]);

  return (
    <Section title="Leaderboard" onBack={onBack}>
      <div className="card card--wide">
        <div className="tabs" style={{ padding: 0, marginBottom: 10 }}>
          <button data-active={tab === 'local'} onClick={() => setTab('local')}>Local</button>
          <button data-active={tab === 'online'} onClick={() => setTab('online')}>Online</button>
        </div>

        {tab === 'local' ? (
          <>
            <table className="data">
              <thead><tr><th>#</th><th>Player</th><th>Global score (pts)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.username}>
                    <td>{i + 1}</td>
                    <td>{r.username}{profile?.username === r.username ? ' (you)' : ''}</td>
                    <td className="mono">{r.score}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={3} className="muted">Nothing ranked yet.</td></tr>}
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 14 }}>
              Scoring is fixed by the rules engine; players cannot change point values. Only a server operator can
              recalculate the leaderboard from a different set of calculations.
            </p>
          </>
        ) : (
          <>
            {!isSupabaseConfigured && <div className="notice notice--warn">Supabase is not configured; the online leaderboard is unavailable.</div>}
            {isSupabaseConfigured && (
              <table className="data">
                <thead><tr><th>Rank</th><th>Player</th><th>Global score</th></tr></thead>
                <tbody>
                  {remote.map((r) => <tr key={r.username}><td>{r.rank}</td><td>{r.username}</td><td className="mono">{r.global_score}</td></tr>)}
                  {!remote.length && <tr><td colSpan={3} className="muted">No ranked accounts yet.</td></tr>}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------- friends */
export function FriendsPanel({ profile, onBack }: { profile: LocalProfile | null; onBack: () => void }) {
  const [rows, setRows] = useState<{ friend_id: string; status: string; profiles?: { username: string } }[]>([]);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (profile?.remoteId) void online.listFriends(profile.remoteId).then((r) => setRows(r as never));
  }, [profile]);

  async function add() {
    if (!profile?.remoteId) return;
    const { data } = await supabase!.from('profiles').select('id, username').ilike('username', name.trim()).maybeSingle();
    if (!data) { setMsg(`No player named “${name}”.`); return; }
    await online.addFriend(profile.remoteId, (data as { id: string }).id);
    setMsg(`Friend request sent to ${name}.`);
    setName('');
  }

  return (
    <Section title="Friends" onBack={onBack}>
      <div className="card card--wide">
        {!profile?.remoteId && <div className="notice notice--warn">Sign in with an online account to use friends.</div>}
        {profile?.remoteId && (
          <>
            <div className="row">
              <input type="text" placeholder="Search username…" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn--primary" onClick={() => void add()}>Add friend</button>
            </div>
            {msg && <div className="notice" style={{ marginTop: 10 }}>{msg}</div>}
            <table className="data" style={{ marginTop: 12 }}>
              <thead><tr><th>Player</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => <tr key={r.friend_id}><td>{r.profiles?.username ?? r.friend_id}</td><td>{r.status}</td></tr>)}
                {!rows.length && <tr><td colSpan={2} className="muted">No friends yet.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- notifications */
export function NotificationsPanel({ profile, onBack }: { profile: LocalProfile | null; onBack: () => void }) {
  const [rows, setRows] = useState<{ id: number; kind: string; body: string; read: boolean; created_at: string }[]>([]);
  useEffect(() => {
    if (profile?.remoteId) void online.listNotifications(profile.remoteId).then((r) => setRows(r as never));
  }, [profile]);
  return (
    <Section title="Notifications" onBack={onBack}>
      <div className="card card--wide">
        {!profile?.remoteId && <div className="notice notice--warn">Sign in to receive invitations, friend requests and turn reminders.</div>}
        <div className="stack" style={{ marginTop: 12 }}>
          {rows.map((n) => (
            <div key={n.id} className="notice" style={{ opacity: n.read ? 0.6 : 1 }}>
              <div className="row row--between">
                <b>{n.kind}</b>
                <span className="small muted">{new Date(n.created_at).toLocaleString()}</span>
              </div>
              <div>{n.body}</div>
              {!n.read && <button className="btn btn--sm" style={{ marginTop: 6 }} onClick={async () => { await online.markNotificationRead(n.id); setRows((r) => r.map((x) => x.id === n.id ? { ...x, read: true } : x)); }}>Mark read</button>}
            </div>
          ))}
          {profile?.remoteId && !rows.length && <div className="muted">Nothing here yet.</div>}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ my games */
export function MyGamesPanel({ games, profile, onBack }: { games: GameResult[]; profile: LocalProfile | null; onBack: () => void }) {
  const [remote, setRemote] = useState<{ game_id: string; seat: number; team: number; score: number; games?: { mode: string; map_preset: string; status: string; created_at: string } }[]>([]);
  useEffect(() => {
    if (profile?.remoteId) void online.myGames(profile.remoteId).then((r) => setRemote(r as never));
  }, [profile]);
  return (
    <Section title="My Games" onBack={onBack}>
      <div className="card card--wide">
        <h3>On this device</h3>
        <table className="data">
          <thead><tr><th>When</th><th>Mode</th><th>Map</th><th>Result</th></tr></thead>
          <tbody>
            {games.map((g, i) => (
              <tr key={i}>
                <td>{new Date(g.finishedAt).toLocaleString()}</td>
                <td>{g.mode}</td>
                <td>{g.mapPreset}</td>
                <td>{g.standings.find((p) => p.id === g.winner)?.name ?? 'draw'}</td>
              </tr>
            ))}
            {!games.length && <tr><td colSpan={4} className="muted">No local games.</td></tr>}
          </tbody>
        </table>
        {profile?.remoteId && (
          <>
            <h3 style={{ marginTop: 18 }}>Online</h3>
            <table className="data">
              <thead><tr><th>Started</th><th>Mode</th><th>Map</th><th>Status</th><th>Score</th></tr></thead>
              <tbody>
                {remote.map((g) => (
                  <tr key={g.game_id}>
                    <td>{g.games ? new Date(g.games.created_at).toLocaleString() : '—'}</td>
                    <td>{g.games?.mode ?? '—'}</td>
                    <td>{g.games?.map_preset ?? '—'}</td>
                    <td>{g.games?.status ?? '—'}</td>
                    <td className="mono">{g.score}</td>
                  </tr>
                ))}
                {!remote.length && <tr><td colSpan={5} className="muted">No online games.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------- online  */
export function OnlinePanel({ profile, sessions, onJoin, onRejoin, onForget, onBack }: {
  profile: LocalProfile | null;
  sessions: OnlineSession[];
  onJoin: (lobbyId: string, password?: string) => void;
  onRejoin: (session: OnlineSession) => void;
  onForget: (gameId: string) => void;
  onBack: () => void;
}) {
  const [lobbies, setLobbies] = useState<online.LobbyRow[]>([]);
  const [invitations, setInvitations] = useState<{ game_id: string; games?: { mode: string; map_preset: string; preset: string; timer: string; created_at: string } }[]>([]);
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  async function refresh() {
    if (!isSupabaseConfigured) return;
    setLobbies(await online.listLobbies());
    if (profile?.remoteId) setInvitations(await online.listInvitations(profile.remoteId) as never);
  }
  useEffect(() => { void refresh(); const h = setInterval(() => void refresh(), 5000); return () => clearInterval(h); }, [profile?.remoteId]);

  function join(row: online.LobbyRow) {
    if (row.has_password) { setPasswordFor(row.id); setPassword(''); return; }
    onJoin(row.id);
  }

  const openCount = lobbies.length;
  const waitingOnYou = sessions.filter((s) => s.status === 'active');

  return (
    <Section title="Online Multiplayer" onBack={onBack}>
      {!isSupabaseConfigured && (
        <div className="card card--wide">
          <div className="notice notice--warn">Supabase is not configured, so online play is disabled. Offline modes still work.</div>
        </div>
      )}

      {profile?.remoteId && (
        <div className="card card--wide">
          <div className="row row--between">
            <h3>Your online games</h3>
            <span className="pill">{sessions.length}</span>
          </div>
          <p className="small muted">
            Online games live on the server, so leaving one does not abandon it. Rejoin here and you are
            dropped straight back into the lobby or the board, on your own seat, with the dice exactly where they were.
          </p>
          <table className="data" style={{ marginTop: 10 }}>
            <thead><tr><th>Preset</th><th>Map</th><th>Seat</th><th>Status</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.gameId}>
                  <td>{s.preset === 'tournament' ? 'Tournament' : 'Classic'}{s.isHost ? ' (host)' : ''}</td>
                  <td>{s.mapPreset}</td>
                  <td>{s.seat + 1}</td>
                  <td>
                    {s.status === 'finished' ? 'Finished'
                      : s.status === 'lobby' ? 'In lobby'
                        : s.status === 'placement' ? 'Placement'
                          : 'In progress'}
                    {s.status === 'active' && <span className="pill pill--ok" style={{ marginLeft: 8 }}>your turn soon</span>}
                  </td>
                  <td>
                    <div className="btn-row">
                      <button className="btn btn--primary btn--sm" onClick={() => onRejoin(s)}>Rejoin</button>
                      <button className="btn btn--sm" onClick={() => onForget(s.gameId)}>Forget</button>
                    </div>
                  </td>
                </tr>
              ))}
              {!sessions.length && <tr><td colSpan={5} className="muted">No online games yet — host one or join from the list below.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {profile?.remoteId && (
        <div className="card card--wide">
          <h3>Invitations</h3>
          <p className="small muted">Private games are sent to specific usernames and only show up here for the players invited.</p>
          <table className="data">
            <thead><tr><th>Mode</th><th>Preset</th><th>Map</th><th>Timer</th><th /></tr></thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.game_id}>
                  <td>{inv.games?.mode ?? '—'}</td>
                  <td>{inv.games?.preset === 'tournament' ? 'Tournament' : 'Classic'}</td>
                  <td>{inv.games?.map_preset ?? '—'}</td>
                  <td>{inv.games?.timer ?? '—'}</td>
                  <td><button className="btn btn--sm" onClick={() => onJoin(inv.game_id)}>Join</button></td>
                </tr>
              ))}
              {!invitations.length && <tr><td colSpan={5} className="muted">No invitations.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <div className="card card--wide">
        <div className="row row--between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Open games {openCount ? <span className="pill" style={{ marginLeft: 6 }}>{openCount}</span> : null}</h3>
          <div className="btn-row">
            <button className="btn btn--sm" onClick={() => void refresh()}>Refresh</button>
            <button className="btn btn--primary btn--sm" onClick={onBack}>Host a game</button>
          </div>
        </div>
        <table className="data">
          <thead><tr><th>Visibility</th><th>Preset</th><th>Map</th><th>Timer</th><th>Modifiers</th><th>Access</th><th>Players</th><th>Status</th><th /></tr></thead>
          <tbody>
            {lobbies.map((l) => (
              <tr key={l.id}>
                <td>{l.visibility === 'private' ? 'Private' : 'Public'}</td>
                <td>{l.preset === 'tournament' ? 'Tournament' : 'Classic'}</td>
                <td>{l.map_preset}</td>
                <td>{l.timer}</td>
                <td>{[l.fog_of_war && 'Fog', l.blindfold && 'Blindfold'].filter(Boolean).join(', ') || '—'}</td>
                <td>{l.has_password ? 'Password' : 'Open'}</td>
                <td>{l.seated ?? '—'}/{l.capacity ?? 12}</td>
                <td>{l.status === 'lobby' ? 'Filling' : l.status}</td>
                <td><button className="btn btn--sm" onClick={() => join(l)}>Join</button></td>
              </tr>
            ))}
            {!lobbies.length && <tr><td colSpan={9} className="muted">No open games right now — host one and it appears here.</td></tr>}
          </tbody>
        </table>

        {passwordFor && (
          <div className="row" style={{ marginTop: 12 }}>
            <input type="password" placeholder="Room password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn btn--primary btn--sm" onClick={() => { const id = passwordFor; setPasswordFor(null); onJoin(id, password); }}>Join</button>
            <button className="btn btn--sm" onClick={() => setPasswordFor(null)}>Cancel</button>
          </div>
        )}
        {!!waitingOnYou.length && <p className="small muted" style={{ marginTop: 10 }}>{waitingOnYou.length} game(s) in progress are waiting on their players.</p>}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------- resume */
export function ResumePanel({ saved, onResume, onDelete, onBack }: { saved: SavedGameMeta[]; onResume: (id: string) => void; onDelete: (id: string) => void; onBack: () => void }) {
  return (
    <Section title="Resume" onBack={onBack}>
      <div className="card card--wide">
        <p className="small muted">
          Games you exited with “Save &amp; exit” are kept here and resume exactly where you left off — the same
          dice rolls, the same scores and a fresh turn clock.
        </p>
        <table className="data">
          <thead><tr><th>Saved</th><th>Map</th><th>Mode</th><th>Preset</th><th>Round</th><th>Alive</th><th /></tr></thead>
          <tbody>
            {saved.map((g) => (
              <tr key={g.id}>
                <td>{new Date(g.savedAt).toLocaleString()}</td>
                <td>{g.mapPreset}</td>
                <td>{g.mode}</td>
                <td>{g.preset === 'tournament' ? 'Tournament' : 'Classic'}</td>
                <td>{g.round}</td>
                <td>{g.aliveCount}/{g.players.length}</td>
                <td>
                  <div className="btn-row">
                    <button className="btn btn--primary btn--sm" onClick={() => onResume(g.id)}>Resume</button>
                    <button className="btn btn--sm" onClick={() => onDelete(g.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {!saved.length && <tr><td colSpan={7} className="muted">No saved games yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
