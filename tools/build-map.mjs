import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const topo = JSON.parse(readFileSync('tools/countries-110m.json', 'utf8'));
const meta = JSON.parse(readFileSync('tools/countries.json', 'utf8'));

const geoms = topo.objects.countries.geometries;
const byCcn3 = new Map();
for (const m of meta) if (m.ccn3) byCcn3.set(m.ccn3.padStart(3, '0'), m);

// --- continent classification -------------------------------------------------
function continentOf(m) {
  if (!m) return null;
  const r = m.region, s = m.subregion;
  if (r === 'Africa') return 'Africa';
  if (r === 'Europe') return 'Europe';
  if (r === 'Asia') return 'Asia';
  if (r === 'Oceania') return 'Oceania';
  if (r === 'Americas') {
    if (s === 'South America') return 'South America';
    return 'North America';
  }
  return null;
}
// data-driven tweaks where the source grouping differs from common play maps
const CONT_OVERRIDE = { RUS: 'Europe' };
// a few de-facto states missing from the metadata file (matched by map name)
const MANUAL = {
  Kosovo: { id: 'XKX', name: 'Kosovo', cont: 'Europe', lat: 42.6, lng: 20.9, area: 10887 },
  'N. Cyprus': { id: 'XNC', name: 'Northern Cyprus', cont: 'Asia', lat: 35.2, lng: 33.4, area: 3355 },
  Somaliland: { id: 'XSL', name: 'Somaliland', cont: 'Africa', lat: 9.5, lng: 46.5, area: 137600 },
};

// --- land adjacency from shared topology arcs ---------------------------------
const arcOwners = new Map(); // abs arc index -> Set(geom index)
const geomArcs = [];
geoms.forEach((g, i) => {
  const set = new Set();
  const walk = (a) => {
    if (typeof a === 'number') set.add(a < 0 ? ~a : a); // TopoJSON: shared arcs use i / ~i
    else a.forEach(walk);
  };
  walk(g.arcs);
  geomArcs.push(set);
  for (const a of set) {
    if (!arcOwners.has(a)) arcOwners.set(a, []);
    arcOwners.get(a).push(i);
  }
});
const landAdj = geoms.map(() => new Set());
for (const [, owners] of arcOwners) {
  for (let a = 0; a < owners.length; a++)
    for (let b = a + 1; b < owners.length; b++) {
      landAdj[owners[a]].add(owners[b]);
      landAdj[owners[b]].add(owners[a]);
    }
}

// --- helpers -----------------------------------------------------------------
const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const la1 = rad(a[0]), la2 = rad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// --- build country records ----------------------------------------------------
const countries = [];
const skipped = [];
geoms.forEach((g, i) => {
  // Some atlas entries (Kosovo, N. Cyprus, Somaliland) share the numeric id -99 / no id
  // at all, so they must fall through to the name map instead of becoming 'undefined'.
  const ccn3 = g.id === undefined || g.id === null ? '' : String(g.id).padStart(3, '0');
  const m = byCcn3.get(ccn3);
  const man = MANUAL[g.properties.name];
  if (!m && !man) { skipped.push(`${g.id} ${g.properties.name}`); return; }
  if (!m) {
    countries.push({ i, id: man.id, n: ccn3, name: man.name, cont: man.cont, lat: man.lat, lng: man.lng, area: man.area });
    return;
  }
  let cont = continentOf(m);
  if (CONT_OVERRIDE[m.cca3]) cont = CONT_OVERRIDE[m.cca3];
  if (!cont) { skipped.push(`${m.cca3} (no continent)`); return; }
  countries.push({
    i, id: m.cca3, n: ccn3, name: m.name.common, cont,
    lat: +m.latlng[0].toFixed(3), lng: +m.latlng[1].toFixed(3),
    area: m.area || 0,
  });
});
console.log('countries:', countries.length, 'skipped:', skipped.length, skipped.join(', '));

// map geom index -> record index
const byGeom = new Map(countries.map((c, idx) => [c.i, idx]));

// land borders (within the playable set)
for (const c of countries) {
  c.land = [...landAdj[c.i]].map((g) => byGeom.get(g)).filter((x) => x !== undefined).map((x) => countries[x].id);
}

// --- sea lanes: k-nearest non-land neighbours within a distance cap -----------
const SEA_MAX = 2000;      // km: crossing a body of water
const OCEAN_MAX = 7200;    // km: crossing a major ocean
const K = 4;
for (const c of countries) {
  const cands = [];
  for (const o of countries) {
    if (o.id === c.id || c.land.includes(o.id)) continue;
    const km = haversine([c.lat, c.lng], [o.lat, o.lng]);
    if (km <= OCEAN_MAX) cands.push([o.id, Math.round(km)]);
  }
  cands.sort((a, b) => a[1] - b[1]);
  c.sea = cands.slice(0, K).map(([id, km]) => ({ id, km, water: km <= SEA_MAX ? 'sea' : 'ocean' }));
}

// --- connectivity guarantee (union-find over land + sea) ----------------------
const idIdx = new Map(countries.map((c, i) => [c.id, i]));
const parent = countries.map((_, i) => i);
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
for (const c of countries) for (const b of c.land) union(idIdx.get(c.id), idIdx.get(b));
for (const c of countries) for (const s of c.sea) union(idIdx.get(c.id), idIdx.get(s.id));

// connect any remaining components with their shortest cross edge
let comps = new Map();
for (let i = 0; i < countries.length; i++) {
  const r = find(i);
  if (!comps.has(r)) comps.set(r, []);
  comps.get(r).push(i);
}
if (comps.size > 1) {
  const groups = [...comps.values()];
  const base = groups[0];
  for (let g = 1; g < groups.length; g++) {
    let best = null;
    for (const a of base) for (const b of groups[g]) {
      const km = haversine([countries[a].lat, countries[a].lng], [countries[b].lat, countries[b].lng]);
      if (!best || km < best.km) best = { a, b, km };
    }
    const km = Math.round(best.km);
    const entry = { id: countries[best.b].id, km, water: km <= SEA_MAX ? 'sea' : 'ocean' };
    countries[best.a].sea.push(entry);
    countries[best.b].sea.push({ id: countries[best.a].id, km, water: entry.water });
    union(best.a, best.b);
    groups[g].forEach((x) => base.push(x));
  }
  console.log('linked', comps.size - 1, 'disconnected components');
}

const out = countries.map(({ i, ...rest }) => rest);
mkdirSync('gpd/src/engine/data', { recursive: true });
mkdirSync('desktop/gpd_desktop/data', { recursive: true });
writeFileSync('gpd/src/engine/data/countries.json', JSON.stringify(out));
writeFileSync('desktop/gpd_desktop/data/countries.json', JSON.stringify(out));
writeFileSync('gpd/src/engine/data/world-110m.json', JSON.stringify(topo));
writeFileSync('desktop/gpd_desktop/data/world-110m.json', JSON.stringify(topo));

const counts = {};
for (const c of out) counts[c.cont] = (counts[c.cont] || 0) + 1;
console.log('continent counts', counts);
console.log('bytes', JSON.stringify(out).length);
