/**
 * Strait of Hormuz — map data.
 *
 * All spatial data is generated from shared/map.yaml via pnpm generate.
 * This file re-exports generated data and provides utility constants.
 *
 * Coordinate system:
 *   - Origin (0, 0) = top-left (northwest corner of map)
 *   - X axis = east (increasing longitude)
 *   - Y axis = south (decreasing latitude)
 */

// Re-export generated map data
export type { Point, Polygon, Polyline, SpawnPoint, Rock, ExclusionZone } from "../generated/map_data";

export {
	IRAN_SPAWNS,
	US_SPAWNS,
	TANKER_SPAWNS,
	QUADCOPTER_SPAWNS,
	US_BASES,
	LANE_INBOUND,
	LANE_OUTBOUND,
	DEEP_WATER_ROUTE,
	SHALLOW_WATERS,
	VERY_SHALLOW_WATERS,
	SHOALS,
	ROCKS,
	EXCLUSION_ZONES,
} from "../generated/map_data";

// Re-export coastlines (generated from Natural Earth data, separate pipeline)
export {
	IRAN_COAST,
	IRAN_COAST_POLYS,
	ARABIAN_COAST,
	ARABIAN_COAST_POLYS,
	ISLAND_POLYGONS,
} from "./coastlines";

// ---------------------------------------------------------------------------
// Map bounds
// ---------------------------------------------------------------------------

export const MAP = {
	width: 113000,
	height: 81000,
	center: { x: 85500, y: 40500 } as const, // strait narrows (~56.3°E, 26.75°N)
} as const;

// ---------------------------------------------------------------------------
// Geo conversion (for manual coordinate computation — data uses game coords)
// ---------------------------------------------------------------------------

const ORIGIN_LON = 47.5;
const ORIGIN_LAT = 30.5;
const LON_SCALE = 9708;
const LAT_SCALE = 10800;

export function geo(lat: number, lon: number): [number, number] {
	return [
		Math.round((lon - ORIGIN_LON) * LON_SCALE),
		Math.round((ORIGIN_LAT - lat) * LAT_SCALE),
	];
}

/** Lane width: ~2 nautical miles each ≈ 3.7km ≈ 400 game units */
export const LANE_WIDTH = 400;
export const SEPARATION_ZONE_WIDTH = 200;
