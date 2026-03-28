#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["shapely>=2.0", "requests"]
# ///
"""
Generate accurate coastline data from Natural Earth geographic data.

Uses 10m land polygons for coastline geometry (high detail) and 50m
country boundaries only for classifying land into Iran vs Arabian Peninsula.

Usage:
    uv run shared/scripts/generate_coastlines.py
"""

import json
from pathlib import Path

import requests
from shapely.geometry import shape, box, Polygon, MultiPolygon
from shapely.ops import unary_union

# ---------------------------------------------------------------------------
# Map coordinate system (must match client/src/map/data.ts)
# ---------------------------------------------------------------------------

ORIGIN_LON = 47.5
ORIGIN_LAT = 30.5
LON_SCALE = 9708
LAT_SCALE = 10800

# Map bounding box — full Persian Gulf
BBOX_WEST = 47.5
BBOX_EAST = 59.1
BBOX_SOUTH = 23.0
BBOX_NORTH = 30.6

MAP_WIDTH = 113000
MAP_HEIGHT = 81000

# Simplification tolerance in degrees (~110m at these latitudes)
SIMPLIFY_TOLERANCE = 0.001

# Minimum island area in degrees² to keep
MIN_ISLAND_AREA = 0.0003

# Country classifications
IRAN_COUNTRIES = {"Iran"}
ARABIAN_COUNTRIES = {"Iraq", "Kuwait", "Saudi Arabia", "Bahrain", "Qatar",
                     "United Arab Emirates", "Oman"}

NE_COUNTRIES_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
NE_LAND_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"

CACHE_DIR = Path(__file__).parent / ".cache"
OUTPUT_PATH = Path(__file__).parent.parent.parent / "client" / "src" / "map" / "coastlines.ts"


def geo_to_game(lon: float, lat: float) -> tuple[int, int]:
    x = round((lon - ORIGIN_LON) * LON_SCALE)
    y = round((ORIGIN_LAT - lat) * LAT_SCALE)
    return (x, y)


def download(url: str, name: str) -> dict:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / name
    if cache_path.exists():
        print(f"  Using cached: {name}")
        with open(cache_path) as f:
            return json.load(f)
    print(f"  Downloading {name}...")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    with open(cache_path, "w") as f:
        json.dump(data, f)
    return data


def clip_geometry(geom, clip_box) -> list[Polygon]:
    if not geom.is_valid:
        geom = geom.buffer(0)
    intersection = geom.intersection(clip_box)
    if intersection.is_empty:
        return []
    if isinstance(intersection, Polygon):
        return [intersection]
    if isinstance(intersection, MultiPolygon):
        return list(intersection.geoms)
    return []


def build_country_masks(countries_geojson: dict, clip_box) -> tuple:
    """
    Build rough classification masks from 50m country data.
    Returns (iran_mask, arabian_mask) as shapely geometries.
    Used only for classifying which land belongs to which side.
    """
    iran_polys = []
    arabian_polys = []

    for feature in countries_geojson["features"]:
        name = feature["properties"].get("NAME", "")
        geom = shape(feature["geometry"])
        clipped = clip_geometry(geom, clip_box)
        if not clipped:
            continue

        if name in IRAN_COUNTRIES:
            iran_polys.extend(clipped)
            print(f"    {name}: {len(clipped)} polygon(s)")
        elif name in ARABIAN_COUNTRIES:
            arabian_polys.extend(clipped)
            print(f"    {name}: {len(clipped)} polygon(s)")

    # Merge with buffer to close border gaps
    MERGE_BUFFER = 0.05
    iran_mask = None
    arabian_mask = None

    if iran_polys:
        buffered = [p.buffer(MERGE_BUFFER) for p in iran_polys]
        iran_mask = unary_union(buffered)

    if arabian_polys:
        buffered = [p.buffer(MERGE_BUFFER) for p in arabian_polys]
        arabian_mask = unary_union(buffered)

    return iran_mask, arabian_mask


def classify_land_with_masks(
    land_geojson: dict,
    clip_box,
    iran_mask,
    arabian_mask,
) -> tuple[list[Polygon], list[Polygon], list[Polygon]]:
    """
    Clip 10m land polygons and classify each using the country masks.
    The masks are ONLY used for classification — the original 10m geometry
    is preserved intact (not intersected with the mask).
    """
    iran_polys = []
    arabian_polys = []
    island_polys = []

    for feature in land_geojson["features"]:
        geom = shape(feature["geometry"])
        clipped = clip_geometry(geom, clip_box)

        for poly in clipped:
            if poly.area < MIN_ISLAND_AREA:
                continue

            # Check overlap with each mask (just for classification)
            iran_overlap = poly.intersection(iran_mask).area if iran_mask else 0
            arabian_overlap = poly.intersection(arabian_mask).area if arabian_mask else 0

            overlap_ratio_iran = iran_overlap / poly.area if poly.area > 0 else 0
            overlap_ratio_arabian = arabian_overlap / poly.area if poly.area > 0 else 0

            # If polygon overlaps BOTH masks significantly, split it
            if overlap_ratio_iran > 0.15 and overlap_ratio_arabian > 0.15:
                # Split: use mask intersection for the border, preserving
                # 10m coastline detail on the sea-facing edges
                iran_part = poly.intersection(iran_mask)
                arabian_part = poly.intersection(arabian_mask)
                for part in (iran_part.geoms if isinstance(iran_part, MultiPolygon) else [iran_part]):
                    if isinstance(part, Polygon) and part.area >= MIN_ISLAND_AREA:
                        iran_polys.append(part)
                for part in (arabian_part.geoms if isinstance(arabian_part, MultiPolygon) else [arabian_part]):
                    if isinstance(part, Polygon) and part.area >= MIN_ISLAND_AREA:
                        arabian_polys.append(part)
            elif overlap_ratio_iran > 0.2 and overlap_ratio_iran > overlap_ratio_arabian:
                iran_polys.append(poly)
            elif overlap_ratio_arabian > 0.2:
                arabian_polys.append(poly)
            else:
                island_polys.append(poly)

    return iran_polys, arabian_polys, island_polys


def polygon_to_game_coords(poly: Polygon) -> list[tuple[int, int]]:
    simplified = poly.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
    if isinstance(simplified, MultiPolygon):
        simplified = max(simplified.geoms, key=lambda p: p.area)
    if simplified.is_empty:
        return []
    coords = list(simplified.exterior.coords)
    if coords and coords[-1] == coords[0]:
        coords = coords[:-1]
    return [geo_to_game(lon, lat) for lon, lat in coords]


def geom_to_game_coords(geom) -> list[list[tuple[int, int]]]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        coords = polygon_to_game_coords(geom)
        return [coords] if coords and len(coords) >= 3 else []
    if isinstance(geom, MultiPolygon):
        result = []
        for poly in geom.geoms:
            coords = polygon_to_game_coords(poly)
            if coords and len(coords) >= 3:
                result.append(coords)
        return result
    return []


def polygon_area(coords: list[tuple[int, int]]) -> float:
    n = len(coords)
    area = 0
    for i in range(n):
        j = (i + 1) % n
        area += coords[i][0] * coords[j][1]
        area -= coords[j][0] * coords[i][1]
    return abs(area) / 2


def name_islands(islands: list[list[tuple[int, int]]]) -> list[tuple[str, list[tuple[int, int]]]]:
    known = {
        "Qeshm": geo_to_game(55.8, 26.85),
        "Bahrain": geo_to_game(50.55, 26.05),
        "Hormuz": geo_to_game(56.46, 27.06),
        "Larak": geo_to_game(56.35, 26.86),
        "Abu Musa": geo_to_game(55.03, 25.88),
        "Greater Tunb": geo_to_game(55.30, 26.27),
        "Lesser Tunb": geo_to_game(55.14, 26.24),
        "Hengam": geo_to_game(55.88, 26.63),
        "Kish": geo_to_game(53.98, 26.53),
        "Sirri": geo_to_game(54.54, 25.91),
        "Farur": geo_to_game(54.52, 26.24),
        "Kharg": geo_to_game(50.33, 29.23),
        "Bubiyan": geo_to_game(48.20, 29.80),
        "Failaka": geo_to_game(48.35, 29.45),
        "Das": geo_to_game(52.87, 25.15),
    }
    used_names = set()
    named = []

    for coords in islands:
        cx = sum(p[0] for p in coords) / len(coords)
        cy = sum(p[1] for p in coords) / len(coords)

        best_name = None
        best_dist = float("inf")
        for name, (kx, ky) in known.items():
            if name in used_names:
                continue
            dist = (cx - kx) ** 2 + (cy - ky) ** 2
            if dist < best_dist:
                best_dist = dist
                best_name = name

        if best_name and best_dist < 8000**2:
            used_names.add(best_name)
            named.append((best_name, coords))
        else:
            named.append((f"Island ({round(cx)}, {round(cy)})", coords))

    return named


def format_polygon(coords: list[tuple[int, int]], indent: str = "  ") -> str:
    return "\n".join(f"{indent}[{x}, {y}]," for x, y in coords)


def generate_typescript(
    iran_coords: list[list[tuple[int, int]]],
    arabian_coords: list[list[tuple[int, int]]],
    island_list: list[tuple[str, list[tuple[int, int]]]],
) -> str:
    lines = [
        "/**",
        " * Coastline data generated from Natural Earth 10m land polygons.",
        " * Country classification from Natural Earth 50m admin boundaries.",
        " * Do not edit — regenerate with: uv run shared/scripts/generate_coastlines.py",
        " */",
        "",
        "import type { Polygon } from './data';",
        "",
    ]

    # Iran
    if iran_coords:
        lines.append("/** Iran — all coastline polygons (10m detail). */")
        lines.append("export const IRAN_COAST_POLYS: Polygon[] = [")
        for coords in iran_coords:
            lines.append("  [")
            lines.append(format_polygon(coords, "    "))
            lines.append("  ],")
        lines.append("];")
        lines.append("")
        lines.append("export const IRAN_COAST: Polygon = IRAN_COAST_POLYS[0];")
        lines.append("")

    # Arabian Peninsula
    if arabian_coords:
        lines.append("/** Arabian Peninsula — all coastline polygons (10m detail). */")
        lines.append("export const ARABIAN_COAST_POLYS: Polygon[] = [")
        for coords in arabian_coords:
            lines.append("  [")
            lines.append(format_polygon(coords, "    "))
            lines.append("  ],")
        lines.append("];")
        lines.append("")
        lines.append("export const ARABIAN_COAST: Polygon = ARABIAN_COAST_POLYS[0];")
        lines.append("")

    # Islands
    if island_list:
        lines.append("/** Islands within the map area. */")
        lines.append("export const ISLAND_POLYGONS: { name: string; polygon: Polygon }[] = [")
        for name, coords in island_list:
            lines.append(f'  {{ name: "{name}", polygon: [')
            lines.append(format_polygon(coords, "    "))
            lines.append("  ] },")
        lines.append("];")
        lines.append("")

    total_points = (
        sum(len(c) for c in iran_coords)
        + sum(len(c) for c in arabian_coords)
        + sum(len(c) for _, c in island_list)
    )
    print(f"Total output: {total_points:,} points")

    return "\n".join(lines)


def main():
    print("=== Generating coastline data ===")
    print(f"Map area: {BBOX_WEST}°E–{BBOX_EAST}°E, {BBOX_SOUTH}°N–{BBOX_NORTH}°N")
    print(f"Simplification: {SIMPLIFY_TOLERANCE}° (~{SIMPLIFY_TOLERANCE * 111000:.0f}m)")
    print()

    clip_box = box(BBOX_WEST, BBOX_SOUTH, BBOX_EAST, BBOX_NORTH)

    # Download
    print("Loading data:")
    countries = download(NE_COUNTRIES_URL, "ne_50m_admin_0_countries.geojson")
    land = download(NE_LAND_URL, "ne_10m_land.geojson")
    print()

    # Build classification masks from 50m country data
    print("Building country masks (50m):")
    iran_mask, arabian_mask = build_country_masks(countries, clip_box)
    print()

    # Classify 10m land polygons using the masks
    print("Classifying 10m land polygons...")
    iran_polys, arabian_polys, island_polys = classify_land_with_masks(
        land, clip_box, iran_mask, arabian_mask
    )
    print(f"  Iran: {len(iran_polys)} polygons")
    print(f"  Arabia: {len(arabian_polys)} polygons")
    print(f"  Islands: {len(island_polys)} polygons")

    # Merge each set
    print("\nMerging polygons...")
    iran_merged = unary_union(iran_polys) if iran_polys else None
    arabian_merged = unary_union(arabian_polys) if arabian_polys else None

    # Convert to game coords
    iran_coords = geom_to_game_coords(iran_merged)
    arabian_coords = geom_to_game_coords(arabian_merged)
    print(f"  Iran: {len(iran_coords)} polygon(s), {sum(len(c) for c in iran_coords):,} points")
    print(f"  Arabia: {len(arabian_coords)} polygon(s), {sum(len(c) for c in arabian_coords):,} points")

    # Convert islands
    island_coords = []
    for poly in island_polys:
        coords = polygon_to_game_coords(poly)
        if coords and len(coords) >= 3:
            island_coords.append(coords)
    island_coords.sort(key=polygon_area, reverse=True)
    named_islands = name_islands(island_coords)
    print(f"  Islands: {len(named_islands)}, {sum(len(c) for _, c in named_islands):,} points")

    # Generate
    ts = generate_typescript(iran_coords, arabian_coords, named_islands)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(ts)
    print(f"\nWritten to {OUTPUT_PATH} ({len(ts):,} bytes)")


if __name__ == "__main__":
    main()
