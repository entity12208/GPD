import { useMemo, useRef, useState } from 'react';
import { geoCentroid, geoNaturalEarth1, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import topoRaw from '../engine/data/world-110m.json';
import { ALL_COUNTRIES } from '../engine/data';

type Feat = Feature<Geometry, { name: string }>;
type FeatColl = FeatureCollection<Geometry, { name: string }>;

const topology = topoRaw as unknown as Parameters<typeof feature>[0];
const atlas = (topoRaw as unknown as { objects: { countries: unknown } }).objects.countries;
const collection = feature(topology, atlas as never) as unknown as FeatColl;

// Only real numeric codes: three atlas entries carry no ccn3 at all and are matched by name.
const BY_N: Record<string, string> = Object.fromEntries(
  ALL_COUNTRIES.filter((c) => /^\d+$/.test(c.n)).map((c) => [c.n, c.id]),
);
/** world-atlas keeps three de-facto states under the shared numeric id "-99". */
const ATLAS_NAME_TO_ID: Record<string, string> = {
  Kosovo: 'XKX',
  'N. Cyprus': 'XNC',
  Somaliland: 'XSL',
};

export function idFor(f: Feat): string | null {
  // Name first: the atlas gives Kosovo, N. Cyprus and Somaliland no usable numeric id.
  const byName = ATLAS_NAME_TO_ID[f.properties?.name ?? ''];
  if (byName) return byName;
  if (f.id === undefined || f.id === null) return null;
  return BY_N[String(f.id).padStart(3, '0')] ?? null;
}

/** Exported for the regression test that guards against two territories sharing an id. */
export const ATLAS_FEATURES: Feat[] = collection.features;
const FEATURES: { id: string | null; f: Feat }[] = ATLAS_FEATURES.map((f) => ({ id: idFor(f), f }));
const CENTROIDS: Record<string, [number, number]> = {};
for (const { id, f } of FEATURES) if (id) CENTROIDS[id] = geoCentroid(f) as [number, number];

export interface VisionEntry { owner: number | null; troops: number | null; vulnerable: boolean | null }

export interface WorldMapProps {
  active: string[];
  vision: Record<string, VisionEntry>;
  colors: string[];
  teamColors: Record<number, string>;
  markers?: { territory: string; team: number; isMine: boolean; turn?: number }[];
  selected?: string | null;
  targets?: Set<string>;
  showTroops?: boolean;
  /** What to call a country for this viewer; Fog of War hides unclaimed names. */
  labelFor?: (id: string) => string;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
}

export function WorldMap({
  active, vision, colors, teamColors, markers = [], selected, targets, showTroops = true, labelFor, onSelect, onHover,
}: WorldMapProps) {
  const W = 1000;
  const H = 520;
  const activeSet = useMemo(() => new Set(active), [active]);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const { paths, centers } = useMemo(() => {
    const feats = FEATURES.filter((x) => x.id && activeSet.has(x.id));
    const fc: FeatColl = { type: 'FeatureCollection', features: feats.map((x) => x.f) };
    const projection = geoNaturalEarth1().fitExtent([[6, 6], [W - 6, H - 6]], fc as never);
    const path = geoPath(projection);
    const p: { id: string; d: string }[] = [];
    const c: Record<string, [number, number]> = {};
    for (const { id, f } of feats) {
      if (!id) continue;
      p.push({ id, d: path(f) ?? '' });
      const cen = CENTROIDS[id] ?? (geoCentroid(f) as [number, number]);
      const pt = projection(cen);
      if (pt) c[id] = [pt[0], pt[1]];
    }
    return { paths: p, centers: c };
  }, [activeSet]);

  function fillFor(id: string): string {
    const v = vision[id];
    if (!v || v.owner === null) return '#2b3b4d';
    return colors[v.owner % colors.length] ?? '#2b3b4d';
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="World map"
      onWheel={(e) => {
        e.preventDefault();
        const k = Math.min(8, Math.max(1, view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        setView((v) => ({ ...v, k }));
      }}
      onPointerDown={(e) => {
        if (view.k <= 1) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }));
      }}
      onPointerUp={() => { drag.current = null; }}
    >
      <rect className="map-ocean" x={0} y={0} width={W} height={H} />
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {paths.map(({ id, d }) => {
          const v = vision[id];
          const isSelected = selected === id;
          const isTarget = targets?.has(id) ?? false;
          const cls = ['country'];
          if (v?.owner !== null && v?.owner !== undefined) cls.push('country--mine');
          if (v?.vulnerable) cls.push('country--vulnerable');
          if (isSelected) cls.push('country--selected');
          if (isTarget) cls.push('country--target');
          return (
            <path
              key={id}
              d={d}
              className={cls.join(' ')}
              fill={fillFor(id)}
              onClick={() => onSelect?.(id)}
              onMouseEnter={() => onHover?.(id)}
              onMouseLeave={() => onHover?.(null)}
            >
              <title>{labelFor ? labelFor(id) : id}</title>
            </path>
          );
        })}
        {showTroops && paths.map(({ id }) => {
          const v = vision[id];
          const c = centers[id];
          if (!c || v?.troops === null || v?.troops === undefined) return null;
          return (
            <text key={`t-${id}`} className="troop-label" x={c[0]} y={c[1]} textAnchor="middle" dominantBaseline="central">
              {v.troops}
            </text>
          );
        })}
        {markers.map((m, i) => {
          const c = centers[m.territory];
          if (!c) return null;
          const team = teamColors[m.team] ?? '#ffffff';
          return (
            <text
              key={`m-${i}-${m.territory}-${m.turn ?? i}`}
              className="bang"
              x={c[0] + 9}
              y={c[1] - 8}
              textAnchor="middle"
              fill={team}
            >
              !
            </text>
          );
        })}
      </g>
    </svg>
  );
}
