import { BY_ID, graphForPreset } from './data';
import { GPDGame, TROOP_COST } from './game';
import type { TerritoryState } from './types';

export type BotStyle = 'aggressive' | 'balanced' | 'turtle';

export function styleFor(playerId: number): BotStyle {
  return (['aggressive', 'balanced', 'turtle', 'balanced'] as BotStyle[])[playerId % 4];
}

/** Neighbours of a territory (land + sea lanes) inside the active map. */
export function neighbours(game: GPDGame, id: string) {
  return graphForPreset(game.state.config.mapPreset).adj[id] ?? [];
}

/** Is `to` a legal place for `owner` to expand into? */
function isEnemy(game: GPDGame, owner: number, to: TerritoryState): boolean {
  const s = game.state;
  if (!to || to.owner === owner) return false;
  if (to.owner !== null && s.config.tournament && s.players[to.owner].team === s.players[owner].team) return false;
  return true;
}

function attackTargets(game: GPDGame, t: TerritoryState): number {
  let n = 0;
  for (const lane of neighbours(game, t.id)) {
    const o = game.state.territories[lane.id];
    if (o && isEnemy(game, t.owner!, o)) n++;
  }
  return n;
}

interface Candidate {
  from: TerritoryState;
  to: TerritoryState;
  def: number;
  edge: number;
  value: number;
  maxTroops: number;
}

/** Choose and immediately perform one action for the acting bot. */
export function botAct(game: GPDGame): boolean {
  const s = game.state;
  if (s.phase === 'finished') return false;
  if (s.phase === 'placement') {
    const actor = game.actor;
    if (!actor || !actor.isBot) return false;
    game.autoPlace(actor.id);
    return true;
  }
  if (s.phase !== 'awaiting-action') return false;
  const p = game.currentPlayer;
  if (!p || !p.isBot) return false;
  const style = styleFor(p.id);
  const owned = game.ownedBy(p.id);
  if (!owned.length) { game.submitNothing(); return true; }

  // ---- 1. find the most attractive expansion -------------------------------
  let best: Candidate | null = null;
  for (const from of owned) {
    if (from.troops < 2) continue;
    for (const lane of neighbours(game, from.id)) {
      const to = s.territories[lane.id];
      if (!to || !isEnemy(game, p.id, to)) continue;
      const q = game.quoteExpand(p.id, from.id, to.id, 1);
      if ('error' in q || q.total > p.money) continue;
      const def = to.vulnerable ? 0 : to.troops;
      const edge = from.troops - 1 - def;
      let value = to.owner === null ? 60 : 10;
      if (to.vulnerable) value += 45;
      value -= q.total / 25;
      if (q.water === 'ocean') value -= 8;
      else if (q.water === 'sea') value -= 3;
      const cont = BY_ID[to.id].cont;
      const members = s.active.filter((id) => BY_ID[id].cont === cont);
      const mine = members.filter((id) => s.territories[id].owner === p.id).length;
      if (mine === members.length - 1) value += 70;
      const score = edge + value / 10;
      if (!best || score > best.edge + best.value / 10) {
        best = { from, to, def, edge, value, maxTroops: q.maxTroops };
      }
    }
  }

  // Only commit to a battle with a real local advantage — a losing attack kills
  // every troop sent, so suicidal pushes just churn the map forever. Bots get
  // slightly bolder as the game drags on, which guarantees games terminate.
  const advantage = best ? best.from.troops - 1 : 0;
  const need = best
    ? best.def === 0
      ? 0
      : Math.ceil(best.def * Math.max(1, 1.5 - s.round / 3000)) + (style === 'aggressive' ? 0 : style === 'balanced' ? 1 : 3)
    : Infinity;
  const go = !!best && advantage >= need;

  if (best && go && best.maxTroops >= 1) {
    let send = Math.max(1, Math.min(best.maxTroops, style === 'aggressive' ? best.maxTroops : Math.ceil(best.maxTroops * 0.7)));
    while (send > 1) {
      const q = game.quoteExpand(p.id, best.from.id, best.to.id, send);
      if (!('error' in q) && q.total <= p.money) break;
      send--;
    }
    const q = game.quoteExpand(p.id, best.from.id, best.to.id, send);
    if (!('error' in q) && q.total <= p.money) {
      game.submitExpand(best.from.id, best.to.id, send);
      return true;
    }
  }

  // ---- 2. economy: gather when rich, otherwise bank Peace income ----------
  if (p.money >= 250) { game.chooseAction('gather'); return true; }
  if (!p.pendingPeace && owned.length) {
    game.submitPeace(owned.slice().sort((a, b) => b.troops - a.troops)[0].id);
    return true;
  }
  if (p.money >= TROOP_COST) { game.chooseAction('gather'); return true; }

  // nothing left to do this turn
  game.submitNothing();
  return true;
}

/** Resolve a bot's pending gather: reinforce the frontier, keep some in reserve. */
export function botFinishGather(game: GPDGame): boolean {
  const s = game.state;
  if (s.phase !== 'gather-distribution') return false;
  const p = game.currentPlayer;
  if (!p || !p.isBot) return false;
  const owned = game.ownedBy(p.id);
  if (!owned.length) { game.submitNothing(); return true; }
  const cap = s.gatherCap;
  const troops = Math.max(1, Math.min(cap, Math.floor(p.money / TROOP_COST)));

  const front = owned.filter((t) => attackTargets(game, t) > 0).sort((a, b) => attackTargets(game, b) - attackTargets(game, a));
  const pool = front.length ? front : owned;
  const dist: Record<string, number> = {};
  if (pool.length === 1) dist[pool[0].id] = troops;
  else {
    const anchor = Math.ceil(troops * 0.7);
    dist[pool[0].id] = anchor;
    let left = troops - anchor;
    for (let i = 1; i < pool.length && left > 0; i++) {
      const share = Math.min(left, Math.max(1, Math.floor(left / (pool.length - i))));
      dist[pool[i].id] = share;
      left -= share;
    }
    if (left > 0) dist[pool[0].id] = (dist[pool[0].id] ?? 0) + left;
  }
  return game.submitGather(dist).ok;
}
