"""Geography: country data, map presets and the adjacency graph.

The same ``countries.json`` fed to the web client is shipped here, so both
clients play on identical maps.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

DATA_DIR = Path(__file__).resolve().parent / "data"
COUNTRIES_FILE = DATA_DIR / "countries.json"

MAP_PRESETS: List[Tuple[str, str, str]] = [
    ("North America", "North America", "Canada to Panama and the Caribbean"),
    ("South America", "South America", "The southern cone and the Andes"),
    ("America", "America", "North and South America combined"),
    ("Africa", "Africa", "The full African continent"),
    ("Europe", "Europe", "Western, Central, Northern, Southern and Eastern Europe"),
    ("Asia", "Asia", "The largest continent"),
    ("Oceania", "Oceania", "Australia, New Zealand, Melanesia, Micronesia, Polynesia"),
    ("World", "World", "Every playable country"),
]

SEA_MAX_KM = 2000
OCEAN_MAX_KM = 7200
K_LANES = 4


@dataclass(frozen=True)
class SeaLane:
    id: str
    km: int
    water: str  # "sea" | "ocean"


@dataclass(frozen=True)
class Country:
    id: str
    n: str
    name: str
    cont: str
    lat: float
    lng: float
    area: int
    land: Tuple[str, ...]
    sea: Tuple[SeaLane, ...]


def _load() -> List[Country]:
    raw = json.loads(COUNTRIES_FILE.read_text(encoding="utf-8"))
    out: List[Country] = []
    for c in raw:
        out.append(
            Country(
                id=c["id"],
                n=c["n"],
                name=c["name"],
                cont=c["cont"],
                lat=c["lat"],
                lng=c["lng"],
                area=c["area"],
                land=tuple(c["land"]),
                sea=tuple(SeaLane(s["id"], s["km"], s["water"]) for s in c["sea"]),
            )
        )
    return out


ALL_COUNTRIES: List[Country] = _load()
BY_ID: Dict[str, Country] = {c.id: c for c in ALL_COUNTRIES}


@dataclass(frozen=True)
class Lane:
    id: str
    water: Optional[str]
    km: int


def countries_for_preset(preset: str) -> List[Country]:
    if preset == "World":
        return list(ALL_COUNTRIES)
    if preset == "America":
        return [c for c in ALL_COUNTRIES if c.cont in ("North America", "South America")]
    return [c for c in ALL_COUNTRIES if c.cont == preset]


def continent_members(cont: str) -> List[Country]:
    if cont == "America":
        return [c for c in ALL_COUNTRIES if c.cont in ("North America", "South America")]
    if cont == "World":
        return list(ALL_COUNTRIES)
    return [c for c in ALL_COUNTRIES if c.cont == cont]


def haversine(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    r = 6371.0
    d_lat = math.radians(b[0] - a[0])
    d_lng = math.radians(b[1] - a[1])
    la1 = math.radians(a[0])
    la2 = math.radians(b[0])
    h = math.sin(d_lat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(d_lng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class MapGraph:
    """Adjacency for one preset: land borders plus k-nearest sea lanes."""

    def __init__(self, preset: str) -> None:
        self.preset = preset
        self.countries = countries_for_preset(preset)
        self.ids = [c.id for c in self.countries]
        in_set = set(self.ids)
        self.land_pairs = set()
        adj: Dict[str, List[Lane]] = {cid: [] for cid in self.ids}

        for c in self.countries:
            for b in c.land:
                if b in in_set:
                    adj[c.id].append(Lane(b, None, 0))
                    self.land_pairs.add((min(c.id, b), max(c.id, b)))

        for c in self.countries:
            cands = []
            for o in self.countries:
                if o.id == c.id:
                    continue
                if (min(c.id, o.id), max(c.id, o.id)) in self.land_pairs:
                    continue
                km = haversine((c.lat, c.lng), (o.lat, o.lng))
                if km <= OCEAN_MAX_KM:
                    cands.append((km, o.id))
            cands.sort()
            for km, oid in cands[:K_LANES]:
                water = "sea" if km <= SEA_MAX_KM else "ocean"
                adj[c.id].append(Lane(oid, water, int(round(km))))

        # sea lanes are mutual
        for cid in self.ids:
            for lane in list(adj[cid]):
                back = adj[lane.id]
                if not any(x.id == cid for x in back):
                    back.append(Lane(cid, lane.water, lane.km))

        self.adj = adj
        self._connect()

    def _connect(self) -> None:
        parent = {cid: cid for cid in self.ids}

        def find(x: str) -> str:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        for cid in self.ids:
            for lane in self.adj[cid]:
                union(cid, lane.id)

        groups: Dict[str, List[str]] = {}
        for cid in self.ids:
            groups.setdefault(find(cid), []).append(cid)
        if len(groups) > 1:
            values = list(groups.values())
            base = list(values[0])
            for group in values[1:]:
                best = None
                for a in base:
                    for b in group:
                        km = haversine((BY_ID[a].lat, BY_ID[a].lng), (BY_ID[b].lat, BY_ID[b].lng))
                        if best is None or km < best[0]:
                            best = (km, a, b)
                if best is None:
                    continue
                km, a, b = best
                water = "sea" if km <= SEA_MAX_KM else "ocean"
                self.adj[a].append(Lane(b, water, int(round(km))))
                self.adj[b].append(Lane(a, water, int(round(km))))
                union(a, b)
                base.extend(group)

    def lane(self, a: str, b: str) -> Optional[Lane]:
        for lane in self.adj.get(a, ()):
            if lane.id == b:
                return lane
        return None


_GRAPH_CACHE: Dict[str, MapGraph] = {}


def graph_for_preset(preset: str) -> MapGraph:
    hit = _GRAPH_CACHE.get(preset)
    if hit is None:
        hit = MapGraph(preset)
        _GRAPH_CACHE[preset] = hit
    return hit


def presets() -> Iterable[Tuple[str, str, str]]:
    return MAP_PRESETS
