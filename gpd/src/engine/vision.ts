import { BY_ID } from './data';
import type { GPDGame } from './game';

/**
 * Fog of War and Blindfold are information rules: a player must never learn the
 * name of a country they have not claimed. Everything that renders a country
 * name goes through this module so the rule lives in exactly one place.
 */
export const HIDDEN_NAME = 'Unidentified territory';

/** May `viewerId` be told this country's name? */
export function canSeeName(game: GPDGame, viewerId: number, countryId: string): boolean {
  const { fogOfWar, blindfold } = game.state.config;
  if (!fogOfWar && !blindfold) return true;
  return game.state.territories[countryId]?.owner === viewerId;
}

/** The name to render for this viewer, or the placeholder. */
export function nameFor(game: GPDGame, viewerId: number, countryId: string): string {
  if (!countryId) return HIDDEN_NAME;
  return canSeeName(game, viewerId, countryId) ? (BY_ID[countryId]?.name ?? countryId) : HIDDEN_NAME;
}

/**
 * Every country name this viewer must not see, mapped to the placeholder. Built
 * once per render (or per batch of log lines) and reused.
 */
export function hiddenNameMap(game: GPDGame, viewerId: number): Map<string, string> {
  const out = new Map<string, string>();
  const { fogOfWar, blindfold } = game.state.config;
  if (!fogOfWar && !blindfold) return out;
  for (const id of game.state.active) {
    if (game.state.territories[id]?.owner === viewerId) continue;
    const name = BY_ID[id]?.name;
    if (name) out.set(name, HIDDEN_NAME);
  }
  return out;
}

/**
 * Strip hidden country names out of arbitrary text (turn-log lines, engine error
 * messages). Names are matched longest-first so "United Kingdom" is not eaten by
 * a shorter country name inside it.
 */
export function redact(text: string, hidden: Map<string, string>): string {
  if (!hidden.size || !text) return text;
  let out = text;
  for (const name of [...hidden.keys()].sort((a, b) => b.length - a.length)) {
    if (out.includes(name)) out = out.split(name).join(hidden.get(name)!);
  }
  return out;
}

/** Convenience: redact one string for one viewer. */
export function redactFor(game: GPDGame, viewerId: number, text: string): string {
  return redact(text, hiddenNameMap(game, viewerId));
}
