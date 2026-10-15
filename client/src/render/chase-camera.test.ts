import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
	ChaseCamera,
	type ChaseTarget,
	DEFAULT_CHASE_SETTINGS,
} from "./chase-camera";

const heading = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
const pixels = fc.double({ min: -2000, max: 2000, noNaN: true });

function target(overrides: Partial<ChaseTarget> = {}): ChaseTarget {
	return {
		x: 1000,
		y: 2000,
		heading: 0,
		baseHeight: 0,
		size: 100,
		...overrides,
	};
}

/** Horizontal unit vector from the camera towards the point it looks at. */
function viewDirection(pose: { position: number[]; lookAt: number[] }): [
	number,
	number,
] {
	const dx = pose.lookAt[0] - pose.position[0];
	const dz = pose.lookAt[2] - pose.position[2];
	const length = Math.hypot(dx, dz);
	return [dx / length, dz / length];
}

describe("third-person chase camera", () => {
	test.prop([heading])(
		"starts behind the vehicle, looking where it is going",
		(h) => {
			const camera = new ChaseCamera();
			camera.reset("third-person", h);
			const [vx, vz] = viewDirection(
				camera.pose("third-person", target({ heading: h })),
			);
			expect(vx * Math.cos(h) + vz * Math.sin(h)).toBeCloseTo(1, 6);
		},
	);

	test.prop([heading, pixels, pixels])(
		"stays at the orbit distance wherever the mouse points it",
		(h, dx, dy) => {
			const camera = new ChaseCamera();
			camera.reset("third-person", h);
			camera.look("third-person", dx, dy);
			const { position, lookAt } = camera.pose(
				"third-person",
				target({ heading: h }),
			);
			const distance = Math.hypot(
				position[0] - lookAt[0],
				position[1] - lookAt[1],
				position[2] - lookAt[2],
			);
			expect(distance).toBeCloseTo(100 * DEFAULT_CHASE_SETTINGS.distance, 6);
		},
	);

	test.prop([pixels])("never dips below the vehicle's waterline", (dy) => {
		const camera = new ChaseCamera();
		camera.reset("third-person", 0);
		camera.look("third-person", 0, dy);
		expect(camera.pose("third-person", target()).position[1]).toBeGreaterThan(
			0,
		);
	});

	it("keeps looking the same way when the vehicle turns (free look)", () => {
		const camera = new ChaseCamera();
		camera.reset("third-person", 0);
		const before = viewDirection(
			camera.pose("third-person", target({ heading: 0 })),
		);
		const after = viewDirection(
			camera.pose("third-person", target({ heading: 1.2 })),
		);
		expect(after[0]).toBeCloseTo(before[0], 9);
		expect(after[1]).toBeCloseTo(before[1], 9);
	});

	it("swings round with the vehicle when following its heading", () => {
		const camera = new ChaseCamera({
			...DEFAULT_CHASE_SETTINGS,
			followHeading: true,
		});
		camera.reset("third-person", 0);
		const [vx, vz] = viewDirection(
			camera.pose("third-person", target({ heading: Math.PI / 2 })),
		);
		expect(vx).toBeCloseTo(0, 9);
		expect(vz).toBeCloseTo(1, 9);
	});

	it("moving the mouse right turns the view right", () => {
		const camera = new ChaseCamera();
		camera.reset("third-person", 0);
		camera.look("third-person", 200, 0);
		// Heading 0 is east; turning right (clockwise from above) heads south (+Z).
		expect(
			viewDirection(camera.pose("third-person", target()))[1],
		).toBeGreaterThan(0);
	});

	it("scrolling out moves the camera further away", () => {
		const camera = new ChaseCamera();
		camera.reset("third-person", 0);
		const near = camera.pose("third-person", target()).position;
		camera.zoomBy(120);
		const far = camera.pose("third-person", target()).position;
		expect(Math.hypot(far[0] - 1000, far[2] - 2000)).toBeGreaterThan(
			Math.hypot(near[0] - 1000, near[2] - 2000),
		);
	});
});

describe("first-person camera", () => {
	test.prop([heading, pixels])(
		"turns the head relative to the heading",
		(h, dx) => {
			const camera = new ChaseCamera();
			camera.reset("first-person", h);
			camera.look("first-person", dx, 0);
			const [vx, vz] = viewDirection(
				camera.pose("first-person", target({ heading: h })),
			);
			const offset = Math.atan2(vz, vx) - h;
			expect(Math.cos(offset)).toBeCloseTo(Math.cos(camera.yaw), 6);
			expect(Math.sin(offset)).toBeCloseTo(Math.sin(camera.yaw), 6);
		},
	);

	it("sits on board, ahead of the vehicle's centre", () => {
		const camera = new ChaseCamera();
		camera.reset("first-person", 0);
		const { position } = camera.pose("first-person", target());
		expect(position[0]).toBeGreaterThan(1000);
		expect(position[1]).toBeGreaterThan(0);
	});
});
