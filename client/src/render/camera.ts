/**
 * Isometric camera with pan and zoom.
 *
 * World coordinates are 2D (x east, y south).
 * Isometric projection: screen_x = (wx - wy) * cos30, screen_y = (wx + wy) * sin30
 * Standard 2:1 isometric ratio.
 */

export const ISO_COS = Math.sqrt(3) / 2; // cos(30°) ≈ 0.866
export const ISO_SIN = 0.5; // sin(30°)

export interface Camera {
  /** World-space center of the viewport */
  worldX: number;
  worldY: number;
  /** Zoom level (1 = default, >1 = zoomed in) */
  zoom: number;
  /** Screen dimensions */
  screenWidth: number;
  screenHeight: number;
}

export function createCamera(
  screenWidth: number,
  screenHeight: number,
): Camera {
  return {
    worldX: 0,
    worldY: 0,
    zoom: 1,
    screenWidth,
    screenHeight,
  };
}

/** Convert world (x, y) to screen (px, py) given camera state. */
export function worldToScreen(
  cam: Camera,
  wx: number,
  wy: number,
): { x: number; y: number } {
  // Isometric projection
  const isoX = (wx - wy) * ISO_COS;
  const isoY = (wx + wy) * ISO_SIN;

  // Camera-relative isometric center
  const camIsoX = (cam.worldX - cam.worldY) * ISO_COS;
  const camIsoY = (cam.worldX + cam.worldY) * ISO_SIN;

  // Screen position: offset from camera center, scaled by zoom, centered on screen
  const x = (isoX - camIsoX) * cam.zoom + cam.screenWidth / 2;
  const y = (isoY - camIsoY) * cam.zoom + cam.screenHeight / 2;

  return { x, y };
}

/** Convert screen (px, py) to world (x, y) given camera state. */
export function screenToWorld(
  cam: Camera,
  sx: number,
  sy: number,
): { x: number; y: number } {
  // Reverse the screen transform
  const camIsoX = (cam.worldX - cam.worldY) * ISO_COS;
  const camIsoY = (cam.worldX + cam.worldY) * ISO_SIN;

  const isoX = (sx - cam.screenWidth / 2) / cam.zoom + camIsoX;
  const isoY = (sy - cam.screenHeight / 2) / cam.zoom + camIsoY;

  // Reverse isometric projection
  const wx = isoX / (2 * ISO_COS) + isoY / (2 * ISO_SIN);
  const wy = -isoX / (2 * ISO_COS) + isoY / (2 * ISO_SIN);

  return { x: wx, y: wy };
}
