/**
 * Three.js vehicle renderer with object pooling.
 *
 * Maintains a pool of Three.js Groups keyed by entity ID. Each frame,
 * existing groups are repositioned and new ones are created on demand.
 * The depth buffer handles isometric sorting — no manual sort needed.
 *
 * Coordinate mapping: game (x, y) → Three.js (x, elevation, y).
 * Heading rotation around Y axis, terrain pitch around local lateral axis.
 */

import * as THREE from "three";
import type { EntityState } from "../game/entities";
import { getElevation, getSlopeAlongHeading } from "../map/heightmap";
import type { VehicleType } from "../vehicles/physics";
import {
	createVehicleMesh,
	disposeVehicleMesh,
	setVehicleColor,
} from "./vehicle-meshes";

// ---------------------------------------------------------------------------
// Vehicle properties (size and airborne status per vehicle type)
// ---------------------------------------------------------------------------

const VEHICLE_INFO: Record<string, { size: number; airborne: boolean }> = {
	oil_tanker: { size: 220, airborne: false },
	shahed: { size: 4, airborne: true },
	speedboat: { size: 10, airborne: false },
	frigate: { size: 100, airborne: false },
	truck: { size: 5, airborne: false },
	quadcopter: { size: 2, airborne: true },
};

const DEFAULT_INFO = { size: 10, airborne: false };

// ---------------------------------------------------------------------------
// Pool entry
// ---------------------------------------------------------------------------

interface VehicleEntry {
	group: THREE.Group;
	vehicleType: string;
	currentColor: number;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class ThreeVehicleRenderer {
	readonly root: THREE.Group;
	private pool = new Map<number, VehicleEntry>();

	constructor() {
		this.root = new THREE.Group();
	}

	/**
	 * Update all vehicle meshes for this frame.
	 *
	 * Creates new mesh groups for entities entering the scene,
	 * updates position/rotation/color for existing ones,
	 * and removes groups for entities that are dead or gone.
	 */
	update(
		entities: EntityState[],
		assignedEntityId: number | null,
		factionColors: Record<string, number>,
	): void {
		const activeIds = new Set<number>();

		for (const e of entities) {
			if (e.hp <= 0) continue;
			activeIds.add(e.id);

			let entry = this.pool.get(e.id);
			if (!entry) {
				const group = createVehicleMesh(e.vehicleType as VehicleType);
				this.root.add(group);
				entry = { group, vehicleType: e.vehicleType, currentColor: -1 };
				this.pool.set(e.id, entry);
			}

			const info = VEHICLE_INFO[e.vehicleType] ?? DEFAULT_INFO;

			// Terrain elevation and pitch
			let elevation = getElevation(e.x, e.y);
			let pitchSlope = getSlopeAlongHeading(e.x, e.y, e.heading);
			if (info.airborne) {
				elevation += 30;
				pitchSlope = 0;
			}

			// Position: game (x, y) → Three.js (x, elevation, y)
			entry.group.position.set(e.x, elevation, e.y);

			// Scale by vehicle size (model coords are fractions of size)
			entry.group.scale.setScalar(info.size);

			// Rotation: heading (yaw) around Y, pitch around local lateral axis
			entry.group.rotation.order = "YZX";
			entry.group.rotation.y = -e.heading;
			entry.group.rotation.z = pitchSlope;
			entry.group.rotation.x = 0;

			// Update faction color only when it changes
			const color =
				e.id === assignedEntityId
					? 0xffffff
					: (factionColors[e.faction] ?? 0xcccccc);
			if (color !== entry.currentColor) {
				setVehicleColor(entry.group, color);
				entry.currentColor = color;
			}
		}

		// Remove entities no longer alive
		for (const [id, entry] of this.pool) {
			if (!activeIds.has(id)) {
				this.root.remove(entry.group);
				disposeVehicleMesh(entry.group);
				this.pool.delete(id);
			}
		}
	}

	/** Clean up all GPU resources. */
	dispose(): void {
		for (const [, entry] of this.pool) {
			this.root.remove(entry.group);
			disposeVehicleMesh(entry.group);
		}
		this.pool.clear();
	}
}
