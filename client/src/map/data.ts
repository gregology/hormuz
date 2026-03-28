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
// Traffic Separation Scheme (TSS) — IMO shipping lanes through the strait
// ---------------------------------------------------------------------------

/**
 * TSS Inbound lane — tankers entering the Gulf. Northern lane (~2nm wide).
 *
 * Ships approach from the SE (Gulf of Oman), curve NW between the Iranian
 * islands (Qeshm/Larak to the north) and Musandam Peninsula (to the south),
 * then exit into the Persian Gulf.
 *
 * Key constraints at the narrows (~56.2°E):
 *   - Qeshm south coast: ~26.65°N (north boundary)
 *   - Musandam coast: ~26.35°N (south boundary)
 *   - Lanes centered ~26.48-26.55°N
 */
export const LANE_INBOUND: Polyline = geoLine([
  [25.20, 58.50], // Gulf of Oman (S of Iran Makran coast at ~25.58°N)
  [25.30, 58.00], // heading NW (S of Iran coast at ~25.65°N)
  [25.50, 57.50], // (S of Iran coast at ~25.75°N)
  [25.80, 57.00], // approaching strait (S of Iran coast at ~26.00°N)
  [26.30, 56.80], // entering strait (between Iran ~26.45 and Musandam ~26.10)
  [26.48, 56.50], // gap between Musandam and islands
  [26.55, 56.20], // through narrows (S of Qeshm 26.65, N of Musandam 26.35)
  [26.57, 55.90], // past Hengam
  [26.55, 55.60], // exiting into Gulf
  [26.50, 55.00], // Persian Gulf
]);

/**
 * TSS Outbound lane — tankers leaving the Gulf. Southern lane (~2nm wide).
 * Curves SE around Iran's Makran coast to exit into the Gulf of Oman.
 */
export const LANE_OUTBOUND: Polyline = geoLine([
  [26.45, 55.00], // from Persian Gulf
  [26.50, 55.60], // heading east
  [26.52, 55.90], // approaching narrows
  [26.48, 56.20], // through narrows (just south of inbound)
  [26.40, 56.50], // past Musandam tip
  [26.20, 56.80], // heading SE (between Iran ~26.45 and Musandam ~26.10)
  [25.60, 57.00], // leaving strait (S of Iran coast at ~26.00°N)
  [25.30, 57.50], // heading SE (S of Iran coast at ~25.75°N)
  [25.10, 58.00], // (S of Iran coast at ~25.65°N)
  [25.00, 58.50], // Gulf of Oman
]);

/** Lane width: ~2 nautical miles each ≈ 3.7km ≈ 400 game units */
export const LANE_WIDTH = 400;
export const SEPARATION_ZONE_WIDTH = 200;

// ---------------------------------------------------------------------------
// Deep-water route through the Persian Gulf (tanker fairway)
// ---------------------------------------------------------------------------

/**
 * Main deep-water route used by VLCCs. The deep channel runs along the
 * Iranian (northern) side of the Gulf. Route stays ~20-30km south of
 * the Iran coast in the deepest water.
 */
export const DEEP_WATER_ROUTE: Polyline = geoLine([
  [26.40, 55.00], // connects to TSS western end (S of Iran coast at ~26.50°N)
  [26.35, 54.50], // deep channel
  [26.65, 54.00], // mid-Gulf (Iran coast ~26.95°N, gap 0.30°)
  [26.60, 53.40], // mid-Gulf (Iran coast ~26.85°N, gap 0.25°)
  [26.50, 52.80], // (Iran coast ~26.70°N, gap 0.20°)
  [26.35, 52.20], // (Iran coast ~26.60°N, gap 0.25°)
  [26.30, 51.60], // east of Bahrain (Iran coast ~26.55°N, gap 0.25°)
  [26.50, 51.00], // abeam Bahrain
  [26.60, 50.30], // approach to Ras Tanura / Saudi ports
]);

// ---------------------------------------------------------------------------
// Depth zones — shallow water areas rendered as lighter blue
// ---------------------------------------------------------------------------

/**
 * Very shallow water (<10m). Dangerous for most vessels.
 * Rendered as the lightest water color.
 */
export const VERY_SHALLOW: Polygon[] = [
  // Khuran Strait (between Qeshm north coast and Iran) — narrow, shallow
  geoLine([
    [26.98, 55.30], [26.98, 56.10], [26.92, 56.15],
    [26.88, 56.15], [26.88, 55.90], [26.90, 55.60],
    [26.90, 55.30],
  ]),
  // Between Hormuz Island and Iran coast
  geoLine([
    [27.10, 56.25], [27.10, 56.55], [27.02, 56.55],
    [27.00, 56.40], [27.02, 56.25],
  ]),
  // Shallow shelf south of Qeshm (1-5nm)
  geoLine([
    [26.68, 55.40], [26.68, 55.70], [26.65, 55.95],
    [26.62, 56.10], [26.58, 56.17],
    [26.55, 56.17], [26.58, 55.95], [26.62, 55.70],
    [26.65, 55.40],
  ]),
  // Reefs around Larak Island
  geoLine([
    [26.90, 56.17], [26.90, 56.28], [26.85, 56.30],
    [26.82, 56.25], [26.82, 56.17], [26.85, 56.15],
  ]),
  // Head of the Gulf (NW, near Kuwait/Iraq — very shallow)
  geoLine([
    [29.70, 48.20], [29.70, 48.80], [29.50, 49.00],
    [29.20, 48.80], [29.20, 48.40], [29.40, 48.20],
  ]),
  // Around Bahrain archipelago
  geoLine([
    [26.35, 50.30], [26.35, 50.75], [26.05, 50.80],
    [25.80, 50.70], [25.80, 50.35], [26.05, 50.25],
  ]),
];

/**
 * Shallow water (10-30m). The broad southern continental shelf.
 * Most of the Arabian side of the Gulf is this depth.
 */
export const SHALLOW_WATER: Polygon[] = [
  // Great Pearl Bank and southern Gulf shelf — huge shallow area
  // Extends from Qatar to UAE, 50-100nm offshore
  geoLine([
    [25.80, 51.50], [25.60, 52.00], [25.40, 52.50],
    [25.20, 53.00], [25.00, 53.50], [24.80, 54.00],
    [24.70, 54.50], [24.80, 55.00], [25.10, 55.30],
    [25.50, 55.50], [25.80, 55.70],
    // Northern boundary (where it gets deeper toward Iran)
    [26.10, 55.50], [26.10, 55.00], [26.00, 54.50],
    [25.90, 54.00], [25.80, 53.50], [25.80, 53.00],
    [25.90, 52.50], [26.00, 52.00], [26.00, 51.50],
  ]),
  // Shallow area around Qatar
  geoLine([
    [26.20, 51.00], [26.20, 51.70], [25.60, 51.80],
    [25.20, 51.70], [24.80, 51.50], [24.80, 51.20],
    [25.10, 51.00], [25.50, 50.90], [25.90, 50.90],
  ]),
  // Shallow shelf between Hengam and Qeshm
  geoLine([
    [26.42, 55.80], [26.42, 56.00], [26.38, 56.05],
    [26.35, 56.00], [26.35, 55.80], [26.38, 55.75],
  ]),
  // NW Gulf shelf (Kuwait/Saudi)
  geoLine([
    [28.50, 48.50], [28.50, 49.50], [28.00, 50.00],
    [27.50, 50.20], [27.20, 50.10], [27.00, 49.80],
    [27.50, 49.00], [28.00, 48.50],
  ]),
];

// ---------------------------------------------------------------------------
// Hazards — rocks, reefs, and navigational dangers
// ---------------------------------------------------------------------------

/** Shoal patches and reef areas (rendered as marked hazard zones) */
export const SHOALS: Polygon[] = [
  // Quoin Islands / Didamar — rocky islets at southern edge of outbound lane
  geoLine([
    [26.18, 56.14], [26.18, 56.20], [26.14, 56.20],
    [26.14, 56.14],
  ]),
  // Shallow coral reef south of Larak
  geoLine([
    [26.82, 56.18], [26.82, 56.25], [26.78, 56.25],
    [26.78, 56.18],
  ]),
  // Shoals NE of Musandam
  geoLine([
    [26.28, 56.18], [26.28, 56.25], [26.24, 56.25],
    [26.24, 56.18],
  ]),
  // Shallow patch south of Qeshm eastern tip
  geoLine([
    [26.37, 56.12], [26.37, 56.18], [26.33, 56.18],
    [26.33, 56.12],
  ]),
  // Reefs around Abu Musa
  geoLine([
    [25.95, 54.95], [25.95, 55.08], [25.85, 55.08],
    [25.82, 55.00], [25.85, 54.92], [25.92, 54.92],
  ]),
  // Reefs around Greater Tunb
  geoLine([
    [26.19, 55.13], [26.19, 55.22], [26.13, 55.22],
    [26.13, 55.13],
  ]),
  // Reefs around Lesser Tunb
  geoLine([
    [26.17, 55.05], [26.17, 55.12], [26.11, 55.12],
    [26.11, 55.05],
  ]),
];

/** Point hazards — rocks, wrecks, charted dangers */
export const ROCKS: { position: Point; radius: number; label?: string }[] = [
  // Quoin Islands rocks (awash/drying)
  { position: geo(26.16, 56.17), radius: 100, label: "Quoin Is." },
  { position: geo(26.15, 56.19), radius: 60 },
  // Rocks near Musandam tip
  { position: geo(26.26, 56.22), radius: 80, label: "Musandam reef" },
  // Submerged reef between Hengam and Qeshm
  { position: geo(26.39, 55.90), radius: 70 },
  // Coral heads south of Larak
  { position: geo(26.80, 56.22), radius: 60 },
  { position: geo(26.79, 56.19), radius: 50 },
  // Forur Island reefs (on tanker route)
  { position: geo(26.12, 54.35), radius: 80, label: "Forur reef" },
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
