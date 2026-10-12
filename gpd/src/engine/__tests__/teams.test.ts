import { describe, expect, it } from 'vitest';
import { GPDGame } from '../game';
import { applyPayload } from '../../net/protocol';
import { runSimulation } from '../sim';
import { configProblem, teamCountFor, teamFor, type GameConfig } from '../types';

const ONLINE_TOURNAMENT: GameConfig = {
  mapPreset: 'Europe', mode: 'online-teams', preset: 'tournament', timer: 'none',
  fogOfWar: false, blindfold: false, tournament: true, humanPlayers: 6, playerCount: 6, seed: 11,
};

const ONLINE_CLASSIC: GameConfig = {
  mapPreset: 'Europe', mode: 'online-solo', preset: 'classic', timer: 'none',
  fogOfWar: false, blindfold: false, tournament: false, humanPlayers: 4, playerCount: 4, seed: 7,
};

/** Play out placement so the game reaches the first real turn. */
function ready(cfg: GameConfig, names: string[]) {
  const g = new GPDGame(cfg, names);
  let guard = 0;
  while (g.state.phase === 'placement' && guard++ < 100) g.autoPlace(g.actor!.id);
  return g;
}

describe('Tournament team sizes', () => {
  it('needs a full team per side, so six players is the floor', () => {
    expect(configProblem({ ...ONLINE_TOURNAMENT, playerCount: 3, humanPlayers: 3 })).toMatch(/at least 6/);
    expect(configProblem({ ...ONLINE_TOURNAMENT, playerCount: 5, humanPlayers: 5 })).toMatch(/at least 6/);
    expect(configProblem(ONLINE_TOURNAMENT)).toBeNull();
    expect(configProblem({ ...ONLINE_CLASSIC, playerCount: 1, humanPlayers: 1 })).toMatch(/at least 2/);
    expect(configProblem(ONLINE_CLASSIC)).toBeNull();
  });

  it('balances teams so sizes differ by at most one', () => {
    const sizes = (n: number) => {
      const counts: Record<number, number> = {};
      for (let i = 0; i < n; i++) counts[teamFor('tournament', i, n)] = (counts[teamFor('tournament', i, n)] ?? 0) + 1;
      return Object.values(counts).sort((a, b) => a - b);
    };
    expect(teamCountFor('tournament', 6)).toBe(2);
    expect(sizes(6)).toEqual([3, 3]);
    expect(teamCountFor('tournament', 9)).toBe(3);
    expect(sizes(9)).toEqual([3, 3, 3]);
    expect(teamCountFor('tournament', 12)).toBe(4);
    expect(sizes(12)).toEqual([3, 3, 3, 3]);
    // Odd counts still spread evenly and never exceed three per team.
    expect(sizes(7)).toEqual([2, 2, 3]);
    expect(Math.max(...sizes(11))).toBeLessThanOrEqual(3);
  });

  it('gives every player their own team in Classic', () => {
    expect(teamFor('classic', 0, 4)).toBe(0);
    expect(teamFor('classic', 3, 4)).toBe(3);
    expect(teamCountFor('classic', 4)).toBe(4);
  });

  it('assigns balanced teams to a real tournament game', () => {
    const g = ready(ONLINE_TOURNAMENT, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(g.state.players.map((p) => p.team)).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

describe('team turns', () => {
  it('lets any living teammate move for the team', () => {
    const g = ready(ONLINE_TOURNAMENT, ['a', 'b', 'c', 'd', 'e', 'f']);
    const actor = g.actor!;
    const mates = g.state.players.filter((p) => p.team === actor.team).map((p) => p.id);
    expect(g.eligibleActors().map((p) => p.id)).toEqual(mates);
    for (const id of mates) expect(g.canAct(id)).toBe(true);

    const rival = g.state.players.find((p) => p.team !== actor.team)!;
    expect(g.canAct(rival.id)).toBe(false);

    // A teammate's payload is accepted, and because the move belonged to the team
    // the turn leaves that team afterwards.
    const teamBefore = actor.team;
    expect(applyPayload(g, mates[1], { t: 'nothing' }).ok).toBe(true);
    if (g.state.phase !== 'finished') expect(g.actor!.team).not.toBe(teamBefore);
  });

  it('rejects a move from another team', () => {
    const g = ready(ONLINE_TOURNAMENT, ['a', 'b', 'c', 'd', 'e', 'f']);
    const actor = g.actor!;
    const rival = g.state.players.find((p) => p.team !== actor.team)!;
    const res = applyPayload(g, rival.id, { t: 'nothing' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Not your turn');
    expect(g.actor!.id).toBe(actor.id);
  });

  it('keeps Classic turns personal', () => {
    const g = ready(ONLINE_CLASSIC, ['a', 'b', 'c', 'd']);
    const actor = g.actor!;
    expect(g.eligibleActors().map((p) => p.id)).toEqual([actor.id]);
    const other = g.state.players.find((p) => p.id !== actor.id)!;
    expect(g.canAct(other.id)).toBe(false);
    expect(applyPayload(g, other.id, { t: 'nothing' }).ok).toBe(false);
  });

  it('keeps starting-country placement personal even on a team', () => {
    const g = new GPDGame(ONLINE_TOURNAMENT, ['a', 'b', 'c', 'd', 'e', 'f']);
    const picker = g.actor!;
    const mate = g.state.players.find((p) => p.team === picker.team && p.id !== picker.id)!;
    const free = g.state.active.filter((id) => g.state.territories[id].owner === null);
    // A teammate may not plant a country in someone else's colour.
    expect(applyPayload(g, mate.id, { t: 'place', country: free[0] }).ok).toBe(false);
    expect(applyPayload(g, picker.id, { t: 'place', country: free[0] }).ok).toBe(true);
  });
});

describe('full tournament game', () => {
  it('resolves to a single winning team at the six-player minimum', () => {
    // Six seats is the smallest tournament, so it is the one worth proving out.
    const g = new GPDGame({
      ...ONLINE_TOURNAMENT, mapPreset: 'Europe', mode: 'offline-sim',
      seed: 5, playerCount: 6, humanPlayers: 0,
    }, ['a', 'b', 'c', 'd', 'e', 'f']);
    const result = runSimulation(g);
    expect(result.finished).toBe(true);
    expect(result.winningTeam).not.toBeNull();
    expect(g.teamAlive(result.winningTeam!)).toBe(true);
    expect(new Set(g.state.players.filter((p) => p.alive).map((p) => p.team)).size).toBe(1);
  });
});
