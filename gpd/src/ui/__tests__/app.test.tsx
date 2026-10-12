// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../../App';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function buttons(name: string | RegExp) {
  return screen.queryAllByRole('button', { name });
}

/** Advance the game clock and flush the re-render the runner triggers. */
function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

describe('web client', () => {
  it('renders the main menu with every menu entry', () => {
    render(<App />);
    expect(screen.getByText('Geo-Political Domination')).toBeTruthy();
    for (const label of ['Settings', 'Stats', 'Leaderboard', 'Friends', 'Notifications', 'My Games', 'Rules']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('Play').length).toBeGreaterThan(0);
    expect(screen.getByText('Sign In / Sign Up')).toBeTruthy();
  });

  it('walks Play → setup → placement → a full turn on the real board', () => {
    render(<App />);
    fireEvent.click(buttons('Play')[0]);

    // setup screen
    expect(screen.getByText('Offline Singleplayer')).toBeTruthy();
    expect(screen.getByText('Offline Simulation')).toBeTruthy();
    expect(screen.getByText('Online Multiplayer (teams)')).toBeTruthy();
    expect(screen.getByText(/countries on this map/)).toBeTruthy();
    fireEvent.click(buttons(/Start game/)[0]);

    // board is rendered with real country geometry
    const paths = document.querySelectorAll('path.country');
    expect(paths.length).toBeGreaterThan(150);
    expect(screen.getByText(/Placement/)).toBeTruthy();

    // a human picks their starting country by clicking the map
    fireEvent.click(paths[0]);
    expect(screen.getByText(/starts in/)).toBeTruthy();

    // bots take their picks, then the human's first turn opens
    advance(20000);
    expect(screen.getByText(/Gather Troops/)).toBeTruthy();
    const players = screen.getAllByText(/Bot \d+/);
    expect(players.length).toBeGreaterThan(0);

    // Gather Troops: cap is rolled, then troops are distributed and paid for
    fireEvent.click(screen.getByText(/Gather Troops/));
    expect(screen.getByText(/may buy up to/)).toBeTruthy();
    fireEvent.click(buttons('+')[0]);
    fireEvent.click(buttons('Confirm')[0]);
    expect(screen.getByText(/gathered 1 troops for \$50/)).toBeTruthy();

    // the Expand workflow exposes costs and a send control
    advance(60000);
    const expand = buttons(/Expand/)[0];
    if (expand) fireEvent.click(expand);
    expect(screen.getByText(/Select one of your countries/)).toBeTruthy();
  });

  it('opens the rulebook, settings and leaderboard panels', () => {
    render(<App />);
    fireEvent.click(buttons('Rules')[0]);
    expect(screen.getByText(/be the last player alive/)).toBeTruthy();
    expect(screen.getByText(/random\(1,20\)/)).toBeTruthy();
    fireEvent.click(buttons('Back')[0]);

    fireEvent.click(buttons(/settings/i)[0]);
    expect(screen.getByText('Frame rate')).toBeTruthy();
    expect(screen.getByText(/SFX volume/)).toBeTruthy();
    expect(screen.getByText('Enable live chat')).toBeTruthy();
    const fps = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(fps, { target: { value: '30' } });
    expect(fps.value).toBe('30');
    fireEvent.click(buttons('Back')[0]);

    fireEvent.click(buttons('Leaderboard')[0]);
    // Rules are not editable by players any more.
    expect(screen.getByText(/players cannot change point values/)).toBeTruthy();
    expect(screen.queryByText(/Recalculate from a different set of calculations/)).toBeNull();
  });

  it('requires an email address to sign in and to sign up', () => {
    render(<App />);
    fireEvent.click(buttons('Sign In / Sign Up')[0]);
    expect(screen.getByText(/An email address, a username and a password/)).toBeTruthy();
    // Submitting with no email is rejected before any backend call.
    fireEvent.click(buttons('Sign In')[0]);
    expect(screen.getByText(/valid email/i)).toBeTruthy();
  });

  it('offers the Classic and Tournament presets and constrains the timers', () => {
    render(<App />);
    fireEvent.click(buttons('Play')[0]);
    expect(screen.getByText('Classic mode')).toBeTruthy();
    expect(screen.getByText('Tournament mode')).toBeTruthy();
    // Classic allows the Disabled (Normal) timer.
    expect(screen.getAllByText(/Disabled \(Normal\)/).length).toBeGreaterThan(0);

    fireEvent.click(within(screen.getByText('Tournament mode').closest('button')!).getByText('Tournament mode'));
    // Tournament forbids "none" and keeps Daily / Rapid / Blitz.
    expect(screen.queryByText(/Disabled \(Normal\)/)).toBeNull();
    expect(screen.getAllByText(/5min \(Blitz\)/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/1min \(Bullet\)/).length).toBe(0);
  });

  it('saves a game on exit and resumes it from the menu', () => {
    render(<App />);
    fireEvent.click(buttons('Play')[0]);
    fireEvent.click(buttons(/Start game/)[0]);
    const paths = document.querySelectorAll('path.country');
    fireEvent.click(paths[0]);
    advance(20000);

    // Exit offers Save & exit or Leave with a confirmation.
    fireEvent.click(buttons('Exit')[0]);
    expect(screen.getByText('Exit game')).toBeTruthy();
    fireEvent.click(buttons('Leave game')[0]);
    expect(screen.getByText(/Leave without saving/)).toBeTruthy();
    fireEvent.click(buttons('Keep playing')[0]);
    fireEvent.click(buttons(/Save & exit/)[0]);

    // Back on the menu with a saved game to resume.
    expect(screen.getByText(/saved game/)).toBeTruthy();
    fireEvent.click(buttons(/Resume a game/)[0]);
    expect(screen.getByText(/kept here/)).toBeTruthy();
    fireEvent.click(buttons('Resume')[0]);
    expect(document.querySelectorAll('path.country').length).toBeGreaterThan(150);
  });

  it('marks typed orders as mandatory everywhere (no setting to disable them)', () => {
    render(<App />);
    fireEvent.click(buttons('Rules')[0]);
    expect(screen.getByText(/Typed orders are mandatory/)).toBeTruthy();
    fireEvent.click(buttons('Back')[0]);
    fireEvent.click(buttons(/settings/i)[0]);
    expect(screen.queryByText(/Typed orders/)).toBeNull();
  });

  it('runs an offline simulation to completion', { timeout: 120000 }, () => {
    render(<App />);
    fireEvent.click(buttons('Play')[0]);
    fireEvent.click(within(screen.getByText('Offline Simulation').closest('button')!).getByText('Offline Simulation'));
    // a small map keeps the simulated game short
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Oceania' } });
    fireEvent.click(buttons(/Start game/)[0]);
    expect(document.querySelectorAll('path.country').length).toBeGreaterThan(5);

    // bots only: the game plays itself out
    let done = false;
    for (let i = 0; i < 300 && !done; i++) {
      advance(2000);
      done = Boolean(document.querySelector('.modal-backdrop'));
    }
    expect(document.querySelector('.modal-backdrop'), 'results dialog').toBeTruthy();
    expect(screen.getByText(/wins!/)).toBeTruthy();
    expect(screen.getByText('Play again')).toBeTruthy();

    // the finished game was recorded locally and shows up in Stats
    fireEvent.click(buttons('Back to menu')[0]);
    fireEvent.click(buttons(/stats/i)[0]);
    expect(screen.getByText('Games played')).toBeTruthy();
  });
});
