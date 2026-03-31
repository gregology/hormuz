/**
 * Camera projection utilities — convert between game world coordinates
 * and Three.js screen coordinates.
 *
 * The isometric camera maps game world (x_east, y_south) with optional
 * height to screen pixels using:
 *   screen_x = (wx - wy) * cos30 * zoom + screenWidth/2
 *   screen_y = (wx + wy) * sin30 * zoom - height * zoom + screenHeight/2
 *
 * Three.js axes: X = east, Y = up (height), Z = south.
 * A game point (wx, wy) at height h becomes Three.js (wx, h, wy).
 *
 * The OrthographicCamera is positioned along direction (1,1,1) with
 * up vector (-1,2,-1). The frustum half-extents are:
 *   halfW = screenWidth  / (zoom * √6)
 *   halfH = screenHeight / (zoom * √6)
 *
 * Derivation:
 *   The camera's local axes after lookAt are:
 *     right = (1/√2, 0, -1/√2)
 *     up    = (-1/√6, 2/√6, -1/√6)
 *     fwd   = (1/√3, 1/√3, 1/√3)
 *
 *   Camera-space coordinates for a world-relative displacement (dx, dy, dz):
 *     x_cam = (dx - dz) / √2
 *     y_cam = (-dx - dz) / √6 + 2·dy / √6
 *
 *   NDC with symmetric ortho frustum:
 *     ndcX = x_cam / halfW,  ndcY = y_cam / halfH
 *
 *   Screen coords:
 *     screenX = (ndcX + 1) · sw/2
 *     screenY = (1 - ndcY) · sh/2
 *
 *   Setting screenX = (dx-dz)·cos30·zoom + sw/2 and solving gives
 *   halfW = halfH = sw / (zoom · √6).
 */

import * as THREE from "three";
import type { Camera } from "./camera";

/**
 * Project a Three.js world point to screen pixels using the given
 * Three.js camera. Returns {x, y} in the same coordinate space as
 * worldToScreen() from camera.ts.
 */
export function threeToScreen(
	camera: THREE.OrthographicCamera,
	worldPoint: THREE.Vector3,
	screenWidth: number,
	screenHeight: number,
): { x: number; y: number } {
	const ndc = worldPoint.clone().project(camera);
	return {
		x: (ndc.x + 1) * screenWidth * 0.5,
		y: (1 - ndc.y) * screenHeight * 0.5,
	};
}

/**
 * Convert a game-world position (with optional height) to a Three.js
 * Vector3. Three.js axes: X = east, Y = up, Z = south.
 */
export function gameToThree(
	wx: number,
	wy: number,
	height = 0,
): THREE.Vector3 {
	return new THREE.Vector3(wx, height, wy);
}

/**
 * Verify that the Three.js camera projection matches the 2D isometric
 * worldToScreen for a given point. Returns the pixel error.
 */
export function projectionError(
	camera: THREE.OrthographicCamera,
	cam: Camera,
	wx: number,
	wy: number,
	height: number,
	worldToScreen: (cam: Camera, wx: number, wy: number) => { x: number; y: number },
): number {
	const expected = worldToScreen(cam, wx, wy);
	expected.y -= height * cam.zoom;

	const threePoint = gameToThree(wx, wy, height);
	const actual = threeToScreen(camera, threePoint, cam.screenWidth, cam.screenHeight);

	const dx = actual.x - expected.x;
	const dy = actual.y - expected.y;
	return Math.sqrt(dx * dx + dy * dy);
}
