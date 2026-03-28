/**
 * Renders the Strait of Hormuz map using PixiJS.
 *
 * The map is drawn into a Container with three layers:
 *   1. baseGfx (Graphics) — water, depth zones, land fills, island fills
 *   2. hillshadeSprite (Sprite) — GPU-interpolated terrain shading texture
 *   3. overlayGfx (Graphics) — borders, hazards, lanes, grid, bases, spawns
 *
 * The hillshade is rendered as a texture sprite with bilinear filtering,
 * projected into isometric space via skew transform. This gives smooth,
 * pixel-perfect terrain shading in a single draw call.
 */

import { type Container, Graphics, Sprite, Texture } from "pixi.js";
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
import { HEIGHTMAP_CELL_SIZE, createHillshadePixels } from "../map/heightmap";
import { type Camera, worldToScreen } from "./camera";
import { COLORS } from "./colors";

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

let baseGfx: Graphics | null = null;
let overlayGfx: Graphics | null = null;
let hillshadeSprite: Sprite | null = null;

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
// Hillshade sprite setup
// ---------------------------------------------------------------------------

function createHillshadeSprite(): Sprite {
	const { data, width, height } = createHillshadePixels();

	// Paint RGBA data onto a canvas, then create a PixiJS texture
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d")!;
	const imageData = ctx.createImageData(width, height);
	imageData.data.set(data);
	ctx.putImageData(imageData, 0, 0);

	const texture = Texture.from(canvas);
	// Bilinear filtering — the GPU smoothly interpolates between pixels
	texture.source.scaleMode = "linear";

	return new Sprite(texture);
}

function updateHillshadeTransform(sprite: Sprite, cam: Camera) {
	const k = HEIGHTMAP_CELL_SIZE * cam.zoom;

	// Isometric projection via skew: maps pixel (col, row) in the texture
	// to the correct isometric screen position for world (col*CS, row*CS).
	// Decomposition: rotation=0, skew=(-60°, 30°), scale=(k, k)
	sprite.skew.set(-Math.PI / 3, Math.PI / 6);
	sprite.scale.set(k, k);

	// Position: screen position of world origin (0, 0)
	const origin = worldToScreen(cam, 0, 0);
	sprite.position.set(origin.x, origin.y);
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Draw the full map into the given Container.
 * Call this each frame when the camera changes.
 *
 * On first call, creates internal Graphics + Sprite children.
 * Subsequent calls reuse them (clear + redraw).
 */
export function renderMap(
	container: Container,
	cam: Camera,
	layers: MapLayers = DEFAULT_LAYERS,
) {
	// Lazy init: create children on first call
	if (!baseGfx) {
		baseGfx = new Graphics();
		hillshadeSprite = createHillshadeSprite();
		overlayGfx = new Graphics();
		container.addChild(baseGfx);
		container.addChild(hillshadeSprite);
		container.addChild(overlayGfx);
	}

	// --- Base layer: water, depth zones, land fills, island fills ---
	baseGfx.clear();

	// 1. Water background
	const tl = worldToScreen(cam, 0, 0);
	const tr = worldToScreen(cam, MAP.width, 0);
	const br = worldToScreen(cam, MAP.width, MAP.height);
	const bl = worldToScreen(cam, 0, MAP.height);
	const pad = 200;
	baseGfx.moveTo(tl.x - pad, tl.y - pad);
	baseGfx.lineTo(tr.x + pad, tr.y - pad);
	baseGfx.lineTo(br.x + pad, br.y + pad);
	baseGfx.lineTo(bl.x - pad, bl.y + pad);
	baseGfx.closePath();
	baseGfx.fill({ color: COLORS.water });

	// 2. Depth zones
	if (layers.showDepthZones) {
		for (const zone of SHALLOW_WATER) {
			drawFilledPolygon(baseGfx, cam, zone, COLORS.shallowWater, 0.4);
		}
		for (const zone of VERY_SHALLOW) {
			drawFilledPolygon(baseGfx, cam, zone, COLORS.veryShallowWater, 0.5);
		}
	}

	// 3. Land fills
	for (const poly of IRAN_COAST_POLYS) {
		drawFilledPolygon(baseGfx, cam, poly, COLORS.land);
	}
	for (const poly of ARABIAN_COAST_POLYS) {
		drawFilledPolygon(baseGfx, cam, poly, COLORS.land);
	}

	// 4. Island fills
	for (const island of ISLAND_POLYGONS) {
		drawFilledPolygon(baseGfx, cam, island.polygon, COLORS.island);
	}

	// --- Hillshade sprite (between fills and borders) ---
	hillshadeSprite!.visible = layers.showTerrain;
	if (layers.showTerrain) {
		updateHillshadeTransform(hillshadeSprite!, cam);
	}

	// --- Overlay layer: borders, hazards, lanes, grid, bases, spawns ---
	overlayGfx!.clear();
	const g = overlayGfx!;

	// 5. Land borders
	for (const poly of IRAN_COAST_POLYS) {
		drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
	}
	for (const poly of ARABIAN_COAST_POLYS) {
		drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
	}
	for (const island of ISLAND_POLYGONS) {
		drawPolygonBorder(g, cam, island.polygon, COLORS.islandBorder, 2);
	}

	// 6. Hazards
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

	// 7. Shipping lanes
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

	// 8. Grid
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

	// 9. US bases
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

	// 10. Spawn points
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
