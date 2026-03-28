/**
 * Renders the Strait of Hormuz map using PixiJS Graphics.
 *
 * All geometry is defined in world coordinates and projected through
 * the isometric camera transform. The renderer draws:
 *   1. Water background
 *   2. Land masses (Iran, southern coast)
 *   3. Islands
 *   4. Shoals and rocks
 *   5. Shipping lanes
 *   6. Spawn points (togglable)
 */

import { Graphics } from "pixi.js";
import { type Camera, worldToScreen } from "./camera";
import { COLORS } from "./colors";
import {
  type Polygon,
  type Polyline,
  MAP,
  ISLAND_POLYGONS,
  SHOALS,
  ROCKS,
  LANE_INBOUND,
  LANE_OUTBOUND,
  IRAN_SPAWNS,
  US_SPAWNS,
  US_BASES,
  TANKER_SPAWNS,
} from "../map/data";
import {
  IRAN_COAST_POLYS,
  ARABIAN_COAST_POLYS,
} from "../map/coastlines";

export interface MapLayers {
  showShippingLanes: boolean;
  showHazards: boolean;
  showSpawnPoints: boolean;
  showGrid: boolean;
  gridSize: number;
}

export const DEFAULT_LAYERS: MapLayers = {
  showShippingLanes: true,
  showHazards: true,
  showSpawnPoints: true,
  showGrid: false,
  gridSize: 1000,
};

/**
 * Project a world-space polygon to screen coordinates and draw it filled.
 */
function drawFilledPolygon(
  g: Graphics,
  cam: Camera,
  poly: Polygon,
  fillColor: number,
  fillAlpha: number = 1,
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

/**
 * Project a world-space polygon to screen and draw its border.
 */
function drawPolygonBorder(
  g: Graphics,
  cam: Camera,
  poly: Polygon,
  strokeColor: number,
  strokeWidth: number = 1,
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

/**
 * Draw a dashed polyline in screen space (for shipping lanes).
 */
function drawDashedPolyline(
  g: Graphics,
  cam: Camera,
  line: Polyline,
  color: number,
  lineWidth: number,
  dashLength: number = 20,
  gapLength: number = 15,
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

/**
 * Draw the full map into the given Graphics object.
 * Call this each frame (Graphics is cleared and redrawn).
 */
export function renderMap(
  g: Graphics,
  cam: Camera,
  layers: MapLayers = DEFAULT_LAYERS,
) {
  g.clear();

  // 1. Water background — fill entire visible area
  const tl = worldToScreen(cam, 0, 0);
  const tr = worldToScreen(cam, MAP.width, 0);
  const br = worldToScreen(cam, MAP.width, MAP.height);
  const bl = worldToScreen(cam, 0, MAP.height);
  // Extend slightly beyond map bounds for safety
  const pad = 200;
  g.moveTo(tl.x - pad, tl.y - pad);
  g.lineTo(tr.x + pad, tr.y - pad);
  g.lineTo(br.x + pad, br.y + pad);
  g.lineTo(bl.x - pad, bl.y + pad);
  g.closePath();
  g.fill({ color: COLORS.water });

  // 2. Land masses
  for (const poly of IRAN_COAST_POLYS) {
    drawFilledPolygon(g, cam, poly, COLORS.land);
    drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
  }
  for (const poly of ARABIAN_COAST_POLYS) {
    drawFilledPolygon(g, cam, poly, COLORS.land);
    drawPolygonBorder(g, cam, poly, COLORS.landBorder, 2);
  }

  // 3. Islands
  for (const island of ISLAND_POLYGONS) {
    drawFilledPolygon(g, cam, island.polygon, COLORS.island);
    drawPolygonBorder(g, cam, island.polygon, COLORS.islandBorder, 2);
  }

  // 4. Hazards
  if (layers.showHazards) {
    // Shoals
    for (const shoal of SHOALS) {
      drawFilledPolygon(g, cam, shoal, COLORS.shoal, 0.5);
    }

    // Rocks
    for (const rock of ROCKS) {
      const p = worldToScreen(cam, rock.position[0], rock.position[1]);
      const r = rock.radius * cam.zoom;
      g.circle(p.x, p.y, r);
      g.fill({ color: COLORS.rock, alpha: 0.8 });
    }
  }

  // 5. Shipping lanes
  if (layers.showShippingLanes) {
    drawDashedPolyline(g, cam, LANE_INBOUND, COLORS.laneInbound, 2);
    drawDashedPolyline(g, cam, LANE_OUTBOUND, COLORS.laneOutbound, 2);
  }

  // 6. Grid (debug)
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

  // 7. US bases (always visible)
  for (const base of US_BASES) {
    const p = worldToScreen(cam, base.position[0], base.position[1]);
    const bs = 12;
    g.rect(p.x - bs, p.y - bs, bs * 2, bs * 2);
    g.fill({ color: COLORS.spawnUS, alpha: 0.5 });
    g.rect(p.x - bs, p.y - bs, bs * 2, bs * 2);
    g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.6 });
    // Star marker
    g.circle(p.x, p.y, 4);
    g.fill({ color: 0xffffff, alpha: 0.8 });
  }

  // 8. Spawn points
  if (layers.showSpawnPoints) {
    const markerSize = 8;
    for (const sp of IRAN_SPAWNS) {
      const p = worldToScreen(cam, sp.position[0], sp.position[1]);
      g.circle(p.x, p.y, markerSize);
      g.fill({ color: COLORS.spawnIran, alpha: 0.7 });
    }
    for (const sp of US_SPAWNS) {
      const p = worldToScreen(cam, sp.position[0], sp.position[1]);
      g.rect(p.x - markerSize, p.y - markerSize, markerSize * 2, markerSize * 2);
      g.fill({ color: COLORS.spawnUS, alpha: 0.7 });
    }
    for (const sp of TANKER_SPAWNS) {
      // Diamond shape for tanker spawns
      g.moveTo(
        worldToScreen(cam, sp.position[0], sp.position[1] - 60).x,
        worldToScreen(cam, sp.position[0], sp.position[1] - 60).y,
      );
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
