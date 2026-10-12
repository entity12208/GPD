import { supabase } from './supabase';
import { presetCapacity, type GameConfig, type GameState, type ModePreset } from '../engine/types';

export type LobbyVisibility = 'public' | 'private';

export interface LobbyRow {
  id: string;
  host_id: string | null;
  mode: string;
  map_preset: string;
  preset: string;
  timer: string;
  fog_of_war: boolean;
  blindfold: boolean;
  tournament: boolean;
  /** Public lobbies are listed for everyone; private ones only for invitees. */
  visibility: LobbyVisibility;
  has_password: boolean;
  status: 'lobby' | 'placement' | 'active' | 'finished';
  /** The host's authoritative snapshot, once the game has started. */
  state?: GameState | null;
  /** PRNG state at the time of that snapshot, so a resume keeps the same dice. */
  rng?: number | null;
  /** Seats available before the lobby is full. */
  capacity: number;
  /** How many players are already seated (filled in by `listLobbies`). */
  seated?: number;
  version: number;
  created_at: string;
}

/** One seated player, with the username the game actually shows. */
export interface SeatRow {
  seat: number;
  team: number;
  userId: string;
  username: string;
}

/** The lobby the host broadcasts so everyone sees the same roster. */
export interface LobbySnapshot {
  status: LobbyRow['status'];
  capacity: number;
  hostId: string | null;
  seats: SeatRow[];
}

/** Sent when the host starts: the roster and configuration the guests build on. */
export interface StartSnapshot {
  config: GameConfig;
  names: string[];
  seats: SeatRow[];
}

export interface CreateLobbyOptions {
  visibility?: LobbyVisibility;
  /** Optional room password for public games. Hashed server-side, never stored in the clear. */
  password?: string;
  /** Usernames a private game is sent to. */
  invites?: string[];
}

export type JoinStatus = 'ok' | 'wrong-password' | 'invite-only' | 'full' | 'closed' | 'unknown';

export function presetOf(config: Pick<GameConfig, 'preset' | 'tournament'>): ModePreset {
  return config.preset ?? (config.tournament ? 'tournament' : 'classic');
}

export async function listLobbies(): Promise<LobbyRow[]> {
  if (!supabase) return [];
  // `game_players(count)` gives the lobby list a "3/6 players" column without a
  // second round trip per row.
  const { data, error } = await supabase
    .from('games')
    .select('*, game_players(count)')
    .in('status', ['lobby', 'placement', 'active'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return [];
  return ((data ?? []) as unknown as (LobbyRow & { game_players?: { count: number }[] })[])
    .map((row) => ({ ...row, seated: row.game_players?.[0]?.count ?? 0 }));
}

export async function createLobby(config: GameConfig, hostId: string, opts: CreateLobbyOptions = {}) {
  if (!supabase) throw new Error('Supabase is not configured');
  const visibility = opts.visibility ?? 'public';
  const password = visibility === 'public' ? (opts.password?.trim() || '') : '';
  const { data, error } = await supabase
    .from('games')
    .insert({
      host_id: hostId,
      mode: config.mode,
      map_preset: config.mapPreset,
      preset: presetOf(config),
      timer: config.timer,
      fog_of_war: config.fogOfWar,
      blindfold: config.blindfold,
      tournament: config.tournament,
      visibility,
      has_password: Boolean(password),
      capacity: presetCapacity(presetOf(config)),
      status: 'lobby',
    })
    .select('*')
    .single();
  if (error) throw error;
  await supabase.from('game_players').insert({ game_id: data.id, user_id: hostId, seat: 0, team: 0 });
  // The password is hashed by a security-definer function; it never reaches the client tables.
  if (password) await supabase.rpc('set_game_password', { p_game: data.id, p_password: password });
  // A private game is "sent" to each named username (invite row + notification).
  for (const username of opts.invites ?? []) {
    const clean = username.trim();
    if (clean) await supabase.rpc('invite_to_game', { p_game: data.id, p_username: clean });
  }
  return data as LobbyRow;
}

/**
 * Join through the server so a room password is verified against the stored
 * hash (and invite-only games reject usernames that were never invited).
 */
export async function joinGame(gameId: string, password?: string, team = -1): Promise<JoinStatus> {
  if (!supabase) return 'unknown';
  // seat -1 lets the server pick the next free seat, so two players joining at
  // the same moment can never be given the same one.
  const { data, error } = await supabase.rpc('join_game', {
    p_game: gameId,
    p_seat: -1,
    p_team: team,
    p_password: password ?? '',
  });
  if (error) return 'unknown';
  return (data as JoinStatus) ?? 'unknown';
}

/** Leave a seat (used when abandoning a lobby). */
export async function leaveSeat(gameId: string, userId: string) {
  if (!supabase) return;
  await supabase.from('game_players').delete().eq('game_id', gameId).eq('user_id', userId);
}

/** The stored row for one game, including the host's authoritative snapshot. */
export async function fetchGame(gameId: string): Promise<(LobbyRow & { state: GameState | null }) | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('games').select('*').eq('id', gameId).maybeSingle();
  return (data as (LobbyRow & { state: GameState | null }) | null) ?? null;
}

/** Send a private game to a specific username. */
export async function inviteToGame(gameId: string, username: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('invite_to_game', { p_game: gameId, p_username: username.trim() });
  return !error && data !== false;
}

/**
 * The roster, in seat order, with the real username of every seated player. The
 * engine is built from this, so the board shows accounts, never placeholders.
 */
export async function listSeats(gameId: string): Promise<SeatRow[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('game_players')
    .select('seat, team, user_id, profiles(username)')
    .eq('game_id', gameId)
    .order('seat', { ascending: true });
  return ((data ?? []) as unknown as { seat: number; team: number; user_id: string; profiles?: { username?: string } | null }[])
    .map((r) => ({
      seat: r.seat,
      team: r.team,
      userId: r.user_id,
      username: r.profiles?.username ?? 'Player',
    }));
}

export async function listInvitations(userId: string) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('game_invites')
    .select('game_id, games(mode, map_preset, preset, visibility, timer, created_at)')
    .eq('invitee_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  return data ?? [];
}

/** The host is authoritative: it writes the full engine snapshot after each move. */
export async function pushState(
  gameId: string, state: GameState, status: string, winnerId: string | null, rng?: number,
) {
  if (!supabase) return;
  await supabase
    .from('games')
    .update({
      state,
      rng: rng ?? null,
      version: (state.round ?? 0) * 1000 + state.turn,
      status,
      winner_id: winnerId,
      finished_at: status === 'finished' ? new Date().toISOString() : null,
    })
    .eq('id', gameId);
}

/** Turn a stored game row back into the config the engine expects. */
export function configFromLobby(row: LobbyRow): GameConfig {
  const preset: ModePreset = row.preset === 'tournament' ? 'tournament' : 'classic';
  return {
    mapPreset: row.map_preset as GameConfig['mapPreset'],
    mode: row.mode as GameConfig['mode'],
    preset,
    timer: row.timer as GameConfig['timer'],
    fogOfWar: row.fog_of_war,
    blindfold: row.blindfold,
    tournament: preset === 'tournament',
    humanPlayers: 0,
    playerCount: 0,
  };
}

export function subscribeGame(gameId: string, onState: (state: GameState, status: string) => void) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`game:${gameId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => {
        const row = payload.new as { state: GameState | null; status: string };
        if (row.state) onState(row.state, row.status);
      },
    )
    .subscribe();
  return () => { void supabase?.removeChannel(channel); };
}

export interface ChatMessage { id: number; user_id: string | null; team: number | null; body: string; created_at: string }

export async function sendMessage(gameId: string, userId: string, body: string, team: number | null) {
  if (!supabase) return;
  await supabase.from('messages').insert({ game_id: gameId, user_id: userId, body, team });
}

export function subscribeChat(gameId: string, onMessage: (m: ChatMessage) => void) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`chat:${gameId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `game_id=eq.${gameId}` },
      (payload) => onMessage(payload.new as ChatMessage),
    )
    .subscribe();
  return () => { void supabase?.removeChannel(channel); };
}

/** The online leaderboard only ever ranks human profiles, never bots. */
export async function fetchLeaderboard(limit = 50) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('leaderboard')
    .select('id, username, global_score, rank')
    .order('rank', { ascending: true })
    .limit(limit);
  return data ?? [];
}

export async function recordScoreEvents(gameId: string, userId: string, keys: string[]) {
  if (!supabase || !keys.length) return;
  await supabase.from('score_events').insert(keys.map((score_key) => ({ game_id: gameId, user_id: userId, score_key })));
}

export async function listFriends(userId: string) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('friendships')
    .select('friend_id, status, profiles!friendships_friend_id_fkey(username, global_score)')
    .eq('user_id', userId);
  return data ?? [];
}

export async function addFriend(userId: string, friendId: string) {
  if (!supabase) return;
  await supabase.from('friendships').insert({ user_id: userId, friend_id: friendId, status: 'pending' });
}

export async function listNotifications(userId: string) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('notifications')
    .select('id, kind, body, read, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  return data ?? [];
}

export async function markNotificationRead(id: number) {
  if (!supabase) return;
  await supabase.from('notifications').update({ read: true }).eq('id', id);
}

export async function myGames(userId: string) {
  if (!supabase) return [];
  const { data } = await supabase
    .from('game_players')
    .select('game_id, seat, team, score, games(mode, map_preset, status, created_at, winner_id)')
    .eq('user_id', userId)
    .limit(50);
  return data ?? [];
}

/** The host closes a lobby that never started. */
export async function closeGame(gameId: string) {
  if (!supabase) return;
  await supabase.from('games')
    .update({ status: 'finished', finished_at: new Date().toISOString() })
    .eq('id', gameId);
}

/**
 * Ask the server to tell a seated player it is their turn. Only the host may call
 * it, so the row lands in their Notifications panel even if they have left the board.
 */
export async function notifyTurn(gameId: string, seat: number, body?: string) {
  if (!supabase) return;
  await supabase.rpc('notify_turn', { p_game: gameId, p_seat: seat, p_body: body ?? '' });
}

/** Recent chat for a game, so a lobby or a resumed game opens with its history. */
export async function listMessages(gameId: string, limit = 60): Promise<ChatMessage[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from('messages')
    .select('id, user_id, team, body, created_at')
    .eq('game_id', gameId)
    .order('id', { ascending: true })
    .limit(limit);
  return (data ?? []) as ChatMessage[];
}

// ------------------------------------------------------------------ realtime --
export interface NetChannel {
  sendState(state: GameState, status?: string): void;
  sendAction(payload: unknown): void;
  sendChat(body: string, team: number | null): void;
  /** Host broadcasts the roster while everyone waits in the lobby. */
  sendLobby(snapshot: LobbySnapshot): void;
  /** Host tells everyone the lobby is closed and the game is starting. */
  sendStart(snapshot: StartSnapshot): void;
  /** Host tells the table whose turn it now is. */
  sendTurn(payload: { seat: number; name: string; team: number }): void;
  /** Guest asks the host to re-broadcast the current snapshot (sent on join). */
  requestState(): void;
  close(): void;
  ready: Promise<boolean>;
}

/** How long to wait for the Realtime socket to subscribe before giving up. */
export const CHANNEL_READY_TIMEOUT_MS = 8000;

/**
 * A Supabase Realtime broadcast channel. The host listens for `action`
 * messages, applies them to the authoritative engine and rebroadcasts the full
 * snapshot with `state`; guests render whatever snapshot they receive.
 */
export function openGameChannel(
  gameId: string,
  selfId: string,
  handlers: {
    onState?: (state: GameState, status: string) => void;
    onAction?: (payload: unknown, from: string) => void;
    onChat?: (msg: { body: string; team: number | null; from: string }) => void;
    /** Fired on the host when a guest subscribes and asks for the current snapshot. */
    onHello?: (from: string) => void;
    onLobby?: (snapshot: LobbySnapshot) => void;
    onStart?: (snapshot: StartSnapshot) => void;
    onTurn?: (payload: { seat: number; name: string; team: number }) => void;
  },
): NetChannel {
  if (!supabase) {
    return {
      sendState() {}, sendAction() {}, sendChat() {}, sendLobby() {}, sendStart() {},
      sendTurn() {}, requestState() {}, close() {},
      ready: Promise.resolve(false),
    };
  }
  const channel = supabase.channel(`gpd:${gameId}`, { config: { broadcast: { self: false } } });

  // `subscribe` only reports `SUBSCRIBED` on success; without a timeout a channel
  // that errors (Realtime disabled, bad key, offline) would hang forever with no
  // feedback at all. `ready` always settles within CHANNEL_READY_TIMEOUT_MS.
  const ready = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), CHANNEL_READY_TIMEOUT_MS);
    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        const p = payload as { state: GameState; status: string };
        handlers.onState?.(p.state, p.status);
      })
      .on('broadcast', { event: 'action' }, ({ payload }) => {
        const p = payload as { payload: unknown; from: string };
        handlers.onAction?.(p.payload, p.from);
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => {
        handlers.onChat?.(payload as { body: string; team: number | null; from: string });
      })
      .on('broadcast', { event: 'hello' }, ({ payload }) => {
        handlers.onHello?.((payload as { from: string }).from);
      })
      .on('broadcast', { event: 'lobby' }, ({ payload }) => {
        handlers.onLobby?.(payload as LobbySnapshot);
      })
      .on('broadcast', { event: 'start' }, ({ payload }) => {
        handlers.onStart?.(payload as StartSnapshot);
      })
      .on('broadcast', { event: 'turn' }, ({ payload }) => {
        handlers.onTurn?.(payload as { seat: number; name: string; team: number });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') finish(true);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish(false);
      });
  });

  return {
    ready,
    sendState(state, status = 'active') {
      void channel.send({ type: 'broadcast', event: 'state', payload: { state, status } });
    },
    sendAction(payload) {
      void channel.send({ type: 'broadcast', event: 'action', payload: { payload, from: selfId } });
    },
    sendChat(body, team) {
      void channel.send({ type: 'broadcast', event: 'chat', payload: { body, team, from: selfId } });
    },
    sendLobby(snapshot) {
      void channel.send({ type: 'broadcast', event: 'lobby', payload: snapshot });
    },
    sendStart(snapshot) {
      void channel.send({ type: 'broadcast', event: 'start', payload: snapshot });
    },
    sendTurn(payload) {
      void channel.send({ type: 'broadcast', event: 'turn', payload });
    },
    requestState() {
      void channel.send({ type: 'broadcast', event: 'hello', payload: { from: selfId } });
    },
    close() { void supabase?.removeChannel(channel); },
  };
}
