/**
 * Renders the Strait of Hormuz map using PixiJS.
 *
 * The map is drawn into a Container with four layers:
 *   1. waterMesh (Mesh) — animated water surface via custom fragment shader
 *   2. landGfx (Graphics) — coastline polygon fills (precise Natural Earth boundaries)
 *   3. terrainMesh (Mesh) — terrain coloring + hillshade via custom fragment shader
 *   4. overlayGfx (Graphics) — borders, hazards, lanes, grid, bases, spawns
 *
 * Both Mesh objects use the same isometric projection (skew + scale + position)
 * as the rest of the map. The water shader animates procedurally; the terrain
 * shader samples the heightmap texture for elevation-based biome coloring and
 * real-time hillshade lighting.
 */

import {
	type Container,
	Graphics,
	Mesh,
	MeshGeometry,
	Shader,
	Texture,
	UniformGroup,
} from "pixi.js";
import { ARABIAN_COAST_POLYS, IRAN_COAST_POLYS } from "../map/coastlines";
import {
	DEEP_WATER_ROUTE,
	IRAN_SPAWNS,
	ISLAND_POLYGONS,
	LANE_INBOUND,
	LANE_OUTBOUND,
	MAP,
	type Polygon,
	type Polyline,
	ROCKS,
	SHALLOW_WATER,
	SHOALS,
	TANKER_SPAWNS,
	US_BASES,
	US_SPAWNS,
	VERY_SHALLOW,
} from "../map/data";
import {
	HEIGHTMAP_CELL_SIZE,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_WIDTH,
	createHeightmapPixels,
} from "../map/heightmap";
import { HEIGHTMAP_MAX_ELEVATION } from "../map/heightmap-data";
import { type Camera, worldToScreen } from "./camera";
import { COLORS } from "./colors";

import mapVert from "./shaders/map.vert?raw";
import terrainFrag from "./shaders/terrain.frag?raw";
import waterFrag from "./shaders/water.frag?raw";

export interface MapLayers {
	showDepthZones: boolean;
	showShippingLanes: boolean;
	showHazards: boolean;
	showSpawnPoints: boolean;
	showTerrain: boolean;
	showGrid: boolean;
	gridSize: number;
}

export const DEFAULT_LAYERS: MapLayers = {
	showDepthZones: true,
	showShippingLanes: true,
	showHazards: true,
	showSpawnPoints: true,
	showTerrain: true,
	showGrid: false,
	gridSize: 1000,
};

// ---------------------------------------------------------------------------
// Internal state — lazily initialized on first renderMap call
// ---------------------------------------------------------------------------

interface MapState {
	waterMesh: Mesh<MeshGeometry, Shader>;
	waterUniforms: UniformGroup;
	landGfx: Graphics;
	coastlineMask: Graphics;
	terrainMesh: Mesh<MeshGeometry, Shader>;
	overlayGfx: Graphics;
}

let state: MapState | null = null;

// ---------------------------------------------------------------------------
// Mesh creation helpers
// ---------------------------------------------------------------------------

/** Quad geometry covering the heightmap grid (positions in grid-pixel space). */
function createMapQuadGeometry(): MeshGeometry {
	const w = HEIGHTMAP_WIDTH;
	const h = HEIGHTMAP_HEIGHT;
	return new MeshGeometry({
		positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
		uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
		indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
	});
}

function createWaterMesh(): {
	mesh: Mesh<MeshGeometry, Shader>;
	uniforms: UniformGroup;
} {
	const geometry = createMapQuadGeometry();
	const uniforms = new UniformGroup({
		uTime: { value: 0, type: "f32" },
		uZoom: { value: 1, type: "f32" },
	});

	const shader = Shader.from({
		gl: { vertex: mapVert, fragment: waterFrag, name: "water-shader" },
		resources: {
			waterUniforms: uniforms,
		},
	});

	const mesh = new Mesh({ geometry, shader });
	return { mesh, uniforms };
}

function createTerrainMesh(): Mesh<MeshGeometry, Shader> {
	const geometry = createMapQuadGeometry();

	// Encode heightmap as RGBA texture (elevation in RG channels)
	const { data, width, height } = createHeightmapPixels();
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	// biome-ignore lint/style/noNonNullAssertion: canvas 2d context is always available
	const ctx = canvas.getContext("2d")!;
	const imageData = ctx.createImageData(width, height);
	imageData.data.set(data);
	ctx.putImageData(imageData, 0, 0);

	const heightmapTexture = Texture.from(canvas);
	heightmapTexture.source.scaleMode = "linear";

	const terrainUniforms = new UniformGroup({
		uGradientScale: { value: 3.0, type: "f32" },
		uMaxElevation: { value: HEIGHTMAP_MAX_ELEVATION, type: "f32" },
	});

	const shader = Shader.from({
		gl: { vertex: mapVert, fragment: terrainFrag, name: "terrain-shader" },
		resources: {
			terrainUniforms,
			uTexture: heightmapTexture.source,
			uTextureSampler: heightmapTexture.source.style,
		},
	});

	const mesh = new Mesh({ geometry, shader });
	return mesh;
}

/** Apply isometric transform to a Mesh (same math as the old hillshade sprite). */
function updateMeshTransform(mesh: Mesh<MeshGeometry, Shader>, cam: Camera) {
	const k = HEIGHTMAP_CELL_SIZE * cam.zoom;
	mesh.skew.set(-Math.PI / 3, Math.PI / 6);
	mesh.scale.set(k, k);
	const origin = worldToScreen(cam, 0, 0);
	mesh.position.set(origin.x, origin.y);
}

// ---------------------------------------------------------------------------
// Polygon drawing helpers
// ---------------------------------------------------------------------------

function drawFilledPolygon(
	g: Graphics,
	cam: Camera,
	poly: Polygon,
	fillColor: number,
	fillAlpha = 1,
) {
	if (poly.length < 3) return;
	const first = worldToScreen(cam, poly[0][0], poly[0][1]);
	g.moveTo(first.x, first.y);
	for (let i = 1; i < poly.length; i++) {
		const p = worldToScreen(cam, poly[i][0], poly[i][1]);
		g.lineTo(p.x, p.y);
	}
	g.closePath();
	g.fill({ color: fillColor, alpha: fillAlpha });
}

function drawPolygonBorder(
	g: Graphics,
	cam: Camera,
	poly: Polygon,
	strokeColor: number,
	strokeWidth = 1,
) {
	if (poly.length < 3) return;
	const first = worldToScreen(cam, poly[0][0], poly[0][1]);
	g.moveTo(first.x, first.y);
	for (let i = 1; i < poly.length; i++) {
		const p = worldToScreen(cam, poly[i][0], poly[i][1]);
		g.lineTo(p.x, p.y);
	}
	g.closePath();
	g.stroke({ color: strokeColor, width: strokeWidth });
}

function drawDashedPolyline(
	g: Graphics,
	cam: Camera,
	line: Polyline,
	color: number,
	lineWidth: number,
	dashLength = 20,
	gapLength = 15,
) {
	for (let i = 0; i < line.length - 1; i++) {
		const a = worldToScreen(cam, line[i][0], line[i][1]);
		const b = worldToScreen(cam, line[i + 1][0], line[i + 1][1]);

		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len === 0) continue;
		const nx = dx / len;
		const ny = dy / len;

		let dist = 0;
		let drawing = true;
		while (dist < len) {
			const segLen = drawing ? dashLength : gapLength;
			const end = Math.min(dist + segLen, len);
			if (drawing) {
				g.moveTo(a.x + nx * dist, a.y + ny * dist);
				g.lineTo(a.x + nx * end, a.y + ny * end);
			}
			dist = end;
			drawing = !drawing;
		}
	}
	g.stroke({ color, width: lineWidth, alpha: 0.6 });
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Draw the full map into the given Container.
 * Call this each frame when the camera changes.
 *
 * On first call, creates internal children (Meshes + Graphics).
 * Subsequent calls reuse them (clear + redraw Graphics, update Mesh transforms).
 *
 * @param time — elapsed time in seconds, used for water animation
 */
export function renderMap(
	container: Container,
	cam: Camera,
	layers: MapLayers = DEFAULT_LAYERS,
	time = 0,
) {
	// Lazy init: create children on first call
	if (!state) {
		const water = createWaterMesh();
		const landGfx = new Graphics();
		const coastlineMask = new Graphics();
		const terrainMesh = createTerrainMesh();
		const overlayGfx = new Graphics();

		// Mask terrain to precise coastline boundaries
		terrainMesh.mask = coastlineMask;

		container.addChild(water.mesh);
		container.addChild(landGfx);
		container.addChild(coastlineMask);
		container.addChild(terrainMesh);
		container.addChild(overlayGfx);

		state = {
			waterMesh: water.mesh,
			waterUniforms: water.uniforms,
			landGfx,
			coastlineMask,
			terrainMesh,
			overlayGfx,
		};
	}

	const {
		waterMesh,
		waterUniforms,
		landGfx,
		coastlineMask,
		terrainMesh,
		overlayGfx,
	} = state;

	// --- Water mesh: animated water surface ---
	waterUniforms.uniforms.uTime = time;
	waterUniforms.uniforms.uZoom = cam.zoom;
	updateMeshTransform(waterMesh, cam);

	// --- Land fills: precise coastline polygons ---
	landGfx.clear();

	// Depth zones (drawn on top of water, under land)
	if (layers.showDepthZones) {
		for (const zone of SHALLOW_WATER) {
			drawFilledPolygon(landGfx, cam, zone, COLORS.shallowWater, 0.4);
		}
		for (const zone of VERY_SHALLOW) {
			drawFilledPolygon(landGfx, cam, zone, COLORS.veryShallowWater, 0.5);
		}
	}

	// Land fills
	for (const poly of IRAN_COAST_POLYS) {
		drawFilledPolygon(landGfx, cam, poly, COLORS.land);
	}
	for (const poly of ARABIAN_COAST_POLYS) {
		drawFilledPolygon(landGfx, cam, poly, COLORS.land);
	}

	// Island fills
	for (const island of ISLAND_POLYGONS) {
		drawFilledPolygon(landGfx, cam, island.polygon, COLORS.island);
	}

	// --- Coastline mask: clips terrain to precise Natural Earth boundaries ---
	coastlineMask.clear();
	for (const poly of IRAN_COAST_POLYS) {
		drawFilledPolygon(coastlineMask, cam, poly, 0xffffff);
	}
	for (const poly of ARABIAN_COAST_POLYS) {
		drawFilledPolygon(coastlineMask, cam, poly, 0xffffff);
	}
	for (const island of ISLAND_POLYGONS) {
		drawFilledPolygon(coastlineMask, cam, island.polygon, 0xffffff);
	}

	// --- Terrain mesh: elevation coloring + hillshade ---
	terrainMesh.visible = layers.showTerrain;
	if (layers.showTerrain) {
		updateMeshTransform(terrainMesh, cam);
	}

	// --- Overlay layer: borders, hazards, lanes, grid, bases, spawns ---
	overlayGfx.clear();
	const g = overlayGfx;

	// Land borders
	for (const poly of IRAN_COAST_POLYS) {
		drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
	}
	for (const poly of ARABIAN_COAST_POLYS) {
		drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
	}
	for (const island of ISLAND_POLYGONS) {
		drawPolygonBorder(g, cam, island.polygon, COLORS.islandBorder, 2);
	}

	// Hazards
	if (layers.showHazards) {
		for (const shoal of SHOALS) {
			drawFilledPolygon(g, cam, shoal, COLORS.shoal, 0.6);
			drawPolygonBorder(g, cam, shoal, COLORS.shoalBorder, 1);
		}
		for (const rock of ROCKS) {
			const p = worldToScreen(cam, rock.position[0], rock.position[1]);
			const r = rock.radius * cam.zoom;
			g.circle(p.x, p.y, r);
			g.fill({ color: COLORS.rock, alpha: 0.8 });
			g.circle(p.x, p.y, r * 1.5);
			g.stroke({ color: COLORS.shoalBorder, width: 1, alpha: 0.4 });
		}
	}

	// Shipping lanes
	if (layers.showShippingLanes) {
		drawDashedPolyline(
			g,
			cam,
			DEEP_WATER_ROUTE,
			COLORS.deepWaterRoute,
			1.5,
			30,
			20,
		);
		drawDashedPolyline(g, cam, LANE_INBOUND, COLORS.laneInbound, 2);
		drawDashedPolyline(g, cam, LANE_OUTBOUND, COLORS.laneOutbound, 2);
	}

	// Grid
	if (layers.showGrid) {
		const gs = layers.gridSize;
		for (let wx = 0; wx <= MAP.width; wx += gs) {
			const top = worldToScreen(cam, wx, 0);
			const bot = worldToScreen(cam, wx, MAP.height);
			g.moveTo(top.x, top.y);
			g.lineTo(bot.x, bot.y);
		}
		for (let wy = 0; wy <= MAP.height; wy += gs) {
			const left = worldToScreen(cam, 0, wy);
			const right = worldToScreen(cam, MAP.width, wy);
			g.moveTo(left.x, left.y);
			g.lineTo(right.x, right.y);
		}
		g.stroke({ color: COLORS.grid, width: 1, alpha: 0.3 });
	}

	// US bases
	for (const base of US_BASES) {
		const p = worldToScreen(cam, base.position[0], base.position[1]);
		const bs = 12;
		g.rect(p.x - bs, p.y - bs, bs * 2, bs * 2);
		g.fill({ color: COLORS.spawnUS, alpha: 0.5 });
		g.rect(p.x - bs, p.y - bs, bs * 2, bs * 2);
		g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
		g.circle(p.x, p.y, 4);
		g.fill({ color: 0xffffff, alpha: 0.8 });
	}

	// Spawn points
	if (layers.showSpawnPoints) {
		const markerSize = 8;
		for (const sp of IRAN_SPAWNS) {
			const p = worldToScreen(cam, sp.position[0], sp.position[1]);
			g.circle(p.x, p.y, markerSize);
			g.fill({ color: COLORS.spawnIran, alpha: 0.7 });
		}
		for (const sp of US_SPAWNS) {
			const p = worldToScreen(cam, sp.position[0], sp.position[1]);
			g.rect(
				p.x - markerSize,
				p.y - markerSize,
				markerSize * 2,
				markerSize * 2,
			);
			g.fill({ color: COLORS.spawnUS, alpha: 0.7 });
		}
		for (const sp of TANKER_SPAWNS) {
			const top = worldToScreen(cam, sp.position[0], sp.position[1] - 60);
			const right = worldToScreen(cam, sp.position[0] + 60, sp.position[1]);
			const bottom = worldToScreen(cam, sp.position[0], sp.position[1] + 60);
			const left = worldToScreen(cam, sp.position[0] - 60, sp.position[1]);
			g.moveTo(top.x, top.y);
			g.lineTo(right.x, right.y);
			g.lineTo(bottom.x, bottom.y);
			g.lineTo(left.x, left.y);
			g.closePath();
			g.fill({ color: COLORS.spawnTanker, alpha: 0.7 });
		}
	}
}
