import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { graphForPreset } from '../engine/data';
import { canSeeName, hiddenNameMap, nameFor, redact } from '../engine/vision';
import { TROOP_COST } from '../engine/game';
import type { GameConfig, GameEvent } from '../engine/types';
import { DEFAULT_SCORING } from '../engine/scoring';
import type { GameRunner } from '../state/runner';
import type { Settings } from '../state/settings';
import { sfx } from '../state/sfx';
import * as net from '../net/online';
import { WorldMap, type VisionEntry } from './WorldMap';

export interface GameResult {
  mode: GameConfig['mode'];
  mapPreset: GameConfig['mapPreset'];
  winner: number | null;
  winningTeam: number | null;
  rounds: number;
  standings: { id: number; name: string; score: number; territories: number; isBot: boolean }[];
  /** Raw scoring events, so any rule set can recalculate these totals later. */
  scoreEvents: { player: number; key: string }[];
  /** Score multiplier that was in force (1, 1.5 for Fog of War, 2 for Blindfold). */
  multiplier: number;
  finishedAt: string;
}

interface Props {
  runner: GameRunner;
  settings: Settings;
  onExit: () => void;
  /** Save the game and return to the menu; offline games can be resumed later. */
  onSaveExit?: () => void;
  /** False for online games, which live on the server instead of a local snapshot. */
  canResume?: boolean;
  onFinish?: (r: GameResult) => void;
  onReplay?: () => void;
  /** Online: step away but keep the seat, so the game can be rejoined. */
  onStepAway?: () => void;
  /** Online: quit for good and give up the seat. */
  onForfeit?: () => void;
  online?: { gameId: string; userId: string; meSeat: number; names: Record<string, string> };
}

const EVENT_SFX: Record<string, Parameters<typeof sfx>[0]> = {
  combat: 'battle', claim: 'claim', expand: 'expand', win: 'win', loss: 'lose',
  income: 'coin', peace: 'peace', timeout: 'lose', forfeit: 'error', turn: 'turn', continent: 'win',
};

export function GameScreen({ runner, settings, onExit, onSaveExit, canResume = false, onFinish, onReplay, onStepAway, onForfeit, online }: Props) {
  useSyncExternalStore(runner.subscribe, runner.getSnapshot, () => 0);
  const game = runner.game;
  const s = game.state;

  const [mode, setMode] = useState<'idle' | 'peace' | 'expand' | 'gather'>('idle');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [send, setSend] = useState(1);
  const [dist, setDist] = useState<Record<string, number>>({});
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [chatTab, setChatTab] = useState<'global' | 'team'>('global');
  const [chat, setChat] = useState<{ name: string; body: string; team: number | null }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [hudTab, setHudTab] = useState<'log' | 'players' | 'chat'>('log');
  const [exitOpen, setExitOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const pausedBeforeExit = useRef(false);
  const finishedRef = useRef(false);

  const actor = game.actor;
  const humanSeats = useMemo(
    () => s.players.filter((p) => !p.isBot).map((p) => p.id),
    [s.players],
  );
  const viewerId = online ? online.meSeat : (actor && !actor.isBot ? actor.id : (humanSeats[0] ?? 0));
  const myName = online ? (s.players[viewerId]?.name ?? 'you') : (s.players[viewerId]?.name ?? 'Player');
  /**
   * In Tournament mode the turn belongs to a team, so any living member of the
   * acting player's team may move for it. Placement still belongs to the player
   * picking their own starting country.
   */
  const isMyTurn = online
    ? (s.phase === 'placement' ? actor?.id === online.meSeat : !!actor && game.canAct(online.meSeat))
    : !!actor && !actor.isBot;
  const movingForTeam = !!online && !!actor && actor.id !== online.meSeat;

  /** Resolve a chat author to the username the roster knows. */
  function nameOf(userId: string | null | undefined): string {
    if (!userId) return 'Player';
    return online?.names[userId] ?? 'Player';
  }

  // sound effects + outcome reporting
  useEffect(() => {
    runner.onEvent = (e: GameEvent) => {
      const name = EVENT_SFX[e.type];
      if (name) sfx(name);
      if (e.text) setChat((c) => c); // log handled separately
    };
    return () => { runner.onEvent = null; };
  }, [runner]);

  useEffect(() => {
    if (s.phase !== 'finished' || finishedRef.current) return;
    finishedRef.current = true;
    setShowResults(true);
    const result: GameResult = {
      mode: s.config.mode,
      mapPreset: s.config.mapPreset,
      winner: s.winner,
      winningTeam: s.winningTeam,
      rounds: s.round,
      standings: s.players.map((p) => ({
        id: p.id, name: p.name, score: p.score,
        territories: game.ownedBy(p.id).length, isBot: p.isBot,
      })),
      scoreEvents: s.scoreEvents.map((e) => ({ player: e.player, key: e.key })),
      multiplier: s.config.blindfold ? 2 : s.config.fogOfWar ? 1.5 : 1,
      finishedAt: new Date().toISOString(),
    };
    onFinish?.(result);
  }, [s.phase, s.round, s.winner, s.config.mode, s.config.mapPreset, s.players, game, onFinish]);

  const vision = useMemo(() => {
    const v = game.viewFor(viewerId);
    return v as { visible: Record<string, VisionEntry>; markers: { territory: string; team: number; isMine: boolean }[] };
  }, [game, viewerId, runner.version, s.round, s.phase]);

  /** Country names this viewer must not see, computed once per render. */
  const hidden = useMemo(() => hiddenNameMap(game, viewerId), [game, viewerId, runner.version, s.round, s.phase]);
  const label = (id: string | null | undefined) => (id ? nameFor(game, viewerId, id) : '—');
  /** Engine errors and log lines can carry names, so they are redacted first. */
  const show = (text: string) => setError(redact(text, hidden));

  const targets = useMemo(() => {
    const set = new Set<string>();
    if (mode !== 'expand' || !from || !isMyTurn) return set;
    for (const lane of graphForPreset(s.config.mapPreset).adj[from] ?? []) {
      const q = game.quoteExpand(actor!.id, from, lane.id, 1);
      if (!('error' in q)) set.add(lane.id);
    }
    return set;
  }, [mode, from, game, s.config.mapPreset, isMyTurn, actor]);

  const quote = from && to ? game.quoteExpand(actor?.id ?? viewerId, from, to, Math.max(1, send)) : null;
  const maxSend = from ? Math.max(0, (s.territories[from]?.troops ?? 0) - 1) : 0;

  useEffect(() => { setSend((v) => Math.max(1, Math.min(v, Math.max(1, maxSend)))); }, [maxSend]);

  function clickCountry(id: string) {
    if (!isMyTurn) return;
    if (s.phase === 'placement') {
      setError(null);
      const res = runner.dispatch({ t: 'place', country: id }, () => game.placeStartingCountry(actor!.id, id));
      if (!res.ok) show(res.error ?? 'Cannot start there');
      return;
    }
    if (s.phase !== 'awaiting-action') return;
    const t = s.territories[id];
    sfx('click');
    if (mode === 'peace') {
      if (t.owner === actor!.id) {
        const res = runner.dispatch({ t: 'peace', territory: id }, () => game.submitPeace(id));
        if (!res.ok) show(res.error ?? 'Cannot declare Peace there');
      } else show('Peace must be declared in a country you own');
      return;
    }
    if (mode !== 'expand') { setMode('expand'); }
    if (t.owner === actor!.id) { setFrom(id); setTo(null); setError(null); return; }
    if (!from) { show('Select one of your own countries first'); return; }
    if (!targets.has(id)) { show(`${label(id)} does not border ${label(from)}`); return; }
    setTo(id);
    setError(null);
  }

  const targetHidden = !!to && !canSeeName(game, viewerId, to);
  /** Typed orders are mandatory — except for a name the player was never shown. */
  const needsTyped = !!to && !targetHidden;

  function doExpand() {
    if (!from || !to || (needsTyped && !typed.trim())) return;
    const res = runner.dispatch(
      { t: 'expand', from, to, troops: send, typed },
      () => game.submitExpand(from, to, send, typed),
    );
    if (!res.ok) show(res.error ?? 'Cannot expand');
    else { setFrom(null); setTo(null); setTyped(''); setMode('idle'); }
  }

  // Escape closes whichever dialog is open, like every other game.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (exitOpen) { setConfirmLeave(false); setExitOpen(false); runner.paused = pausedBeforeExit.current; }
      else if (showResults) setShowResults(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exitOpen, showResults, runner]);

  // One-key actions while it is your turn (never while typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!isMyTurn || s.phase !== 'awaiting-action' || mode !== 'idle') return;
      const k = e.key.toLowerCase();
      if (k === 'p') doPeace();
      else if (k === 'g') doGatherStart();
      else if (k === 'e') { setMode('expand'); setError(null); }
      else if (k === 'n') doNothing();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function openExit() {
    pausedBeforeExit.current = runner.paused;
    runner.paused = true;
    setConfirmLeave(false);
    setExitOpen(true);
    forceTick((x) => x + 1);
  }

  function cancelExit() {
    runner.paused = pausedBeforeExit.current;
    setExitOpen(false);
    forceTick((x) => x + 1);
  }

  function doPeace() { setMode('peace'); setError(null); }

  function doGatherStart() {
    const res = runner.dispatch({ t: 'choose', action: 'gather' }, () => game.chooseAction('gather'));
    if (!res.ok) show(res.error ?? 'Cannot gather');
    else { setMode('gather'); setDist({}); setError(null); }
  }

  function doNothing() { setMode('idle'); runner.dispatch({ t: 'nothing' }, () => game.submitNothing()); }

  function confirmGather() {
    const res = runner.dispatch({ t: 'gather', distribution: dist }, () => game.submitGather(dist));
    if (!res.ok) show(res.error ?? 'Cannot gather');
    else { setMode('idle'); setDist({}); }
  }

  const owned = actor ? game.ownedBy(actor.id) : [];
  const gatherTotal = Object.values(dist).reduce((a, b) => a + b, 0);
  const log = useMemo(
    () => s.log.filter((e) => e.text).slice(-120).reverse().map((e) => ({ ...e, text: redact(e.text, hidden) })),
    [s.log, hidden],
  );
  const timerLeft = s.turnDeadline ? Math.max(0, Math.ceil((s.turnDeadline - Date.now()) / 1000)) : null;
  const [, forceTick] = useState(0);

  useEffect(() => {
    const h = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const teamColors = useMemo(() => {
    const m: Record<number, string> = {};
    for (const p of s.players) m[p.team] = p.color;
    return m;
  }, [s.players]);

  function sendChat() {
    if (!chatInput.trim()) return;
    const team = chatTab === 'team' ? (online ? s.players[online.meSeat].team : actor?.team ?? s.players[viewerId].team) : null;
    setChat((c) => [...c, { name: myName, body: chatInput.trim(), team }]);
    if (online) void net.sendMessage(online.gameId, online.userId, chatInput.trim(), team);
    setChatInput('');
  }

  // Online chat: load what was said while we were away, then follow it live.
  useEffect(() => {
    if (!online) return;
    const seen = new Set<number>();
    void net.listMessages(online.gameId).then((rows) => {
      for (const m of rows) {
        seen.add(m.id);
        if (m.user_id === online.userId) continue;
        setChat((c) => [...c, { name: nameOf(m.user_id), body: m.body, team: m.team }]);
      }
    });
    const cancel = net.subscribeChat(online.gameId, (msg) => {
      if (msg.user_id === online.userId || seen.has(msg.id)) return;
      seen.add(msg.id);
      setChat((c) => [...c, { name: nameOf(msg.user_id), body: msg.body, team: msg.team }]);
    });
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online?.gameId, online?.userId]);

  const myTeam = s.players[viewerId]?.team;
  const visibleChat = settings.liveChat ? chat.filter((m) => m.team === null || m.team === myTeam) : [];

  const turnLabel = s.phase === 'placement'
    ? `Placement — ${actor ? actor.name : ''} picks a starting country`
    : s.phase === 'finished'
      ? 'Game over'
      : s.config.tournament && actor
        ? `Team ${actor.team + 1}'s turn — ${actor.name} is up (any teammate may move)`
        : `${actor?.name ?? ''}'s turn`;

  return (
    <div className="game">
      <div className="stack">
        <div className="turnbar" data-mine={isMyTurn}>
          <span className="turnbar__dot" style={{ background: actor?.color ?? '#555', color: actor?.color ?? '#555' }} />
          <strong>{turnLabel}</strong>
          <span className="pill">Round {s.round}</span>
          <span className="pill">{s.config.mapPreset}</span>
          {s.config.fogOfWar && <span className="pill pill--off">Fog of War ×1.5</span>}
          {s.config.blindfold && <span className="pill pill--off">Blindfold ×2</span>}
          <span className="topbar__spacer" />
          {timerLeft !== null && (
            <span className={`timer ${timerLeft < 15 ? 'timer--low' : ''}`}>
              ⏱ {Math.floor(timerLeft / 60)}:{String(timerLeft % 60).padStart(2, '0')}
            </span>
          )}
          <button className="btn btn--sm" onClick={() => { runner.paused = !runner.paused; forceTick((x) => x + 1); }}>
            {runner.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="btn btn--sm" onClick={openExit}>Exit</button>
        </div>

        {(s.config.fogOfWar || s.config.blindfold) && (
          <div className="notice notice--warn">
            <b>{s.config.blindfold ? 'Blindfold' : 'Fog of War'} is on.</b> You only ever see the names of countries
            you have claimed; everything else is an unidentified territory. A name you were never shown does not have
            to be spelled out when you give an Expand order.
          </div>
        )}

        <div className="board">
          <WorldMap
            active={s.active}
            vision={vision.visible}
            colors={s.players.map((p) => p.color)}
            teamColors={teamColors}
            markers={vision.markers}
            selected={from}
            targets={targets}
            showTroops={settings.showTroopCounts}
            labelFor={label}
            onSelect={clickCountry}
          />
        </div>

        <div className="legend">
          <span><i style={{ background: '#2b3b4d' }} /> unclaimed</span>
          <span><i style={{ background: 'var(--accent)' }} /> you</span>
          <span><i style={{ background: '#ffd54a' }} /> selected</span>
          <span><i style={{ background: '#7ee787' }} /> can expand here</span>
          <span><i style={{ background: '#ff6b6b' }} /> vulnerable</span>
          <span>drag to pan · scroll to zoom</span>
        </div>

        {isMyTurn && s.phase !== 'finished' && (
          <div className="card">
            <div className="row row--between" style={{ marginBottom: 10 }}>
              <strong>
                {actor!.name} — ${actor!.money} · {owned.length} countries · {game.fullContinents(actor!.id).join(', ') || 'no continent'}
              </strong>
              {actor!.pendingPeace && <span className="pill pill--ok">Peace income next turn</span>}
            </div>

            {s.phase === 'placement' && <div className="notice">Pick any unoccupied country on the map to start there.</div>}

            {movingForTeam && (
              <div className="notice">
                It is your team's turn. You are moving for <b>{actor!.name}</b> — in Tournament mode any teammate may
                play the team's turn, and the move is made with {actor!.name}'s countries and ${actor!.money}.
              </div>
            )}

            {s.phase === 'awaiting-action' && mode === 'idle' && (
              <div className="actions">
                <button className="btn" title="Peace — collects income and leaves one country vulnerable (P)" onClick={doPeace}>🕊 Peace</button>
                <button className="btn" title="Gather Troops — buy 1–20 troops, $50 each (G)" onClick={doGatherStart}>🛡 Gather Troops</button>
                <button className="btn btn--primary" title="Expand — attack or claim a neighbouring country (E)" onClick={() => { setMode('expand'); setError(null); }}>⚔ Expand</button>
                <button className="btn btn--ghost" title="Nothing — keep every country safe this turn (N)" onClick={doNothing}>⏭ Nothing</button>
              </div>
            )}

            {s.phase === 'awaiting-action' && mode === 'idle' && (
              <div className="small muted" style={{ marginTop: 8 }}>
                Shortcuts: <span className="mono">P</span> peace · <span className="mono">G</span> gather ·{' '}
                <span className="mono">E</span> expand · <span className="mono">N</span> nothing ·{' '}
                <span className="mono">Esc</span> close a dialog
              </div>
            )}

            {mode === 'peace' && (
              <div className="stack">
                <div className="notice">
                  Click one of your countries to declare Peace there. It becomes <b>vulnerable</b> until your next turn,
                  when you collect <b>$100 per territory</b> plus <b>$10 × countries in continent</b> for each continent you fully own.
                </div>
                <div className="btn-row">
                  <button className="btn btn--sm" onClick={() => setMode('idle')}>Cancel</button>
                </div>
              </div>
            )}

            {mode === 'gather' && (
              <div className="stack">
                <div className="notice">
                  You may buy between 1 and <b>{s.gatherCap}</b> troops this turn (the cap is rolled as random(1,20)).
                  Each troop costs ${TROOP_COST}. Budget: ${actor!.money}.
                </div>
                <div className="hud__scroll" style={{ maxHeight: 170 }}>
                  <table className="data">
                    <thead><tr><th>Country</th><th>Troops</th><th>Buy</th></tr></thead>
                    <tbody>
                      {owned.slice().sort((a, b) => a.id.localeCompare(b.id)).map((t) => (
                        <tr key={t.id}>
                          <td>{label(t.id)}</td>
                          <td>{t.troops}</td>
                          <td>
                            <div className="row" style={{ gap: 4 }}>
                              <button className="btn btn--sm" onClick={() => setDist((d) => ({ ...d, [t.id]: Math.max(0, (d[t.id] ?? 0) - 1) }))}>−</button>
                              <span className="mono" style={{ width: 22, textAlign: 'center' }}>{dist[t.id] ?? 0}</span>
                              <button className="btn btn--sm" onClick={() => setDist((d) => ({ ...d, [t.id]: (d[t.id] ?? 0) + 1 }))}>+</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row row--between">
                  <span>Buying <b>{gatherTotal}</b> troops for <b>${gatherTotal * TROOP_COST}</b> · cap {s.gatherCap}</span>
                  <div className="btn-row">
                    <button className="btn btn--sm" onClick={() => { const d: Record<string, number> = {}; owned.slice().sort((a, b) => a.id.localeCompare(b.id)).forEach((t) => { d[t.id] = 1; }); setDist(d); }}>Spread 1 each</button>
                    <button className="btn btn--sm" onClick={() => setMode('idle')}>Cancel</button>
                    <button className="btn btn--primary btn--sm" disabled={gatherTotal < 1 || gatherTotal > s.gatherCap || gatherTotal * TROOP_COST > actor!.money} onClick={confirmGather}>Confirm</button>
                  </div>
                </div>
              </div>
            )}

            {mode === 'expand' && (
              <div className="stack">
                <div className="notice">
                  Select one of your countries, then a country you do not own that borders it. Base cost $100 ·
                  crossing a body of water +$100 · crossing a major ocean +$50 per troop · each troop has a 1-in-10 chance of dying at sea.
                  You cannot expand through other countries.
                </div>
                <div className="row">
                  <span className="pill">From: {label(from)}</span>
                  <span className="pill">To: {label(to)}</span>
                  {from && <span className="pill">Troops there: {s.territories[from].troops}</span>}
                </div>
                {from && (
                  <div className="row">
                    <label className="field" style={{ flex: 1 }}>
                      <span>Troops to send (max {maxSend})</span>
                      <input type="range" min={1} max={Math.max(1, maxSend)} value={send} onChange={(e) => setSend(Number(e.target.value))} />
                    </label>
                    <div className="mono" style={{ minWidth: 150 }}>
                      send <b>{send}</b> · cost <b>${quote && !('error' in quote) ? quote.total : '—'}</b>
                    </div>
                  </div>
                )}
                {from && (
                  <label className="field">
                    <span>
                      {targetHidden
                        ? 'Typed order — you were never shown this country\u2019s name, so any order is accepted'
                        : 'Typed order — spell the destination country exactly (required; a misspelling loses your turn)'}
                    </span>
                    <input
                      type="text"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && doExpand()}
                      placeholder={targetHidden ? 'type anything' : label(to) === '—' ? 'e.g. Japan' : label(to)}
                    />
                  </label>
                )}
                {to && quote && !('error' in quote) && (
                  <div className="notice">
                    {label(to)}: {quote.water === null ? 'land border' : quote.water === 'sea' ? `body of water (${quote.km} km)` : `major ocean (${quote.km} km)`} ·
                    base ${quote.base}{quote.waterFee ? ` + water $${quote.waterFee}` : ''}{quote.oceanFee ? ` + ocean $${quote.oceanFee}` : ''} =
                    <b> ${quote.total}</b>
                    {s.territories[to].owner !== null && !s.territories[to].vulnerable && (
                      <> · <b>occupied:</b> dice battle (every troop rolls 1–20, highest total takes the country)</>
                    )}
                    {s.territories[to].vulnerable && <> · <b>vulnerable:</b> all occupants are killed</>}
                  </div>
                )}
                <div className="btn-row">
                  <button className="btn btn--sm" onClick={() => setMode('idle')}>Cancel</button>
                  <button className="btn btn--primary btn--sm" disabled={!to || !quote || ('error' in quote) || (needsTyped && !typed.trim())} onClick={doExpand}>Send troops</button>
                </div>
              </div>
            )}

            {error && <div className="notice notice--bad" style={{ marginTop: 10 }}>{error}</div>}
          </div>
        )}
      </div>

      <div className="hud">
        <div className="card hud__scroll">
          <div className="tabs tabs--card">
            <button data-active={hudTab === 'log'} onClick={() => setHudTab('log')}>Turn log</button>
            <button data-active={hudTab === 'players'} onClick={() => setHudTab('players')}>Players</button>
            {settings.liveChat && <button data-active={hudTab === 'chat'} onClick={() => setHudTab('chat')}>Chat</button>}
          </div>

          {hudTab === 'log' && (
            <div className="log log--tall">
              {log.map((e, i) => (
                <div key={i} className="log__row" data-kind={e.type}>{e.text}</div>
              ))}
              {!log.length && <div className="muted small">Nothing has happened yet.</div>}
            </div>
          )}

          {hudTab === 'players' && (
            <div className="players">
              {s.players.map((p) => (
                <div key={p.id} className="player" data-active={p.id === actor?.id} data-dead={!p.alive}>
                  <span className="player__swatch" style={{ background: p.color }} />
                  <span className="player__name">
                    {p.name}{p.isBot ? ' 🤖' : ''}{s.config.tournament ? ` (T${p.team + 1})` : ''}
                    {online && p.id === viewerId ? ' — you' : ''}
                  </span>
                  <span className="player__meta">${p.money} · {game.ownedBy(p.id).length} ▪ · {p.score} pts</span>
                </div>
              ))}
            </div>
          )}

          {hudTab === 'chat' && settings.liveChat && (
            <div className="chat">
              <div className="row row--between">
                <span className="muted small">Everyone's messages — team messages are tagged.</span>
                <div className="btn-row">
                  <button className="btn btn--sm" data-on={chatTab === 'global'} onClick={() => setChatTab('global')}>Global</button>
                  <button className="btn btn--sm" data-on={chatTab === 'team'} onClick={() => setChatTab('team')}>Team</button>
                </div>
              </div>
              <div className="chat__list chat__list--tall">
                {visibleChat.map((m, i) => (
                  <div key={i} className="chat__msg"><b>{m.name}{m.team !== null ? ' (team)' : ''}:</b> {m.body}</div>
                ))}
                {!visibleChat.length && <div className="muted small">No messages yet.</div>}
              </div>
              <div className="chat__form">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                  placeholder={`Message ${chatTab}`}
                />
                <button className="btn btn--sm" onClick={sendChat}>Send</button>
              </div>
              {s.config.tournament && <span className="small muted">Tournament mode: team chat only.</span>}
            </div>
          )}
        </div>
      </div>

      {showResults && (
        <div className="modal-backdrop">
          <div className="card modal" role="dialog" aria-modal="true" aria-label="Game results">
            <h2 style={{ marginTop: 0 }}>
              {s.winner === null ? 'Draw' : `${s.players[s.winner].name} wins!`}
            </h2>
            <p className="muted">Game over after {s.round} rounds.</p>
            <table className="data">
              <thead><tr><th>#</th><th>Player</th><th>Territories</th><th>Score</th></tr></thead>
              <tbody>
                {s.players.slice().sort((a, b) => b.score - a.score).map((p, i) => (
                  <tr key={p.id}>
                    <td>{i + 1}</td>
                    <td><span className="player__swatch" style={{ background: p.color, display: 'inline-block', marginRight: 6 }} />{p.name}{p.isBot ? ' 🤖' : ''}</td>
                    <td>{game.ownedBy(p.id).length}</td>
                    <td className="mono">{p.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="small muted" style={{ marginTop: 10 }}>
              Scoring rules in force: claim {s.scoring.claimUnoccupied} · occupied {s.scoring.claimOccupied} · continent {s.scoring.claimContinent} ·
              win {s.scoring.winGame} · lose {s.scoring.loseGame} (multiplier ×{s.config.blindfold ? 2 : s.config.fogOfWar ? 1.5 : 1}
              {s.scoring !== DEFAULT_SCORING ? ', custom set' : ''})
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              {onReplay && <button className="btn btn--primary" autoFocus onClick={onReplay}>Play again</button>}
              <button className="btn" onClick={onExit}>Back to menu</button>
              <button className="btn btn--ghost" onClick={() => setShowResults(false)}>Review board</button>
            </div>
          </div>
        </div>
      )}

      {exitOpen && (
        <div className="modal-backdrop">
          <div className="card modal" role="dialog" aria-modal="true" aria-label="Exit game">
            <h2 style={{ marginTop: 0 }}>Exit game</h2>
            {online ? (
              !confirmLeave ? (
                <>
                  <p className="muted">
                    This game lives on the server, so you can step away and come back later — your seat is kept and
                    you will be notified when it is your turn. Forfeiting gives up the seat for good.
                  </p>
                  <div className="btn-row" style={{ marginTop: 14 }}>
                    <button className="btn btn--primary" onClick={() => onStepAway?.()}>Step away (rejoin later)</button>
                    <button className="btn btn--danger" onClick={() => setConfirmLeave(true)}>Forfeit the game</button>
                    <button className="btn" onClick={cancelExit}>Keep playing</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="muted">Forfeit? Your countries leave the map and you cannot rejoin this game.</p>
                  <div className="btn-row" style={{ marginTop: 14 }}>
                    <button className="btn btn--danger" onClick={() => onForfeit?.()}>Yes, forfeit</button>
                    <button className="btn" onClick={() => setConfirmLeave(false)}>Keep playing</button>
                  </div>
                </>
              )
            ) : !confirmLeave ? (
              <>
                <p className="muted">Save your progress and resume from the menu later, or leave the game for good.</p>
                <div className="btn-row" style={{ marginTop: 14 }}>
                  {canResume && <button className="btn btn--primary" onClick={() => onSaveExit?.()}>Save &amp; exit</button>}
                  <button className="btn btn--danger" onClick={() => setConfirmLeave(true)}>Leave game</button>
                  <button className="btn" onClick={cancelExit}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">Leave without saving? This game will be lost and cannot be resumed.</p>
                <div className="btn-row" style={{ marginTop: 14 }}>
                  <button className="btn btn--danger" onClick={onExit}>Yes, leave</button>
                  <button className="btn" onClick={() => setConfirmLeave(false)}>Keep playing</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
