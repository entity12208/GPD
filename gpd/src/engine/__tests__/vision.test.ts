import { describe, expect, it } from 'vitest';
import { GPDGame } from '../game';
import { BY_ID } from '../data';
import { HIDDEN_NAME, canSeeName, hiddenNameMap, nameFor, redact } from '../vision';
import type { GameConfig } from '../types';

function game(over: Partial<GameConfig> = {}) {
  return new GPDGame({
    mapPreset: 'Europe', mode: 'offline-multi', timer: 'none',
    fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 2, playerCount: 2, seed: 3,
    ...over,
  }, ['Ada', 'Grace']);
}

/** Give player 0 France and player 1 Germany, then let the game start. */
function placed(over: Partial<GameConfig> = {}) {
  const g = game(over);
  const order = ['FRA', 'DEU', 'ESP', 'ITA', 'POL', 'PRT', 'SWE', 'NOR', 'FIN'];
  for (const id of order) {
    const p = g.actor;
    if (g.state.phase !== 'placement') break;
    g.placeStartingCountry(p!.id, id);
  }
  return g;
}

describe('country names under the modifiers', () => {
  it('reveals every name when no modifier is on', () => {
    const g = placed();
    expect(canSeeName(g, 0, 'DEU')).toBe(true);
    expect(nameFor(g, 0, 'DEU')).toBe('Germany');
    expect(hiddenNameMap(g, 0).size).toBe(0);
  });

  it('reveals only claimed countries under Fog of War', () => {
    const g = placed({ fogOfWar: true });
    expect(canSeeName(g, 0, 'FRA')).toBe(true);
    expect(nameFor(g, 0, 'FRA')).toBe('France');
    expect(canSeeName(g, 0, 'DEU')).toBe(false);
    expect(nameFor(g, 0, 'DEU')).toBe(HIDDEN_NAME);
  });

  it('reveals only claimed countries under Blindfold', () => {
    const g = placed({ blindfold: true });
    expect(canSeeName(g, 1, 'DEU')).toBe(true);
    expect(nameFor(g, 1, 'DEU')).toBe('Germany');
    expect(canSeeName(g, 1, 'FRA')).toBe(false);
    expect(nameFor(g, 1, 'FRA')).toBe(HIDDEN_NAME);
  });

  it('still hides other players’ ownership and troops on the board', () => {
    const g = placed({ fogOfWar: true });
    const view = g.viewFor(0);
    expect(view.visible.FRA.owner).toBe(0);
    expect(view.visible.DEU.owner).toBeNull();
    expect(view.visible.DEU.troops).toBeNull();
  });

  it('keeps the roster honest: another player’s claim never shows a real name', () => {
    const g = placed({ fogOfWar: true });
    // Player 0 expands into Portugal, then cannot name Germany.
    g.state.players[0].money = 5000;
    g.submitExpand('FRA', 'DEU', 1, 'anything');
    const hidden = hiddenNameMap(g, 0);
    expect(hidden.get('Germany')).toBe(HIDDEN_NAME);
    expect(hidden.has('France')).toBe(false);
  });
});

describe('redaction', () => {
  it('strips hidden names out of turn-log lines but keeps your own', () => {
    const g = placed({ fogOfWar: true });
    const hidden = hiddenNameMap(g, 0);
    expect(redact('Ada expands from France into Germany with 3 troops', hidden))
      .toBe(`Ada expands from France into ${HIDDEN_NAME} with 3 troops`);
    expect(redact('Grace claims Spain', hidden)).toBe(`Grace claims ${HIDDEN_NAME}`);
  });

  it('matches longer names first so nothing is left half-revealed', () => {
    const g = game({ fogOfWar: true, mapPreset: 'World' });
    const hidden = hiddenNameMap(g, 99);
    // "United Kingdom" must not be split by a shorter country name inside it.
    const out = redact('United Kingdom and Guinea-Bissau', hidden);
    expect(out).not.toContain('United Kingdom');
    expect(out).not.toContain('Guinea-Bissau');
    expect(out).toContain(HIDDEN_NAME);
  });

  it('redacts a real engine error message', () => {
    const g = placed({ fogOfWar: true });
    g.state.territories.FRA.troops = 5;
    // Sweden does not border France, so the engine names both countries in the error.
    const quote = g.quoteExpand(0, 'FRA', 'SWE', 2);
    expect('error' in quote).toBe(true);
    const raw = String((quote as { error: string }).error);
    expect(raw).toContain('Sweden');
    const text = redact(raw, hiddenNameMap(g, 0));
    expect(text).not.toContain('Sweden');
    expect(text).toContain(HIDDEN_NAME);
    expect(text).toContain('France');
  });
});

describe('typed orders under the modifiers', () => {
  it('does not punish a name the player was never shown', () => {
    const g = placed({ fogOfWar: true });
    g.state.players[0].money = 5000;
    g.state.territories.FRA.troops = 4;
    // Germany is hidden, so any order is accepted and the turn does not end in forfeit.
    const res = g.submitExpand('FRA', 'DEU', 1, 'who knows');
    expect(res.ok).toBe(true);
    expect(g.state.log.some((e) => e.type === 'forfeit')).toBe(false);
  });

  it('still forfeits a misspelled name you can see', () => {
    const g = placed({ fogOfWar: true });
    g.state.players[0].money = 5000;
    const res = g.submitExpand('FRA', 'FRA', 1, 'nope');
    expect(res.ok).toBe(false);
    // Expanding into your own country is rejected before the spelling matters.
    expect(BY_ID.FRA.name).toBe('France');
    const res2 = g.quoteExpand(0, 'FRA', 'FRA', 1);
    expect('error' in res2).toBe(true);
  });

  it('keeps the spelling rule when there is no fog', () => {
    const g = placed();
    g.state.players[0].money = 5000;
    const res = g.submitExpand('FRA', 'DEU', 1, 'Germny');
    expect(res.ok).toBe(false);
    expect(g.state.log.some((e) => e.type === 'forfeit')).toBe(true);
  });
});
