import { describe, expect, it } from 'vitest';
import { errorMessage, isValidEmail } from '../supabase';

// Supabase/PostgREST never throw `Error` instances. Before this helper existed,
// `e instanceof Error` was false for every backend failure, so hosting a game
// reported the useless "Could not host the game" instead of the real cause
// ("Could not find the table 'public.games' in the schema cache").
describe('errorMessage', () => {
  it('reads the message out of a plain PostgREST error object', () => {
    expect(errorMessage({ message: "Could not find the table 'public.games' in the schema cache", code: 'PGRST205' }))
      .toBe("Could not find the table 'public.games' in the schema cache");
  });

  it('appends the hint when it adds information', () => {
    expect(errorMessage({ message: 'new row violates row-level security policy', hint: 'check the insert policy' }))
      .toBe('new row violates row-level security policy — check the insert policy');
  });

  it('does not repeat a hint already contained in the message', () => {
    expect(errorMessage({ message: 'boom — boom', hint: 'boom' })).toBe('boom — boom');
  });

  it('handles real Error instances, strings and Supabase auth errors', () => {
    expect(errorMessage(new Error('Supabase is not configured'))).toBe('Supabase is not configured');
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage({ error_description: 'Invalid login credentials' })).toBe('Invalid login credentials');
  });

  it('falls back only when nothing usable was thrown', () => {
    expect(errorMessage(null, 'Could not host the game')).toBe('Could not host the game');
    expect(errorMessage({}, 'Could not host the game')).toBe('Could not host the game');
    expect(errorMessage(undefined, 'Could not join the game')).toBe('Could not join the game');
  });
});

describe('isValidEmail', () => {
  it('requires an address and a dotted domain', () => {
    expect(isValidEmail('you@example.com')).toBe(true);
    expect(isValidEmail('you@example')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
  });
});
