import { describe, expect, it } from 'vitest';
import { ATLAS_FEATURES, idFor } from '../WorldMap';
import { ALL_COUNTRIES } from '../../engine/data';

/**
 * Regression: world-atlas gives Kosovo, N. Cyprus and Somaliland no usable numeric id. They used to
 * all fall back to the same record, so two territories rendered as a third and the board was wrong.
 */
describe('atlas → game-country mapping', () => {
  it('gives every atlas shape its own country id', () => {
    const seen = new Map<string, string[]>();
    for (const f of ATLAS_FEATURES) {
      const id = idFor(f);
      if (!id) continue; // Antarctica and Fr. S. Antarctic Lands are not playable
      seen.set(id, [...(seen.get(id) ?? []), f.properties?.name ?? '?']);
    }
    const collisions = [...seen.entries()].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it('maps the three de-facto states separately', () => {
    const byName = Object.fromEntries(ATLAS_FEATURES.map((f) => [f.properties?.name, idFor(f)]));
    expect(byName['Kosovo']).toBe('XKX');
    expect(byName['N. Cyprus']).toBe('XNC');
    expect(byName['Somaliland']).toBe('XSL');
  });

  it('ships no junk numeric codes and no duplicate ones', () => {
    expect(ALL_COUNTRIES.map((c) => c.n).filter((n) => n === 'undefined' || n === 'null'))
      .toEqual([]);
    // Kosovo, N. Cyprus and Somaliland have no ccn3 at all, so they are matched by name instead.
    const codes = ALL_COUNTRIES.map((c) => c.n).filter((n) => n !== '');
    expect(new Set(codes).size).toBe(codes.length);
  });
});
