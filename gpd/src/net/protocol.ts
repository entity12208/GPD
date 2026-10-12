import { GPDGame } from '../engine/game';
import type { ActionType } from '../engine/types';

/** Every player action is serialisable so the host can replay it authoritatively. */
export type NetPayload =
  | { t: 'place'; country: string }
  | { t: 'choose'; action: ActionType }
  | { t: 'peace'; territory: string }
  | { t: 'gather'; distribution: Record<string, number> }
  | { t: 'expand'; from: string; to: string; troops: number; typed?: string }
  | { t: 'nothing' }
  | { t: 'forfeit' };

/**
 * Apply a payload on the authoritative host. `seat` is the sender's player id;
 * anything not sent by the player whose turn it is is rejected.
 */
export function applyPayload(game: GPDGame, seat: number, p: NetPayload): { ok: boolean; error?: string } {
  const actor = game.actor;
  if (!actor) return { ok: false, error: 'No active player' };
  // Placement puts a country in the picker's own colour, so only that player may
  // place; every other action is the team's move, which any teammate may make.
  if (p.t === 'forfeit') { game.forfeit(seat); return { ok: true }; }
  if (p.t === 'place') {
    if (actor.id !== seat) return { ok: false, error: 'Not your pick' };
  } else if (!game.canAct(seat)) {
    return { ok: false, error: 'Not your turn' };
  }

  switch (p.t) {
    case 'place': return game.placeStartingCountry(seat, p.country);
    case 'choose': return game.chooseAction(p.action);
    case 'peace': return game.submitPeace(p.territory);
    case 'gather': return game.submitGather(p.distribution);
    case 'expand': return game.submitExpand(p.from, p.to, p.troops, p.typed);
    case 'nothing': return game.submitNothing();
    default: return { ok: false, error: 'Unknown payload' };
  }
}
