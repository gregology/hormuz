import { describe, expect } from "vitest";
import { fc, it, test } from "@fast-check/vitest";
import {
	ISO_COS,
	ISO_SIN,
	createCamera,
	screenToWorld,
	worldToScreen,
} from "./camera";

// ---------------------------------------------------------------------------
// Round-trip: worldToScreen → screenToWorld
// ---------------------------------------------------------------------------

describe("world ↔ screen round-trip", () => {
	test.prop(
		[
			fc.double({ min: -50000, max: 150000, noNaN: true }),
			fc.double({ min: -50000, max: 150000, noNaN: true }),
		],
	)("screenToWorld inverts worldToScreen", (wx, wy) => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 75000;
		cam.worldY = 43000;
		cam.zoom = 1;

		const screen = worldToScreen(cam, wx, wy);
		const world = screenToWorld(cam, screen.x, screen.y);

		expect(world.x).toBeCloseTo(wx, 4);
		expect(world.y).toBeCloseTo(wy, 4);
	});

	test.prop(
		[
			fc.double({ min: -50000, max: 150000, noNaN: true }),
			fc.double({ min: -50000, max: 150000, noNaN: true }),
			fc.double({ min: 0.1, max: 10, noNaN: true }),
		],
	)("round-trip works at any zoom level", (wx, wy, zoom) => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 50000;
		cam.worldY = 40000;
		cam.zoom = zoom;

		const screen = worldToScreen(cam, wx, wy);
		const world = screenToWorld(cam, screen.x, screen.y);

		expect(world.x).toBeCloseTo(wx, 3);
		expect(world.y).toBeCloseTo(wy, 3);
	});

	test.prop(
		[
			fc.double({ min: 0, max: 1920, noNaN: true }),
			fc.double({ min: 0, max: 1080, noNaN: true }),
		],
	)("worldToScreen inverts screenToWorld", (sx, sy) => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 75000;
		cam.worldY = 43000;
		cam.zoom = 2;

		const world = screenToWorld(cam, sx, sy);
		const screen = worldToScreen(cam, world.x, world.y);

		expect(screen.x).toBeCloseTo(sx, 4);
		expect(screen.y).toBeCloseTo(sy, 4);
	});
});

// ---------------------------------------------------------------------------
// Camera center maps to screen center
// ---------------------------------------------------------------------------

describe("camera center", () => {
	it("camera target maps to screen center", () => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 75000;
		cam.worldY = 43000;

		const screen = worldToScreen(cam, 75000, 43000);

		expect(screen.x).toBeCloseTo(960, 4);
		expect(screen.y).toBeCloseTo(540, 4);
	});

	it("screen center maps to camera target", () => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 75000;
		cam.worldY = 43000;

		const world = screenToWorld(cam, 960, 540);

		expect(world.x).toBeCloseTo(75000, 4);
		expect(world.y).toBeCloseTo(43000, 4);
	});
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

describe("zoom", () => {
	it("zooming in moves off-center points further from center", () => {
		const cam1 = createCamera(1920, 1080);
		cam1.worldX = 0;
		cam1.worldY = 0;
		cam1.zoom = 1;

		const cam2 = createCamera(1920, 1080);
		cam2.worldX = 0;
		cam2.worldY = 0;
		cam2.zoom = 2;

		const s1 = worldToScreen(cam1, 100, 0);
		const s2 = worldToScreen(cam2, 100, 0);

		// Distance from screen center should be 2x larger at zoom 2
		const d1 = Math.hypot(s1.x - 960, s1.y - 540);
		const d2 = Math.hypot(s2.x - 960, s2.y - 540);

		expect(d2).toBeCloseTo(d1 * 2, 4);
	});

	it("zoom does not move the camera center point", () => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 50000;
		cam.worldY = 40000;

		cam.zoom = 1;
		const s1 = worldToScreen(cam, 50000, 40000);

		cam.zoom = 5;
		const s2 = worldToScreen(cam, 50000, 40000);

		expect(s1.x).toBeCloseTo(s2.x, 4);
		expect(s1.y).toBeCloseTo(s2.y, 4);
	});
});

// ---------------------------------------------------------------------------
// Isometric projection properties
// ---------------------------------------------------------------------------

describe("isometric projection", () => {
	it("ISO_COS ≈ cos(30°)", () => {
		expect(ISO_COS).toBeCloseTo(Math.cos(Math.PI / 6), 10);
	});

	it("ISO_SIN = sin(30°) = 0.5", () => {
		expect(ISO_SIN).toBe(0.5);
	});

	it("moving east in world moves right and down on screen", () => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 0;
		cam.worldY = 0;

		const origin = worldToScreen(cam, 0, 0);
		const east = worldToScreen(cam, 100, 0);

		expect(east.x).toBeGreaterThan(origin.x);
		expect(east.y).toBeGreaterThan(origin.y);
	});

	it("moving south in world moves left and down on screen", () => {
		const cam = createCamera(1920, 1080);
		cam.worldX = 0;
		cam.worldY = 0;

		const origin = worldToScreen(cam, 0, 0);
		const south = worldToScreen(cam, 0, 100);

		expect(south.x).toBeLessThan(origin.x);
		expect(south.y).toBeGreaterThan(origin.y);
	});
});
