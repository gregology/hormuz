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
import { RADAR_DETECTION, VEHICLE_PHYSICS } from "../generated/vehicles";
import { getElevation, getSlopeAlongHeading } from "../map/heightmap";
import type { VehicleType } from "../vehicles/physics";
import {
	createVehicleMesh,
	disposeVehicleMesh,
	setVehicleColor,
} from "./vehicle-meshes";

// ---------------------------------------------------------------------------
// Frigate radar detection — derived from YAML
// ---------------------------------------------------------------------------

const RADAR_RANGE_SQ: Record<string, number> = Object.fromEntries(
	Object.entries(RADAR_DETECTION).map(([k, v]) => [k, v * v]),
);

// Detection indicator ring (world-space units)
const DETECTION_RING_INNER = 80;
const DETECTION_RING_OUTER = 100;
const DETECTION_RING_SEGMENTS = 32;

// ---------------------------------------------------------------------------
// Vehicle properties — derived from YAML
// ---------------------------------------------------------------------------

const VEHICLE_INFO: Record<string, { size: number; airborne: boolean }> =
	Object.fromEntries(
		Object.entries(VEHICLE_PHYSICS).map(([k, v]) => [
			k,
			{ size: v.size, airborne: v.airborne },
		]),
	);

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
	private detectionIndicators = new Map<number, THREE.Mesh>();
	private detectionGeo: THREE.RingGeometry;
	private detectionMat: THREE.MeshBasicMaterial;

	constructor() {
		this.root = new THREE.Group();
		this.detectionGeo = new THREE.RingGeometry(
			DETECTION_RING_INNER,
			DETECTION_RING_OUTER,
			DETECTION_RING_SEGMENTS,
		);
		// Rotate from XY plane to XZ plane (flat on ground)
		this.detectionGeo.rotateX(-Math.PI / 2);
		this.detectionMat = new THREE.MeshBasicMaterial({
			color: 0xff0000,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.6,
			depthWrite: false,
		});
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
		assignedVehicleType: string,
		factionColors: Record<string, number>,
	): void {
		const activeIds = new Set<number>();

		// Detection rings are only visible to frigate players (radar/AWACS)
		const showDetectionRings = assignedVehicleType === "frigate";

		// Collect frigate positions for radar detection
		const frigatePositions: { x: number; y: number }[] = [];
		if (showDetectionRings) {
			for (const e of entities) {
				if (e.hp > 0 && e.vehicleType === "frigate") {
					frigatePositions.push({ x: e.x, y: e.y });
				}
			}
		}

		const detectedDroneIds = new Set<number>();

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

			// Flooding: ship rides lower as it takes on water
			const floodLevel = e.floodLevel ?? 0;
			const draftOffset = floodLevel * info.size * 0.15;

			// Position: game (x, y) → Three.js (x, elevation, y)
			entry.group.position.set(e.x, elevation - draftOffset, e.y);

			// Scale by vehicle size (model coords are fractions of size)
			entry.group.scale.setScalar(info.size);

			// Rotation: heading (yaw), pitch (terrain slope), roll (list from flooding)
			entry.group.rotation.order = "YZX";
			entry.group.rotation.y = -e.heading;
			entry.group.rotation.z = pitchSlope;
			entry.group.rotation.x = e.listAngle ?? 0;

			// Update faction color only when it changes
			const color =
				e.id === assignedEntityId
					? 0xffffff
					: (factionColors[e.faction] ?? 0xcccccc);
			if (color !== entry.currentColor) {
				setVehicleColor(entry.group, color);
				entry.currentColor = color;
			}

			// Quadcopter front light blink
			if (e.vehicleType === "quadcopter") {
				const light = entry.group.userData.frontLight as THREE.Mesh | undefined;
				if (light) {
					const t = performance.now() / 1000;
					(light.material as THREE.MeshBasicMaterial).opacity =
						Math.sin(t * 8) > 0 ? 0.9 : 0.05;
				}
			}

			// Radar detection: only computed for frigate players
			if (showDetectionRings) {
				const rangeSq = RADAR_RANGE_SQ[e.vehicleType];
				if (rangeSq !== undefined) {
					for (const fp of frigatePositions) {
						const dx = fp.x - e.x;
						const dy = fp.y - e.y;
						if (dx * dx + dy * dy < rangeSq) {
							detectedDroneIds.add(e.id);
							break;
						}
					}
				}
			}
		}

		// Update detection indicator rings (frigate players only)
		for (const e of entities) {
			if (
				e.hp <= 0 ||
				(e.vehicleType !== "shahed" && e.vehicleType !== "quadcopter")
			)
				continue;

			if (detectedDroneIds.has(e.id)) {
				let ring = this.detectionIndicators.get(e.id);
				if (!ring) {
					ring = new THREE.Mesh(this.detectionGeo, this.detectionMat);
					ring.renderOrder = 5;
					this.root.add(ring);
					this.detectionIndicators.set(e.id, ring);
				}
				const elevation = getElevation(e.x, e.y) + 31;
				ring.position.set(e.x, elevation, e.y);
			} else {
				const ring = this.detectionIndicators.get(e.id);
				if (ring) {
					this.root.remove(ring);
					this.detectionIndicators.delete(e.id);
				}
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
		// Remove detection indicators for dead/removed drones
		for (const [id, ring] of this.detectionIndicators) {
			if (!activeIds.has(id)) {
				this.root.remove(ring);
				this.detectionIndicators.delete(id);
			}
		}
	}

	/** Get the CIWS turret group for a frigate entity (null if not a frigate or not pooled). */
	getCiwsTurret(entityId: number): THREE.Group | null {
		const entry = this.pool.get(entityId);
		if (!entry) return null;
		return (entry.group.userData.ciwsTurret as THREE.Group) ?? null;
	}

	/** Clean up all GPU resources. */
	dispose(): void {
		for (const [, entry] of this.pool) {
			this.root.remove(entry.group);
			disposeVehicleMesh(entry.group);
		}
		this.pool.clear();
		for (const [, ring] of this.detectionIndicators) {
			this.root.remove(ring);
		}
		this.detectionIndicators.clear();
		this.detectionGeo.dispose();
		this.detectionMat.dispose();
	}
}
