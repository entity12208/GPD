"""Minimal TopoJSON decoder — turns world-110m.json into per-country rings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Tuple

DATA_DIR = Path(__file__).resolve().parent / "data"
TOPO_FILE = DATA_DIR / "world-110m.json"

Ring = List[Tuple[float, float]]
CountryGeometry = List[Ring]  # outer ring first, then holes (mostly unused at 110m)


def _decode_arcs(topology: dict) -> List[Ring]:
    scale = topology.get("transform", {}).get("scale", [1, 1])
    translate = topology.get("transform", {}).get("translate", [0, 0])
    arcs: List[Ring] = []
    for arc in topology["arcs"]:
        x = y = 0
        points: Ring = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
        arcs.append(points)
    return arcs


def _ring(indexes: List[int], arcs: List[Ring]) -> Ring:
    out: Ring = []
    for idx in indexes:
        if idx >= 0:
            points = arcs[idx]
        else:
            points = list(reversed(arcs[~idx]))
        if out and points:
            out.extend(points[1:])
        else:
            out.extend(points)
    return out


def load_geometry(path: Path | None = None) -> Dict[str, List[CountryGeometry]]:
    """Return {numeric-iso: [polygon, ...]} with polygon = [ring, ...]."""
    raw = json.loads((path or TOPO_FILE).read_text(encoding="utf-8"))
    arcs = _decode_arcs(raw)
    out: Dict[str, List[CountryGeometry]] = {}
    for geom in raw["objects"]["countries"]["geometries"]:
        key = str(geom.get("id", ""))
        name = (geom.get("properties") or {}).get("name", "")
        if geom["type"] == "Polygon":
            polygons = [[_ring(r, arcs) for r in geom["arcs"]]]
        else:
            polygons = [[_ring(r, arcs) for r in poly] for poly in geom["arcs"]]
        out.setdefault(f"{key}|{name}", polygons)
    return out
