import { describe, expect, it } from "vitest";
import { COLLISION_POLYGONS } from "../generated/vehicles";
import type { VehicleType } from "../vehicles/physics";
import { buildModelGeometry } from "./vehicle-geometry";
import { vehicleAppearance } from "./vehicle-models";

function extents(points: readonly (readonly [number, number])[]) {
	return {
		minX: Math.min(...points.map(([x]) => x)),
		maxX: Math.max(...points.map(([x]) => x)),
		maxZ: Math.max(...points.map(([, z]) => Math.abs(z))),
	};
}

/** Plan extents of everything drawn: merged hull geometry plus spinning rotor discs. */
function modelExtents(type: VehicleType, entityId: number) {
	const model = vehicleAppearance(type, entityId).build();
	const geometry = buildModelGeometry(model);
	geometry.computeBoundingBox();
	const box = geometry.boundingBox;
	if (!box) throw new Error("no bounding box");
	const extents = {
		minX: box.min.x,
		maxX: box.max.x,
		maxZ: Math.max(-box.min.z, box.max.z),
	};
	for (const rotor of model.rotors ?? []) {
		if (rotor.axis !== "up") continue;
		const [x, , z] = rotor.center;
		extents.minX = Math.min(extents.minX, x - rotor.radius);
		extents.maxX = Math.max(extents.maxX, x + rotor.radius);
		extents.maxZ = Math.max(extents.maxZ, Math.abs(z) + rotor.radius);
	}
	return extents;
}

const VEHICLES = Object.keys(COLLISION_POLYGONS) as VehicleType[];

// Tanker ids covering every class (see tanker-variants.test.ts for variety).
const TANKER_IDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe("vehicle models match their collision footprints", () => {
	for (const type of VEHICLES) {
		const ids = type === "oil_tanker" ? TANKER_IDS : [1];
		it(`${type} is as long and as wide as it collides`, () => {
			const footprint = extents(COLLISION_POLYGONS[type]);
			for (const id of ids) {
				const model = modelExtents(type, id);
				// Bow and stern within 6% of length (guns and outboards may poke out a little).
				expect(Math.abs(model.maxX - footprint.maxX)).toBeLessThan(0.06);
				expect(Math.abs(model.minX - footprint.minX)).toBeLessThan(0.06);
				// Never visibly wider than what physics collides with.
				expect(model.maxZ).toBeLessThanOrEqual(footprint.maxZ * 1.15);
			}
		});
	}
});
