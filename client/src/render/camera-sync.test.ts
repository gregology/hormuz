/**
 * Camera sync test — verifies that the Three.js OrthographicCamera
 * produces pixel-identical projection to the 2D worldToScreen().
 *
 * This is the #1 gate for the Three.js migration. If this test fails,
 * every rendered element will be misaligned.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createCamera, worldToScreen } from "./camera";
import { gameToThree, threeToScreen } from "./camera-sync";
import { syncCamera } from "./scene";

/** Max acceptable pixel error between 2D and 3D projection. */
const MAX_PIXEL_ERROR = 0.01;

function createTestCamera(
	worldX: number,
	worldY: number,
	zoom: number,
	sw: number,
	sh: number,
) {
	const threeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
	threeCamera.up.set(-1, 2, -1).normalize();
	syncCamera(threeCamera, worldX, worldY, zoom, sw, sh);

	const cam = createCamera(sw, sh);
	cam.worldX = worldX;
	cam.worldY = worldY;
	cam.zoom = zoom;
	return { threeCamera, cam };
}

describe("Three.js camera projection matches worldToScreen", () => {
	const screenSizes = [
		[800, 600],
		[1920, 1080],
		[1440, 900],
	];

	const zoomLevels = [0.01, 0.04, 0.1, 0.5, 1, 2, 5];

	const cameraPositions = [
		[0, 0],
		[85000, 37000],
		[75000, 43000],
		[-5000, 10000],
	];

	const testPoints = [
		[0, 0],
		[100, 0],
		[0, 100],
		[100, 100],
		[-50, 200],
		[85000, 37000],
		[75500, 43000],
		[85500, 40500],
		[0, 80000],
		[110000, 0],
		[-1000, -1000],
	];

	const heights = [0, 10, 50, 100, 500];

	it("matches for a comprehensive set of points, zooms, and camera positions", () => {
		let maxError = 0;
		let testCount = 0;

		for (const [sw, sh] of screenSizes) {
			for (const zoom of zoomLevels) {
				for (const [cx, cy] of cameraPositions) {
					const { threeCamera, cam } = createTestCamera(cx, cy, zoom, sw, sh);

					for (const [wx, wy] of testPoints) {
						for (const h of heights) {
							const expected = worldToScreen(cam, wx, wy);
							expected.y -= h * cam.zoom;

							const threePoint = gameToThree(wx, wy, h);
							const actual = threeToScreen(threeCamera, threePoint, sw, sh);

							const dx = actual.x - expected.x;
							const dy = actual.y - expected.y;
							const err = Math.sqrt(dx * dx + dy * dy);

							if (err > maxError) maxError = err;
							testCount++;

							if (err > MAX_PIXEL_ERROR) {
								expect.fail(
									`Pixel error ${err.toFixed(4)} > ${MAX_PIXEL_ERROR} at ` +
										`world=(${wx},${wy}) h=${h} cam=(${cx},${cy}) ` +
										`zoom=${zoom} screen=${sw}x${sh}\n` +
										`  expected: (${expected.x.toFixed(2)}, ${expected.y.toFixed(2)})\n` +
										`  actual:   (${actual.x.toFixed(2)}, ${actual.y.toFixed(2)})`,
								);
							}
						}
					}
				}
			}
		}

		expect(testCount).toBeGreaterThan(1000);
		expect(maxError).toBeLessThan(MAX_PIXEL_ERROR);
	});

	it("handles the exact current game camera defaults", () => {
		const { threeCamera, cam } = createTestCamera(85500, 40500, 0.04, 1920, 1080);

		// Tanker at typical position
		const expected1 = worldToScreen(cam, 75500, 43000);
		const actual1 = threeToScreen(
			threeCamera,
			gameToThree(75500, 43000),
			1920,
			1080,
		);
		expect(Math.abs(actual1.x - expected1.x)).toBeLessThan(MAX_PIXEL_ERROR);
		expect(Math.abs(actual1.y - expected1.y)).toBeLessThan(MAX_PIXEL_ERROR);

		// Shahed at altitude
		const expected2 = worldToScreen(cam, 85000, 37000);
		expected2.y -= 30 * cam.zoom;
		const actual2 = threeToScreen(
			threeCamera,
			gameToThree(85000, 37000, 30),
			1920,
			1080,
		);
		expect(Math.abs(actual2.x - expected2.x)).toBeLessThan(MAX_PIXEL_ERROR);
		expect(Math.abs(actual2.y - expected2.y)).toBeLessThan(MAX_PIXEL_ERROR);
	});
});
