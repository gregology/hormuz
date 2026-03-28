/**
 * Strait of Hormuz — map data.
 *
 * Coverage: Bahrain (west) to Muscat (east).
 *
 * Coordinate system:
 *   - Origin (0, 0) = top-left (northwest corner of map)
 *   - X axis = east (increasing longitude)
 *   - Y axis = south (decreasing latitude)
 *
 * Geo conversion:
 *   game_x = (lon - 50.0) * 9708
 *   game_y = (27.5 - lat) * 10800
 *
 * Coastlines are generated from Natural Earth 10m data:
 *   uv run shared/scripts/generate_coastlines.py
 */

export type Point = [number, number]; // [x, y]
export type Polygon = Point[];
export type Polyline = Point[];

// ---------------------------------------------------------------------------
// Geo conversion
// ---------------------------------------------------------------------------

const ORIGIN_LON = 47.5;
const ORIGIN_LAT = 30.5;
const LON_SCALE = 9708;
const LAT_SCALE = 10800;

function geo(lat: number, lon: number): Point {
  return [
    Math.round((lon - ORIGIN_LON) * LON_SCALE),
    Math.round((ORIGIN_LAT - lat) * LAT_SCALE),
  ];
}

function geoLine(coords: [number, number][]): Point[] {
  return coords.map(([lat, lon]) => geo(lat, lon));
}

// ---------------------------------------------------------------------------
// Map bounds
// ---------------------------------------------------------------------------

export const MAP = {
  width: 113000,
  height: 81000,
  center: { x: 85500, y: 40500 } as const, // strait narrows (~56.3°E, 26.75°N)
} as const;

// ---------------------------------------------------------------------------
// Coastlines — imported from generated Natural Earth data
// ---------------------------------------------------------------------------

export {
  IRAN_COAST,
  IRAN_COAST_POLYS,
  ARABIAN_COAST,
  ARABIAN_COAST_POLYS,
  ISLAND_POLYGONS,
} from "./coastlines";

// ---------------------------------------------------------------------------
// Shipping lanes (Traffic Separation Scheme)
// ---------------------------------------------------------------------------

/** Inbound lane — tankers entering the Gulf. Northern lane. */
export const LANE_INBOUND: Polyline = geoLine([
  [26.20, 59.00],
  [26.30, 58.00],
  [26.35, 57.20],
  [26.40, 56.70],
  [26.45, 56.45],
  [26.50, 56.20],
  [26.50, 55.90],
  [26.45, 55.60],
  [26.40, 55.30],
]);

/** Outbound lane — tankers leaving the Gulf. Southern lane. */
export const LANE_OUTBOUND: Polyline = geoLine([
  [26.35, 55.30],
  [26.35, 55.60],
  [26.38, 55.90],
  [26.40, 56.15],
  [26.37, 56.40],
  [26.30, 56.65],
  [26.25, 57.10],
  [26.15, 57.80],
  [26.05, 58.50],
  [26.00, 59.00],
]);

export const LANE_WIDTH = 300;
export const SEPARATION_ZONE_WIDTH = 150;

// ---------------------------------------------------------------------------
// Hazard zones
// ---------------------------------------------------------------------------

export const SHOALS: Polygon[] = [
  geoLine([
    [26.65, 55.60], [26.60, 55.90], [26.62, 56.15],
    [26.58, 56.15], [26.55, 55.90], [26.60, 55.60],
  ]),
  geoLine([
    [26.18, 56.10], [26.25, 56.15], [26.22, 56.22],
    [26.15, 56.20], [26.12, 56.15],
  ]),
  geoLine([
    [27.05, 56.35], [27.08, 56.38], [27.10, 56.50],
    [27.05, 56.52], [27.00, 56.45], [27.00, 56.38],
  ]),
];

export const ROCKS: { position: Point; radius: number }[] = [
  { position: geo(26.42, 56.38), radius: 80 },
  { position: geo(26.48, 56.28), radius: 60 },
  { position: geo(26.55, 56.10), radius: 50 },
  { position: geo(26.35, 56.55), radius: 70 },
  { position: geo(26.60, 55.50), radius: 50 },
];

// ---------------------------------------------------------------------------
// Spawn points
// ---------------------------------------------------------------------------

export interface SpawnPoint {
  position: Point;
  heading: number;
  label: string;
}

/** US military bases */
export const US_BASES: SpawnPoint[] = [
  { position: geo(26.22, 50.60), heading: 0, label: "NSA Bahrain (5th Fleet)" },
  { position: geo(25.12, 51.32), heading: 0, label: "Al Udeid Air Base (Qatar)" },
];

/** Iranian vehicle spawns */
export const IRAN_SPAWNS: SpawnPoint[] = [
  { position: geo(27.18, 56.28), heading: Math.PI, label: "Bandar Abbas" },
  { position: geo(26.95, 55.50), heading: Math.PI * 0.5, label: "Iran Coast West" },
  { position: geo(27.05, 56.80), heading: Math.PI * 0.6, label: "Iran Coast East" },
  { position: geo(26.85, 55.80), heading: Math.PI * 0.5, label: "Qeshm West" },
  { position: geo(26.80, 56.20), heading: Math.PI * 0.5, label: "Qeshm East" },
  { position: geo(27.05, 56.45), heading: Math.PI * 0.5, label: "Hormuz Island" },
  { position: geo(26.86, 56.35), heading: Math.PI * 0.5, label: "Larak Island" },
  { position: geo(25.88, 55.02), heading: Math.PI * 0.5, label: "Abu Musa Island" },
];

/** US vehicle spawns */
export const US_SPAWNS: SpawnPoint[] = [
  { position: geo(26.15, 50.65), heading: 0, label: "Bahrain Naval Base" },
  { position: geo(25.00, 51.40), heading: 0, label: "Qatar Staging" },
  { position: geo(26.10, 58.90), heading: Math.PI, label: "Gulf of Oman Patrol" },
  { position: geo(25.50, 58.90), heading: Math.PI, label: "Gulf of Oman Support" },
];

/** Oil tanker spawns */
export const TANKER_SPAWNS: SpawnPoint[] = [
  { position: geo(26.50, 51.50), heading: 0, label: "Persian Gulf Port A" },
  { position: geo(26.00, 52.00), heading: 0, label: "Persian Gulf Port B" },
  { position: geo(25.50, 53.00), heading: 0, label: "Persian Gulf Port C" },
  { position: geo(26.10, 58.80), heading: Math.PI, label: "Gulf of Oman Arrival" },
];

/** Tanker delivery exits */
export const TANKER_EXITS: Point[] = [
  geo(26.10, 58.90),
  geo(26.40, 51.00),
];
