#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy", "scipy", "requests"]
# ///
"""
Generate heightmap data from ETOPO1 elevation data.

Downloads ETOPO1 global relief data from NOAA, extracts the region covering
the game map, applies gameplay scaling (non-linear compression + smoothing),
and outputs TypeScript + Python heightmap files.

The ETOPO1 data is 1 arc-minute (~1.8km) resolution — well-matched to our
500 game-unit grid cells (~2km each).

Usage:
    uv run shared/scripts/generate_heightmap.py
"""

import io
import struct
import zipfile
from pathlib import Path

import numpy as np
import requests
from scipy.interpolate import RegularGridInterpolator
from scipy.ndimage import gaussian_filter

# ---------------------------------------------------------------------------
# Map coordinate system (must match client/src/map/data.ts)
# ---------------------------------------------------------------------------

ORIGIN_LON = 47.5
ORIGIN_LAT = 30.5
LON_SCALE = 9708
LAT_SCALE = 10800
MAP_WIDTH = 113000
MAP_HEIGHT = 81000

# ---------------------------------------------------------------------------
# Grid settings
# ---------------------------------------------------------------------------

CELL_SIZE = 500  # game units per heightmap cell
GRID_W = MAP_WIDTH // CELL_SIZE   # 226
GRID_H = MAP_HEIGHT // CELL_SIZE  # 162

# ---------------------------------------------------------------------------
# Geographic bounding box (matches coastline script)
# ---------------------------------------------------------------------------

BBOX_WEST = 47.5
BBOX_EAST = 59.1
BBOX_SOUTH = 23.0
BBOX_NORTH = 30.6

# ---------------------------------------------------------------------------
# Elevation tuning — these control how real terrain maps to game units
# ---------------------------------------------------------------------------

MAX_GAME_ELEVATION = 300  # highest peaks in game units
ELEVATION_POWER = 0.55    # non-linear scaling (< 1 compresses peaks, emphasizes foothills)
SMOOTH_SIGMA = 1.5        # Gaussian blur radius in grid cells
OCEAN_THRESHOLD = 1       # elevation below this becomes 0 after smoothing

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CACHE_DIR = Path(__file__).parent / ".cache"
OUTPUT_TS = (
    Path(__file__).parent.parent.parent / "client" / "src" / "map" / "heightmap-data.ts"
)
OUTPUT_PY = (
    Path(__file__).parent.parent.parent
    / "server"
    / "src"
    / "hormuz"
    / "generated"
    / "heightmap.py"
)

# ---------------------------------------------------------------------------
# ETOPO1 data source
# ---------------------------------------------------------------------------

# NOAA THREDDS NCSS — downloads just our region as NetCDF (~300KB)
ETOPO_NCSS_URL = (
    "https://www.ngdc.noaa.gov/thredds/ncss"
    "/global/ETOPO1/ETOPO1_Bed_g_gmt4.nc"
)

# Fallback: full ETOPO1 binary from NOAA (~230MB zip, cached)
ETOPO1_BINARY_URL = (
    "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO1"
    "/data/bedrock/grid_registered/binary/etopo1_bed_g_i2.zip"
)

# ETOPO1 binary grid dimensions (grid-registered = +1 in each dimension)
ETOPO1_ROWS = 10801
ETOPO1_COLS = 21601


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------


def download_etopo_ncss() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Download ETOPO 2022 subset via NOAA THREDDS NCSS (small, fast)."""
    params = {
        "var": "z",
        "north": BBOX_NORTH,
        "south": BBOX_SOUTH,
        "west": BBOX_WEST,
        "east": BBOX_EAST,
        "disableProjSubset": "on",
        "horizStride": 1,
        "accept": "netcdf",
    }
    print("Downloading ETOPO 2022 region from NOAA THREDDS NCSS...")
    resp = requests.get(ETOPO_NCSS_URL, params=params, timeout=120)
    resp.raise_for_status()

    cache_file = CACHE_DIR / "etopo_region.nc"
    cache_file.write_bytes(resp.content)
    print(f"  Cached: {cache_file} ({len(resp.content)} bytes)")

    from scipy.io import netcdf_file

    with netcdf_file(io.BytesIO(resp.content), "r") as nc:
        z = nc.variables["z"][:].copy()
        lat = nc.variables["lat"][:].copy()
        lon = nc.variables["lon"][:].copy()

    print(f"  Grid: {z.shape[0]} lat × {z.shape[1]} lon")
    return z, lat, lon


def download_etopo1_binary() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Download full ETOPO1 binary and extract our region (fallback)."""
    zip_path = CACHE_DIR / "etopo1_bed_g_i2.zip"

    if not zip_path.exists():
        print("Downloading ETOPO1 binary (~230MB, one-time)...")
        resp = requests.get(ETOPO1_BINARY_URL, timeout=600, stream=True)
        resp.raise_for_status()
        total = 0
        with open(zip_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
                total += len(chunk)
        print(f"  Downloaded: {total / 1e6:.1f} MB")
    else:
        print(f"Using cached ETOPO1: {zip_path}")

    print("Extracting ETOPO1 data...")
    with zipfile.ZipFile(zip_path) as zf:
        bin_names = [n for n in zf.namelist() if n.endswith(".bin")]
        if not bin_names:
            raise RuntimeError(f"No .bin file found in {zip_path}")
        with zf.open(bin_names[0]) as f:
            raw = f.read()

    full = np.frombuffer(raw, dtype="<i2").reshape(ETOPO1_ROWS, ETOPO1_COLS)

    # Extract our region
    # ETOPO1 grid-registered: row 0 = 90°N, col 0 = -180°W
    # Cell size = 1/60 degree, grid is 10801 × 21601
    row_start = round((90 - BBOX_NORTH) * 60)
    row_end = round((90 - BBOX_SOUTH) * 60) + 1
    col_start = round((BBOX_WEST + 180) * 60)
    col_end = round((BBOX_EAST + 180) * 60) + 1

    z = full[row_start:row_end, col_start:col_end].astype(np.float64)

    # Create coordinate arrays (north to south, west to east)
    lat = np.linspace(BBOX_NORTH, BBOX_SOUTH, z.shape[0])
    lon = np.linspace(BBOX_WEST, BBOX_EAST, z.shape[1])

    print(f"  Region: {z.shape[0]} lat × {z.shape[1]} lon")
    return z, lat, lon


def get_elevation_data() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Get elevation data, trying NCSS first then falling back to binary."""
    cached_npy = CACHE_DIR / "etopo_processed.npz"
    if cached_npy.exists():
        print(f"Using cached processed data: {cached_npy}")
        data = np.load(cached_npy)
        return data["z"], data["lat"], data["lon"]

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Try NCSS subset first (small download)
    try:
        z, lat, lon = download_etopo_ncss()
        np.savez_compressed(cached_npy, z=z, lat=lat, lon=lon)
        return z, lat, lon
    except Exception as e:
        print(f"  NCSS download failed: {e}")
        print("  Falling back to ETOPO1 binary...")

    # Fall back to full ETOPO1 binary
    try:
        z, lat, lon = download_etopo1_binary()
        np.savez_compressed(cached_npy, z=z, lat=lat, lon=lon)
        return z, lat, lon
    except Exception as e:
        print(f"  ETOPO1 binary failed: {e}")

    raise RuntimeError(
        "Could not download elevation data. Check your internet connection.\n"
        "You can manually download ETOPO1 from:\n"
        f"  {ETOPO1_BINARY_URL}\n"
        f"Place the zip file at: {CACHE_DIR / 'etopo1_bed_g_i2.zip'}"
    )


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------


def build_heightmap(z: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Sample DEM data onto our game grid and apply gameplay scaling."""

    # Ensure lat is ascending for RegularGridInterpolator
    if lat[0] > lat[-1]:
        lat = lat[::-1]
        z = z[::-1, :]

    # Replace NODATA / ocean with 0
    z = np.where(z < 0, 0, z).astype(np.float64)

    # Build interpolator
    interp = RegularGridInterpolator(
        (lat, lon), z, method="linear", bounds_error=False, fill_value=0
    )

    # Game grid cell centers → geo coordinates
    cols = np.arange(GRID_W)
    rows = np.arange(GRID_H)
    game_x = cols * CELL_SIZE + CELL_SIZE / 2
    game_y = rows * CELL_SIZE + CELL_SIZE / 2
    cell_lons = game_x / LON_SCALE + ORIGIN_LON
    cell_lats = ORIGIN_LAT - game_y / LAT_SCALE

    # Meshgrid of query points (row = lat, col = lon)
    query_lats, query_lons = np.meshgrid(cell_lats, cell_lons, indexing="ij")
    points = np.column_stack([query_lats.ravel(), query_lons.ravel()])

    # Sample elevation
    grid = interp(points).reshape(GRID_H, GRID_W)
    grid = np.maximum(grid, 0)

    # Create land mask before any processing
    land_mask = grid > 0

    print(f"  Raw elevation range: 0 – {np.max(grid):.0f} m")
    print(f"  Land cells: {np.sum(land_mask)} / {GRID_H * GRID_W}")

    # Non-linear scaling: compress peaks, emphasize foothills
    max_real = np.max(grid)
    if max_real > 0:
        normalized = grid / max_real
        grid = np.power(normalized, ELEVATION_POWER) * MAX_GAME_ELEVATION

    # Gaussian smoothing for gentle slopes
    grid = gaussian_filter(grid, sigma=SMOOTH_SIGMA)

    # Re-apply land mask (smoothing bleeds elevation into ocean cells)
    grid[~land_mask] = 0

    # Clean up small values at coastline edges
    grid[grid < OCEAN_THRESHOLD] = 0

    print(f"  Game elevation range: 0 – {np.max(grid):.0f} game units")

    return np.round(grid).astype(np.uint16)


# ---------------------------------------------------------------------------
# Output generation
# ---------------------------------------------------------------------------


def write_typescript(grid: np.ndarray) -> None:
    """Write the heightmap as a TypeScript module."""
    OUTPUT_TS.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("// Auto-generated by generate_heightmap.py — do not edit manually.")
    lines.append("// Regenerate: uv run shared/scripts/generate_heightmap.py")
    lines.append("")
    lines.append(f"export const HEIGHTMAP_CELL_SIZE = {CELL_SIZE};")
    lines.append(f"export const HEIGHTMAP_WIDTH = {GRID_W};")
    lines.append(f"export const HEIGHTMAP_HEIGHT = {GRID_H};")
    lines.append(f"export const HEIGHTMAP_MAX_ELEVATION = {MAX_GAME_ELEVATION};")
    lines.append("")
    lines.append("// Row-major elevation grid (game units, 0 = sea level)")
    lines.append("// prettier-ignore")
    lines.append("export const HEIGHTMAP_DATA = new Uint16Array([")

    for row in range(GRID_H):
        row_data = grid[row, :]
        values = ",".join(str(v) for v in row_data)
        lines.append(f"  {values},")

    lines.append("]);")
    lines.append("")

    OUTPUT_TS.write_text("\n".join(lines))
    print(f"  TypeScript: {OUTPUT_TS} ({OUTPUT_TS.stat().st_size / 1024:.0f} KB)")


def write_python(grid: np.ndarray) -> None:
    """Write the heightmap as a Python module."""
    OUTPUT_PY.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    lines.append("# Auto-generated by generate_heightmap.py — do not edit manually.")
    lines.append("# Regenerate: uv run shared/scripts/generate_heightmap.py")
    lines.append("")
    lines.append(f"HEIGHTMAP_CELL_SIZE = {CELL_SIZE}")
    lines.append(f"HEIGHTMAP_WIDTH = {GRID_W}")
    lines.append(f"HEIGHTMAP_HEIGHT = {GRID_H}")
    lines.append(f"HEIGHTMAP_MAX_ELEVATION = {MAX_GAME_ELEVATION}")
    lines.append("")
    lines.append("# Row-major elevation grid (game units, 0 = sea level)")
    lines.append("HEIGHTMAP_DATA = (")

    # Write as a tuple of ints (compact, immutable)
    for row in range(GRID_H):
        row_data = grid[row, :]
        values = ",".join(str(v) for v in row_data)
        lines.append(f"    {values},")

    lines.append(")")
    lines.append("")

    OUTPUT_PY.write_text("\n".join(lines))
    print(f"  Python: {OUTPUT_PY} ({OUTPUT_PY.stat().st_size / 1024:.0f} KB)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print(f"Heightmap generator")
    print(f"  Grid: {GRID_W} × {GRID_H} cells ({CELL_SIZE} game units/cell)")
    print(f"  Max elevation: {MAX_GAME_ELEVATION} game units")
    print(f"  Scaling power: {ELEVATION_POWER}")
    print(f"  Smoothing sigma: {SMOOTH_SIGMA}")
    print()

    z, lat, lon = get_elevation_data()
    grid = build_heightmap(z, lat, lon)

    print()
    print("Writing output files...")
    write_typescript(grid)
    write_python(grid)
    print()
    print("Done.")


if __name__ == "__main__":
    main()
