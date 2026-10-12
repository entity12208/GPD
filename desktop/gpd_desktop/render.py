"""Rasterises the world map (Pillow) and projects coordinates for the UI.

Rendering the whole map into one texture — instead of drawing hundreds of
polygons every frame — keeps the Arcade client at a steady frame rate.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw

from . import mapdata as geo
from .theme import BORDER, NEUTRAL_COUNTRY, OCEAN, hex_to_rgb

ATLAS_NAME_TO_ID = {"Kosovo": "XKX", "N. Cyprus": "XNC", "Somaliland": "XSL"}

Point = Tuple[float, float]
Ring = List[Point]


class WorldMapRender:
    """Projects and rasterises the map for one preset."""

    def __init__(self, preset: str, width: int = 1400, height: int = 800, pad: int = 14,
                 geometry: Optional[Dict[str, list]] = None) -> None:
        from .topo import load_geometry

        self.preset = preset
        self.width = width
        self.height = height
        self.pad = pad
        self.raw_geometry = geometry or load_geometry()

        self.active = {c.id for c in geo.countries_for_preset(preset)}
        # Three atlas entries have no ccn3; they are matched by name instead.
        self.by_numeric = {c.n: c.id for c in geo.ALL_COUNTRIES if c.n and c.n.isdigit()}

        self.polygons: Dict[str, List[List[Ring]]] = {}      # lon/lat rings
        self.projected: Dict[str, List[List[Point]]] = {}    # screen rings
        self.centroids: Dict[str, Point] = {}
        self._cache_key: Optional[tuple] = None
        self._cache_image: Optional[Image.Image] = None

        self._collect()
        self._fit()
        self._project()

    # ------------------------------------------------------------- geometry --
    def _id_for(self, key: str) -> Optional[str]:
        numeric, _, name = key.partition("|")
        by_name = ATLAS_NAME_TO_ID.get(name)
        if by_name:
            return by_name
        if not numeric.isdigit():
            return None
        return self.by_numeric.get(numeric.zfill(3))

    def _collect(self) -> None:
        for key, polys in self.raw_geometry.items():
            cid = self._id_for(key)
            if cid is None:
                continue
            self.polygons[cid] = polys

    def _fit(self) -> None:
        lons: List[float] = []
        lats: List[float] = []
        for cid, polys in self.polygons.items():
            if cid not in self.active:
                continue
            for poly in polys:
                for ring in poly:
                    for lon, lat in ring:
                        lons.append(lon)
                        lats.append(lat)
        if not lons:
            self.lon_min, self.lon_max, self.lat_min, self.lat_max = -180, 180, -60, 85
        else:
            self.lon_min, self.lon_max = min(lons), max(lons)
            self.lat_min, self.lat_max = min(lats), max(lats)
        span_lon = max(1e-6, self.lon_max - self.lon_min)
        span_lat = max(1e-6, self.lat_max - self.lat_min)
        inner_w = self.width - 2 * self.pad
        inner_h = self.height - 2 * self.pad
        self.scale = min(inner_w / span_lon, inner_h / span_lat)
        self.offset_x = (self.width - span_lon * self.scale) / 2
        self.offset_y = (self.height - span_lat * self.scale) / 2

    def project(self, lon: float, lat: float) -> Point:
        x = self.offset_x + (lon - self.lon_min) * self.scale
        y = self.offset_y + (self.lat_max - lat) * self.scale  # screen space: y grows downwards
        return x, y

    def _project(self) -> None:
        for cid, polys in self.polygons.items():
            self.projected[cid] = [
                [[self.project(lon, lat) for lon, lat in part] for ring in poly for part in _split_antimeridian(ring)]
                for poly in polys
            ]
        for c in geo.ALL_COUNTRIES:
            if c.id in self.active:
                self.centroids[c.id] = self.project(c.lng, c.lat)

    # -------------------------------------------------------------- drawing --
    def image(
        self,
        owners: Dict[str, Optional[int]],
        colors: Sequence[str],
        selected: Optional[str] = None,
        targets: Optional[set] = None,
        vulnerable: Optional[set] = None,
    ) -> Image.Image:
        key = (
            tuple(sorted((cid, owners.get(cid)) for cid in self.active)),
            selected or "",
            tuple(sorted(targets or ())),
            tuple(sorted(vulnerable or ())),
        )
        if key == self._cache_key and self._cache_image is not None:
            return self._cache_image

        img = Image.new("RGBA", (self.width, self.height), OCEAN)
        draw = ImageDraw.Draw(img)

        for cid, polys in self.projected.items():
            is_active = cid in self.active
            if is_active:
                owner = owners.get(cid)
                fill = hex_to_rgb(colors[owner % len(colors)]) if owner is not None else NEUTRAL_COUNTRY
            else:
                fill = (26, 36, 46)
            outline = BORDER
            if is_active and cid == selected:
                outline = (255, 213, 74)
            elif is_active and targets and cid in targets:
                outline = (126, 231, 135)
            elif is_active and vulnerable and cid in vulnerable:
                outline = (255, 107, 107)
            for poly in polys:
                if not poly:
                    continue
                pts = [(int(round(x)), int(round(y))) for x, y in poly[0]]
                if len(pts) < 3:
                    continue
                draw.polygon(pts, fill=fill, outline=outline)
                for hole in poly[1:]:
                    hp = [(int(round(x)), int(round(y))) for x, y in hole]
                    if len(hp) >= 3:
                        draw.polygon(hp, fill=OCEAN)

        self._cache_key = key
        self._cache_image = img
        return img

    # ------------------------------------------------------------ hit tests --
    def hit_test(self, x: float, y: float) -> Optional[str]:
        for cid, polys in self.projected.items():
            if cid not in self.active:
                continue
            for poly in polys:
                if not poly:
                    continue
                if _point_in_ring(x, y, poly[0]) and not any(
                    _point_in_ring(x, y, hole) for hole in poly[1:]
                ):
                    return cid
        return None

    def centroid(self, cid: str) -> Optional[Point]:
        return self.centroids.get(cid)

    def outline(self, cid: str) -> List[Tuple[float, float]]:
        polys = self.projected.get(cid)
        return list(polys[0][0]) if polys and polys[0] else []


def _split_antimeridian(ring: Ring) -> List[Ring]:
    """Countries that straddle ±180° would otherwise stretch across the map."""
    parts: List[Ring] = [[]]
    prev: Optional[float] = None
    for lon, lat in ring:
        if prev is not None and abs(lon - prev) > 180:
            parts.append([])
        parts[-1].append((lon, lat))
        prev = lon
    out = []
    for part in parts:
        if len(part) < 3:
            continue
        if max(p[0] for p in part) - min(p[0] for p in part) > 320:
            continue
        out.append(part)
    return out


def _point_in_ring(x: float, y: float, ring: Ring) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def render_preview(
    preset: str,
    owner_of: Callable[[str], Optional[int]],
    colors: Sequence[str],
    path: str,
    width: int = 1400,
    height: int = 800,
) -> str:
    """Utility used by the desktop smoke tests and the docs."""
    r = WorldMapRender(preset, width, height)
    owners = {cid: owner_of(cid) for cid in r.active}
    img = r.image(owners, colors)
    img.convert("RGB").save(path)
    return path
