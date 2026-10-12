import { botAct, botFinishGather } from './bots';
import { GPDGame } from './game';
import type { GameConfig } from './types';

export interface SimResult {
  turns: number;
  winner: number | null;
  winningTeam: number | null;
  scores: { name: string; score: number; territories: number }[];
  finished: boolean;
}

/**
 * Play a game out with bots only. Used by Offline Simulation, by the bot
 * difficulty harness and by the engine tests.
 */
export function runSimulation(game: GPDGame, maxSteps = 60000): SimResult {
  let steps = 0;
  while (game.state.phase !== 'finished' && steps < maxSteps) {
    const actor = game.actor;
    if (!actor) break;
    if (game.state.phase === 'placement') game.autoPlace(actor.id);
    else if (game.state.phase === 'gather-distribution') botFinishGather(game);
    else botAct(game);
    steps++;
  }
  return {
    turns: steps,
    winner: game.state.winner,
    winningTeam: game.state.winningTeam,
    scores: game.state.players.map((p) => ({
      name: p.name,
      score: p.score,
      territories: game.ownedBy(p.id).length,
    })),
    finished: game.state.phase === 'finished',
  };
}

export function playBotGame(playerCount: number, preset: GameConfig['mapPreset'], seed = 1, tournament = false) {
  const game = new GPDGame({
    mapPreset: preset,
    mode: 'offline-sim',
    timer: 'none',
    fogOfWar: false,
    blindfold: false,
    tournament,
    seed,
    humanPlayers: 0,
    playerCount,
  });
  return { game, result: runSimulation(game) };
}
