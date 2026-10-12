import { describe, expect, it } from 'vitest';
import { ALL_COUNTRIES, BY_ID, MAP_PRESETS, countriesForPreset, graphForPreset } from '../data';
import { EXPAND_BASE, GPDGame, OCEAN_PER_TROOP, SEA_EXTRA, STARTING_MONEY, TROOP_COST } from '../game';
import { runSimulation } from '../sim';
import { calculateScore, recalculate } from '../scoring';
import { DEFAULT_SCORING, PRESETS, presetCapacity, timerAllowed, type GameConfig, type ScoreEvent } from '../types';

function game(over: Partial<GameConfig> = {}, names?: string[]) {
  return new GPDGame({
    mapPreset: 'World',
    mode: 'offline-multi',
    timer: 'none',
    fogOfWar: false,
    blindfold: false,
    tournament: false,
    humanPlayers: 2,
    seed: 12345,
    ...over,
  }, names);
}

/** Place starting countries for every player in order, then return the game. */
function placed(g: GPDGame, picks: string[]) {
  for (const id of picks) {
    const actor = g.actor!;
    const res = g.placeStartingCountry(actor.id, id);
    expect(res.ok, res.error).toBe(true);
  }
  return g;
}

describe('map data', () => {
  it('has a usable country set', () => {
    expect(ALL_COUNTRIES.length).toBeGreaterThan(150);
    for (const c of ALL_COUNTRIES) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.land.length + c.sea.length).toBeGreaterThan(0);
      expect(c.lat).toBeGreaterThanOrEqual(-90);
      expect(c.lat).toBeLessThanOrEqual(90);
    }
  });

  it('every preset is non-empty and fully connected', () => {
    for (const p of MAP_PRESETS) {
      const list = countriesForPreset(p.id);
      expect(list.length, p.id).toBeGreaterThan(0);
      const adj = graphForPreset(p.id).adj;
      const seen = new Set<string>([list[0].id]);
      const queue = [list[0].id];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nb of adj[cur]) if (!seen.has(nb.id)) { seen.add(nb.id); queue.push(nb.id); }
      }
      expect(seen.size, `${p.id} connected`).toBe(list.length);
    }
  });

  it('knows the difference between land, water and ocean crossings', () => {
    expect(graphForPreset('World').adj.USA.some((x) => x.id === 'CAN' && x.water === null)).toBe(true);
    expect(graphForPreset('World').adj.FRA.some((x) => x.id === 'GBR' && x.water === 'sea')).toBe(true);
    expect(graphForPreset('World').adj.RUS.some((x) => x.water === 'ocean')).toBe(true);
  });
});

describe('setup', () => {
  it('starts everyone with $500 and a single troop on their own country', () => {
    const g = placed(game(), ['USA', 'CAN']);
    expect(g.state.phase).toBe('awaiting-action');
    for (const p of g.state.players) {
      expect(p.money).toBe(STARTING_MONEY);
      expect(p.alive).toBe(true);
    }
    expect(g.state.territories.USA).toMatchObject({ owner: 0, troops: 1 });
    expect(g.state.territories.CAN).toMatchObject({ owner: 1, troops: 1 });
    expect(g.state.territories.BRA.owner).toBeNull();
  });

  it('refuses a starting country that is already taken', () => {
    const g = game();
    g.placeStartingCountry(g.actor!.id, 'USA');
    expect(g.placeStartingCountry(g.actor!.id, 'USA').ok).toBe(false);
    expect(g.placeStartingCountry(g.actor!.id, 'CAN').ok).toBe(true);
  });
});

describe('peace', () => {
  it('marks the country vulnerable and pays out on the owner\'s next turn', () => {
    const g = placed(game(), ['USA', 'CAN']);
    const res = g.submitPeace('USA');
    expect(res.ok).toBe(true);
    expect(g.state.territories.USA.vulnerable).toBe(true);
    expect(g.state.players[0].pendingPeace).toBe(true);

    // player 1 does nothing, then it is player 0's turn again
    g.submitNothing();
    expect(g.currentPlayer?.id).toBe(0);
    expect(g.state.players[0].money).toBe(STARTING_MONEY + 100); // one territory
    expect(g.state.territories.USA.vulnerable).toBe(false);
    const income = g.state.log.filter((e) => e.type === 'income');
    expect(income).toHaveLength(1);
  });

  it('adds $10 × countries in continent for a fully owned continent', () => {
    const g = placed(game(), ['AUS', 'USA']);
    // player 0 takes the rest of Oceania
    const oceania = countriesForPreset('Oceania');
    for (const c of oceania) {
      if (c.id === 'AUS') continue;
      g.state.territories[c.id].owner = 0;
      g.state.territories[c.id].troops = 1;
    }
    g.syncContinentsFor(0);
    g.state.players[0].pendingPeace = true;
    g.endTurn(); // player 1
    g.endTurn(); // back to player 0 -> income
    const size = oceania.length;
    expect(g.currentPlayer?.id).toBe(0);
    expect(g.state.players[0].money).toBe(STARTING_MONEY + 100 * size + 10 * size);
    expect(g.state.players[0].continents).toContain('Oceania');
  });
});

describe('gather', () => {
  it('rolls a cap of 1..20 and charges $50 per troop', () => {
    const g = placed(game(), ['USA', 'CAN']);
    expect(g.chooseAction('gather').ok).toBe(true);
    expect(g.state.gatherCap).toBeGreaterThanOrEqual(1);
    expect(g.state.gatherCap).toBeLessThanOrEqual(20);
    // place one troop on each newly claimed country below the cap
    const owned = g.ownedBy(0);
    const dist: Record<string, number> = { [owned[0].id]: 1 };
    expect(g.submitGather(dist).ok).toBe(true);
    expect(g.state.players[0].money).toBe(STARTING_MONEY - TROOP_COST);
    expect(g.state.territories[owned[0].id].troops).toBe(2);
  });

  it('rejects more troops than the cap or than you can afford', () => {
    const g = placed(game({ mapPreset: 'Oceania', humanPlayers: 1 }, ['solo']), ['AUS']);
    g.state.players[0].money = 5000;
    g.chooseAction('gather');
    const cap = g.state.gatherCap;
    expect(g.submitGather({ AUS: cap + 1 }).ok).toBe(false);
    g.state.players[0].money = 10;
    expect(g.submitGather({ AUS: 2 }).ok).toBe(false);
  });
});

describe('expand', () => {
  it('charges $100 for a land border move and claims the country', () => {
    const g = placed(game(), ['USA', 'CAN']);
    g.state.territories.USA.troops = 3;
    const res = g.submitExpand('USA', 'CAN', 2);
    expect(res.ok, res.error).toBe(true);
    expect(g.state.territories.CAN.owner).toBe(0);
    expect(g.state.territories.USA.troops).toBe(1);
    expect(g.state.players[0].money).toBe(STARTING_MONEY - EXPAND_BASE);
  });

  it('charges an extra $100 when crossing a body of water', () => {
    const g = placed(game({ humanPlayers: 1, mapPreset: 'Europe' }, ['solo']), ['FRA']);
    g.state.territories.FRA.troops = 5;
    const q = g.quoteExpand(0, 'FRA', 'GBR', 2);
    expect('error' in q).toBe(false);
    if (!('error' in q)) {
      expect(q.water).toBe('sea');
      expect(q.waterFee).toBe(SEA_EXTRA);
      expect(q.total).toBe(EXPAND_BASE + SEA_EXTRA);
    }
    const before = g.state.players[0].money;
    expect(g.submitExpand('FRA', 'GBR', 2).ok).toBe(true);
    expect(g.state.players[0].money).toBe(before - EXPAND_BASE - SEA_EXTRA);
  });

  it('charges $50 per troop when crossing a major ocean', () => {
    const g = placed(game({ humanPlayers: 1 }, ['solo']), ['RUS']);
    g.state.territories.RUS.troops = 6;
    const q = g.quoteExpand(0, 'RUS', 'KGZ', 4);
    expect('error' in q).toBe(false);
    if (!('error' in q)) expect(q.total).toBe(EXPAND_BASE + OCEAN_PER_TROOP * 4);
  });

  it('cannot expand through other countries', () => {
    const g = placed(game(), ['USA', 'CAN']);
    const res = g.submitExpand('USA', 'BRA', 1);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/border|through/i);
  });

  it('cannot send more than one less than the garrison, nor into your own land', () => {
    const g = placed(game(), ['USA', 'CAN']);
    g.state.territories.USA.troops = 3;
    expect(g.submitExpand('USA', 'CAN', 3).ok).toBe(false);
    g.state.territories.MEX.owner = 0;
    g.state.territories.MEX.troops = 1;
    expect(g.submitExpand('USA', 'MEX', 1).ok).toBe(false);
  });

  it('kills troops at sea at roughly one in ten', () => {
    let sent = 0;
    let arrived = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const g = placed(game({ humanPlayers: 1, seed }, ['JPN']), ['JPN']);
      g.state.territories.JPN.troops = 25;
      g.state.players[0].money = 100000;
      const res = g.submitExpand('JPN', 'KOR', 20);
      expect(res.ok, res.error).toBe(true);
      sent += 20;
      arrived += g.state.territories.KOR.troops;
    }
    const rate = 1 - arrived / sent;
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.16);
  });
});

describe('combat', () => {
  it('wipes out a vulnerable garrison without a dice battle', () => {
    const g = placed(game(), ['USA', 'CAN']);
    g.state.territories.USA.troops = 4;
    g.state.territories.CAN.troops = 5;
    g.state.territories.CAN.vulnerable = true;
    expect(g.submitExpand('USA', 'CAN', 3).ok).toBe(true);
    expect(g.state.territories.CAN.owner).toBe(0);
    expect(g.state.territories.CAN.troops).toBe(3);
    expect(g.state.log.some((e) => e.type === 'combat' && /vulnerable/i.test(e.text))).toBe(true);
  });

  it('resolves a dice battle on a non-vulnerable country and scores it', () => {
    // three players so wiping a garrison does not immediately end the game
    const g = placed(game({ playerCount: 3 }), ['USA', 'MEX', 'CAN']);
    g.state.territories.USA.troops = 10;
    g.state.territories.CAN.troops = 1;
    g.state.players[0].money = 1000;
    const before = g.state.players[0].score;
    expect(g.submitExpand('USA', 'CAN', 9).ok).toBe(true);
    const claimed = g.state.territories.CAN.owner === 0;
    const expected = claimed ? DEFAULT_SCORING.claimOccupied : DEFAULT_SCORING.failToWin;
    expect(g.state.players[0].score).toBe(before + expected);
    if (claimed) expect(g.state.players[2].score).toBe(DEFAULT_SCORING.loseCountry);
    expect(g.state.log.some((e) => e.type === 'combat' && /Battle for/.test(e.text))).toBe(true);
  });

  it('loses the turn when a typed order is misspelled', () => {
    const g = placed(game(), ['USA', 'CAN']);
    g.state.territories.USA.troops = 3;
    const res = g.submitExpand('USA', 'CAN', 1, 'Cananda');
    expect(res.ok).toBe(false);
    expect(g.state.log.some((e) => e.type === 'forfeit')).toBe(true);
    expect(g.currentPlayer?.id).toBe(1); // turn passed
    expect(g.state.territories.CAN.owner).toBe(1);
    expect(g.state.players[0].money).toBe(STARTING_MONEY);
  });

  it('accepts a correctly spelled typed order', () => {
    const g = placed(game(), ['USA', 'CAN']);
    g.state.territories.USA.troops = 3;
    expect(g.submitExpand('USA', 'CAN', 1, 'canada').ok).toBe(true);
    expect(g.state.territories.CAN.owner).toBe(0);
  });
});

describe('scoring and recalculation', () => {
  it('uses the documented point values', () => {
    const events: ScoreEvent[] = [
      { player: 0, key: 'claimUnoccupied' },
      { player: 0, key: 'claimOccupied' },
      { player: 0, key: 'loseCountry' },
      { player: 0, key: 'failToWin' },
      { player: 0, key: 'claimContinent' },
      { player: 1, key: 'winGame' },
      { player: 1, key: 'loseGame' },
    ];
    expect(calculateScore(events, 0, DEFAULT_SCORING, 1)).toBe(50 + 75 - 50 - 20 + 200);
    expect(calculateScore(events, 1, DEFAULT_SCORING, 1)).toBe(500 - 200);
    // modifiers multiply the final total
    expect(calculateScore(events, 1, DEFAULT_SCORING, 1.5)).toBe(Math.round(300 * 1.5));
    expect(calculateScore(events, 1, DEFAULT_SCORING, 2)).toBe(600);
  });

  it('recalculates every total from a different set of calculations', () => {
    const g = placed(game({ playerCount: 3 }), ['USA', 'MEX', 'CAN']);
    g.state.territories.USA.troops = 6;
    g.submitExpand('USA', 'CAN', 5);
    const standard = g.state.players.map((p) => p.score);
    g.recalculateLeaderboard({ ...DEFAULT_SCORING, claimOccupied: 1000, loseCountry: -1000 });
    const custom = g.state.players.map((p) => p.score);
    expect(custom).not.toEqual(standard);
    expect(custom[0]).toBe(1000);
    // and back again
    g.recalculateLeaderboard(DEFAULT_SCORING);
    expect(g.state.players.map((p) => p.score)).toEqual(standard);
    const board = recalculate(g.state.scoreEvents, 3, DEFAULT_SCORING, 1);
    expect(board[0]).toBe(standard[0]);
  });

  it('awards +200 once for claiming a whole continent', () => {
    const g = placed(game(), ['AUS', 'USA']);
    const lane = graphForPreset('World').adj.AUS.find((l) => l.id === 'NCL')!;
    for (const c of countriesForPreset('Oceania')) {
      if (c.id === 'AUS' || c.id === lane.id) continue;
      g.state.territories[c.id].owner = 0;
      g.state.territories[c.id].troops = 1;
    }
    g.state.territories.AUS.troops = 6;
    const before = g.state.players[0].score;
    const res = g.submitExpand('AUS', lane.id, 5);
    expect(res.ok, res.error).toBe(true);
    expect(g.state.players[0].continents).toContain('Oceania');
    expect(g.state.players[0].score).toBe(before + DEFAULT_SCORING.claimUnoccupied + DEFAULT_SCORING.claimContinent);
    expect(g.state.log.some((e) => e.type === 'continent')).toBe(true);
  });

  it('does not award the continent bonus twice while it is held', () => {
    const g = placed(game(), ['AUS', 'USA']);
    for (const c of countriesForPreset('Oceania')) {
      if (c.id === 'AUS') continue;
      g.state.territories[c.id].owner = 0;
      g.state.territories[c.id].troops = 1;
    }
    g.state.players[0].money = 5000;
    g.syncContinentsFor(0);
    const afterClaim = g.state.players[0].score;
    expect(afterClaim).toBe(DEFAULT_SCORING.claimContinent);
    // claim a neighbouring country outside Oceania: score only gains the claim
    g.state.territories.AUS.troops = 6;
    expect(g.submitExpand('AUS', 'TLS', 5).ok).toBe(true);
    expect(g.state.players[0].continents).toContain('Oceania');
    expect(g.state.players[0].score).toBe(afterClaim + DEFAULT_SCORING.claimUnoccupied);
  });
});

describe('turn timers', () => {
  it('kicks a player who misses the deadline and clears their territories', () => {
    const g = placed(game({ timer: '1min' }), ['USA', 'CAN']);
    g.state.territories.MEX.owner = 0;
    g.state.territories.MEX.troops = 2;
    g.state.turnDeadline = Date.now() - 1;
    expect(g.tick()).toBe(true);
    expect(g.state.players[0].alive).toBe(false);
    expect(g.ownedBy(0)).toHaveLength(0);
    expect(g.state.players[1].alive).toBe(true);
    expect(g.state.log.some((e) => e.type === 'timeout')).toBe(true);
  });

  it('waits until the deadline', () => {
    const g = placed(game({ timer: '5min' }), ['USA', 'CAN']);
    expect(g.tick()).toBe(false);
    expect(g.state.players[0].alive).toBe(true);
  });
});

describe('fog of war and blindfold', () => {
  it('hides foreign countries under fog of war and everything under blindfold', () => {
    const g = placed(game({ fogOfWar: true }), ['USA', 'CAN']);
    const fog = g.viewFor(0);
    expect(fog.visible.USA).toMatchObject({ owner: 0, troops: 1 });
    expect(fog.visible.CAN.troops).toBeNull();
    expect(fog.visible.CAN.owner).toBeNull();

    const b = placed(game({ blindfold: true }), ['USA', 'CAN']);
    const blind = b.viewFor(0);
    expect(blind.visible.USA.owner).toBeNull();
    expect(blind.visible.USA.troops).toBeNull();
    expect(blind.visible.CAN.troops).toBeNull();
  });

  it('drops a "!" marker when something happens to a team', () => {
    const g = placed(game({ fogOfWar: true }), ['USA', 'CAN']);
    g.state.territories.USA.troops = 3;
    g.submitExpand('USA', 'CAN', 2);
    expect(g.state.markers.some((m) => m.territory === 'CAN')).toBe(true);
  });
});

describe('full games', () => {
  it('always produces a single winner with bots only', { timeout: 180000 }, () => {
    for (const preset of ['World', 'Europe', 'Asia', 'Oceania'] as const) {
      for (const seed of [1]) {
        const seats = preset === 'Oceania' ? 4 : 8;
        const g = new GPDGame({
          mapPreset: preset, mode: 'offline-sim', timer: 'none',
          fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 0, playerCount: seats, seed,
        });
        const res = runSimulation(g);
        expect(res.finished, `${preset}/${seed}`).toBe(true);
        expect(res.winner === null && res.winningTeam === null).toBe(false);
        const alive = g.state.players.filter((p) => p.alive);
        expect(alive.length).toBe(1);
        expect(alive[0].score).toBeGreaterThan(0);
      }
    }
  });

  it('finishes tournament games with a winning team', () => {
    const g = new GPDGame({
      mapPreset: 'Europe', mode: 'offline-sim', timer: 'none',
      fogOfWar: false, blindfold: false, tournament: true, humanPlayers: 0, playerCount: 12, seed: 4242,
    });
    const res = runSimulation(g);
    expect(res.finished).toBe(true);
    expect(res.winningTeam).not.toBeNull();
    const survivors = g.state.players.filter((p) => p.alive);
    expect(new Set(survivors.map((p) => p.team)).size).toBe(1);
  });

  it('is deterministic for a given seed', () => {
    const mk = () => new GPDGame({
      mapPreset: 'Africa', mode: 'offline-sim', timer: 'none',
      fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 0, playerCount: 8, seed: 555,
    });
    const a = runSimulation(mk());
    const b = runSimulation(mk());
    expect(a).toEqual(b);
  });

  it('serialises and restores state', () => {
    const g = new GPDGame({
      mapPreset: 'Europe', mode: 'offline-sim', timer: 'none',
      fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 0, playerCount: 8, seed: 321,
    });
    runSimulation(g);
    const clone = GPDGame.fromJSON(g.toJSON());
    expect(clone.state.winner).toBe(g.state.winner);
    expect(clone.state.round).toBe(g.state.round);
    expect(Object.keys(clone.state.territories).length).toBe(Object.keys(g.state.territories).length);
  });
});

describe('geography helpers', () => {
  it('quotes every expandable neighbour of every owned country', () => {
    const g = placed(game(), ['USA', 'CAN']);
    for (const t of g.ownedBy(0)) {
      for (const lane of graphForPreset('World').adj[t.id]) {
        const q = g.quoteExpand(0, t.id, lane.id, 1);
        if (!('error' in q)) expect(q.total).toBeGreaterThanOrEqual(EXPAND_BASE);
      }
    }
    expect(BY_ID.USA.name).toBe('United States');
  });
});

describe('Classic and Tournament presets', () => {
  it('matches the rulebook exactly', () => {
    expect(PRESETS.classic.chat).toBe('global+team');
    expect(PRESETS.classic.timers).toEqual(['none', '1d', '10min', '5min', '1min']);
    expect(PRESETS.classic.maxPerTeam).toBe(1);
    expect(PRESETS.classic.maxTeams).toBe(12);
    expect(PRESETS.tournament.chat).toBe('team');
    expect(PRESETS.tournament.timers).toEqual(['1d', '10min', '5min']);
    expect(PRESETS.tournament.maxPerTeam).toBe(3);
    expect(PRESETS.tournament.maxTeams).toBe(4);
    expect(presetCapacity('tournament')).toBe(12);
    expect(timerAllowed('tournament', 'none')).toBe(false);
    expect(timerAllowed('classic', 'none')).toBe(true);
  });

  it('derives teams from the preset, which wins over the legacy flag', () => {
    const t = new GPDGame({
      mapPreset: 'Europe', mode: 'offline-sim', preset: 'tournament', timer: '1d',
      fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 0, playerCount: 12, seed: 1,
    });
    expect(t.state.config.tournament).toBe(true);
    expect(new Set(t.state.players.map((p) => p.team)).size).toBe(4);

    const c = new GPDGame({
      mapPreset: 'Europe', mode: 'offline-sim', preset: 'classic', timer: 'none',
      fogOfWar: false, blindfold: false, tournament: true, humanPlayers: 0, playerCount: 6, seed: 1,
    });
    expect(c.state.config.tournament).toBe(false);
    expect(new Set(c.state.players.map((p) => p.team)).size).toBe(6);
  });

  it('still derives the preset from the legacy tournament flag', () => {
    const g = new GPDGame({
      mapPreset: 'Europe', mode: 'offline-sim', timer: 'none',
      fogOfWar: false, blindfold: false, tournament: true, humanPlayers: 0, playerCount: 6, seed: 1,
    });
    expect(g.state.config.preset).toBe('tournament');
    expect(g.state.config.tournament).toBe(true);
  });
});
