import raw from './data/countries.json';
import type { CountryDef, MapPreset, WaterKind } from './types';

export const ALL_COUNTRIES: CountryDef[] = raw as CountryDef[];

export const BY_ID: Record<string, CountryDef> = Object.fromEntries(
  ALL_COUNTRIES.map((c) => [c.id, c]),
);

export const CONTINENT_IDS = [
  'North America', 'South America', 'America', 'Africa', 'Europe', 'Asia', 'Oceania', 'World',
] as const;

/** Presets shown in the "selectable continents" menu. */
export const MAP_PRESETS: { id: MapPreset; label: string; blurb: string }[] = [
  { id: 'North America', label: 'North America', blurb: 'Canada to Panama and the Caribbean' },
  { id: 'South America', label: 'South America', blurb: 'The southern cone and the Andes' },
  { id: 'America', label: 'America', blurb: 'North and South America combined' },
  { id: 'Africa', label: 'Africa', blurb: 'The full African continent' },
  { id: 'Europe', label: 'Europe', blurb: 'Western, Central, Northern, Southern and Eastern Europe' },
  { id: 'Asia', label: 'Asia', blurb: 'The largest continent' },
  { id: 'Oceania', label: 'Oceania', blurb: 'Australia, New Zealand, Melanesia, Micronesia, Polynesia' },
  { id: 'World', label: 'World', blurb: 'Every playable country' },
];

const SEA_MAX_KM = 2000;    // crossing a body of water: flat extra $100
const OCEAN_MAX_KM = 7200;  // crossing a major ocean: $50 per troop
const K_LANES = 4;

export function countriesForPreset(preset: MapPreset): CountryDef[] {
  if (preset === 'World') return ALL_COUNTRIES;
  if (preset === 'America')
    return ALL_COUNTRIES.filter((c) => c.cont === 'North America' || c.cont === 'South America');
  return ALL_COUNTRIES.filter((c) => c.cont === preset);
}

/** Continent buckets used for the "fully own a continent" bonus (always the true continents). */
export function continentMembers(cont: string): CountryDef[] {
  if (cont === 'America')
    return ALL_COUNTRIES.filter((c) => c.cont === 'North America' || c.cont === 'South America');
  if (cont === 'World') return ALL_COUNTRIES;
  return ALL_COUNTRIES.filter((c) => c.cont === cont);
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversine(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const la1 = rad(a[0]);
  const la2 = rad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface MapGraph {
  preset: MapPreset;
  ids: string[];
  /** adjacency: neighbour id -> lane info (land lanes have water: null) */
  adj: Record<string, { id: string; water: WaterKind | null; km: number }[]>;
  landSet: Set<string>; // "a|b" sorted pairs joined by "|"
}

const cache = new Map<MapPreset, MapGraph>();

/** Build adjacency for the countries of a preset; sea lanes are recomputed inside the subset. */
export function graphForPreset(preset: MapPreset): MapGraph {
  const hit = cache.get(preset);
  if (hit) return hit;

  const list = countriesForPreset(preset);
  const ids = list.map((c) => c.id);
  const inSet = new Set(ids);
  const adj: MapGraph['adj'] = {};
  const landSet = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const c of list) adj[c.id] = [];

  // land borders inside the subset
  for (const c of list) {
    for (const b of c.land) {
      if (!inSet.has(b)) continue;
      adj[c.id].push({ id: b, water: null, km: 0 });
      landSet.add(key(c.id, b));
    }
  }

  // sea lanes: k nearest non-land neighbours inside the subset
  for (const c of list) {
    const cands: { id: string; km: number }[] = [];
    for (const o of list) {
      if (o.id === c.id || landSet.has(key(c.id, o.id))) continue;
      const km = haversine([c.lat, c.lng], [o.lat, o.lng]);
      if (km <= OCEAN_MAX_KM) cands.push({ id: o.id, km });
    }
    cands.sort((a, b) => a.km - b.km);
    for (const cand of cands.slice(0, K_LANES)) {
      adj[c.id].push({
        id: cand.id,
        water: cand.km <= SEA_MAX_KM ? 'sea' : 'ocean',
        km: Math.round(cand.km),
      });
    }
  }

  // guarantee connectivity of the playable graph
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const id of ids) for (const nb of adj[id]) union(id, nb.id);

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  if (groups.size > 1) {
    const base = [...groups.values()][0];
    for (const g of [...groups.values()].slice(1)) {
      let best: { a: string; b: string; km: number } | null = null;
      for (const a of base) for (const b of g) {
        const km = haversine([BY_ID[a].lat, BY_ID[a].lng], [BY_ID[b].lat, BY_ID[b].lng]);
        if (!best || km < best.km) best = { a, b, km };
      }
      if (!best) continue;
      const water: WaterKind = best.km <= SEA_MAX_KM ? 'sea' : 'ocean';
      adj[best.a].push({ id: best.b, water, km: Math.round(best.km) });
      adj[best.b].push({ id: best.a, water, km: Math.round(best.km) });
      union(best.a, best.b);
      base.push(...g);
    }
  }

  // A sea lane is a two-way relationship: make the k-nearest graph symmetric.
  for (const c of list) {
    for (const lane of adj[c.id]) {
      const back = adj[lane.id];
      if (back && !back.some((x) => x.id === c.id)) {
        back.push({ id: c.id, water: lane.water, km: lane.km });
      }
    }
  }

  const graph: MapGraph = { preset, ids, adj, landSet };
  cache.set(preset, graph);
  return graph;
}

export function laneBetween(preset: MapPreset, a: string, b: string) {
  const g = graphForPreset(preset);
  return g.adj[a]?.find((x) => x.id === b) ?? null;
}

export const SEA_THRESHOLD_KM = SEA_MAX_KM;
export const OCEAN_LIMIT_KM = OCEAN_MAX_KM;
