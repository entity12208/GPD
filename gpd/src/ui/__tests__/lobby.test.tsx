// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  seats: [] as { seat: number; team: number; userId: string; username: string }[],
}));

vi.mock('../../net/online', () => ({
  listSeats: vi.fn(async () => h.seats),
  listMessages: vi.fn(async () => []),
  subscribeChat: vi.fn(() => () => {}),
  sendMessage: vi.fn(async () => {}),
}));

const { LobbyPanel } = await import('../LobbyPanel');

const CONFIG = {
  mapPreset: 'Europe', mode: 'online-teams', preset: 'tournament', timer: '10min',
  fogOfWar: false, blindfold: false, tournament: true, humanPlayers: 0, playerCount: 0,
} as const;

function roster(usernames: string[]) {
  return usernames.map((username, i) => ({ seat: i, team: i % 2, userId: `uid-${i}`, username }));
}

function renderLobby(over: Partial<Parameters<typeof LobbyPanel>[0]> = {}) {
  return render(
    <LobbyPanel
      gameId="game-1"
      userId="uid-0"
      username="Ada"
      isHost
      seat={0}
      capacity={12}
      status="lobby"
      config={CONFIG as never}
      liveChat
      onStart={() => {}}
      onLeave={() => {}}
      {...over}
    />,
  );
}

beforeEach(() => { h.seats = []; cleanup(); });

describe('the online lobby', () => {
  it('shows the real usernames and the seats still open', async () => {
    h.seats = roster(['Ada', 'Grace', 'Linus']);
    renderLobby();
    await waitFor(() => expect(screen.getByText(/Ada/)).toBeTruthy());
    expect(screen.getByText(/Grace/)).toBeTruthy();
    expect(screen.getByText(/Linus/)).toBeTruthy();
    // Tournament needs six, so three open seats are advertised.
    expect(screen.getAllByText(/Open seat/).length).toBe(3);
    expect(screen.getByText(/Players 3\/12/)).toBeTruthy();
  });

  it('holds the host back until a full team can play, then lets them start', async () => {
    h.seats = roster(['Ada', 'Grace', 'Linus', 'Alan']);
    const start = vi.fn();
    const { rerender } = renderLobby({ onStart: start });

    await waitFor(() => expect(screen.getByText(/Waiting for 2 more/)).toBeTruthy());
    const button = screen.getByRole('button', { name: /Waiting for 2 more/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(start).not.toHaveBeenCalled();

    h.seats = roster(['Ada', 'Grace', 'Linus', 'Alan', 'Edsger', 'Barbara']);
    rerender(
      <LobbyPanel
        gameId="game-1" userId="uid-0" username="Ada" isHost seat={0} capacity={12}
        status="lobby" config={CONFIG as never} liveChat onStart={start} onLeave={() => {}}
      />,
    );
    // The roster is polled, so give the next poll a chance to land.
    await waitFor(() => expect(screen.getByRole('button', { name: /Start game/ })).toBeTruthy(), { timeout: 5000 });
    const ready = screen.getByRole('button', { name: /Start game/ }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    ready.click();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('gives guests no start button and tells them who is waiting on', async () => {
    h.seats = roster(['Ada', 'Grace', 'Linus', 'Alan', 'Edsger', 'Barbara']);
    renderLobby({ isHost: false, userId: 'uid-1', username: 'Grace' });
    await waitFor(() => expect(screen.getByText(/Waiting for the host to start/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Start game/ })).toBeNull();
  });

  it('names the teams in Tournament mode', async () => {
    h.seats = roster(['Ada', 'Grace', 'Linus', 'Alan', 'Edsger', 'Barbara']);
    renderLobby();
    await waitFor(() => expect(screen.getAllByText(/Team 1/).length).toBe(3));
    expect(screen.getAllByText(/Team 2/).length).toBe(3);
  });
});
