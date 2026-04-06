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
import { DETECTION_RANGE, VEHICLE_PHYSICS } from "../generated/vehicles";
import { getElevation, getSlopeAlongHeading } from "../map/heightmap";
import type { VehicleType } from "../vehicles/physics";
import {
	createVehicleMesh,
	disposeVehicleMesh,
	setVehicleColor,
} from "./vehicle-meshes";

// ---------------------------------------------------------------------------
// Coalition radar detection — derived from YAML
// ---------------------------------------------------------------------------

// Detection range² per observer type per target type
// Used for coalition threat picture: if ANY allied radar vessel detects a target,
// the detection ring shows for frigate players.
const DETECTION_RANGE_SQ: Record<string, Record<string, number>> = {};
for (const [obsType, targets] of Object.entries(DETECTION_RANGE)) {
	if (!targets) continue;
	const sq: Record<string, number> = {};
	for (const [tgtType, range] of Object.entries(targets)) {
		if (range != null) sq[tgtType] = range * range;
	}
	DETECTION_RANGE_SQ[obsType] = sq;
}

// Allied factions that share radar detections with the US coalition
const COALITION_FACTIONS = new Set(["us", "civilian"]);

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

// Two-tier detection: "direct" = own radar (red), "shared" = coalition intel (pink)
type DetectionTier = "direct" | "shared";

interface DetectionEntry {
	obj: THREE.Object3D;
	tier: DetectionTier;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class ThreeVehicleRenderer {
	readonly root: THREE.Group;
	private pool = new Map<number, VehicleEntry>();
	private detectionIndicators = new Map<number, DetectionEntry>();
	private directDetectionGeo: THREE.RingGeometry;
	private directDetectionMat: THREE.MeshBasicMaterial;
	private sharedDetectionGroup: THREE.Group;
	private sharedDetectionMat: THREE.MeshBasicMaterial;

	constructor() {
		this.root = new THREE.Group();

		// Solid red ring — own radar detection
		this.directDetectionGeo = new THREE.RingGeometry(
			DETECTION_RING_INNER,
			DETECTION_RING_OUTER,
			DETECTION_RING_SEGMENTS,
		);
		this.directDetectionGeo.rotateX(-Math.PI / 2);
		this.directDetectionMat = new THREE.MeshBasicMaterial({
			color: 0xff0000,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.6,
			depthWrite: false,
		});

		// Dashed red ring — shared coalition intel
		// Built as a group of arc-segment meshes to match the solid ring thickness.
		this.sharedDetectionMat = new THREE.MeshBasicMaterial({
			color: 0xff0000,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.6,
			depthWrite: false,
		});
		const DASH_COUNT = 8;
		const DASH_FRACTION = 0.5;
		const dashArc = (Math.PI * 2 * DASH_FRACTION) / DASH_COUNT;
		const gapArc = (Math.PI * 2 * (1 - DASH_FRACTION)) / DASH_COUNT;
		this.sharedDetectionGroup = new THREE.Group();
		for (let i = 0; i < DASH_COUNT; i++) {
			const startAngle = i * (dashArc + gapArc);
			const segGeo = new THREE.RingGeometry(
				DETECTION_RING_INNER,
				DETECTION_RING_OUTER,
				Math.max(3, Math.round(DETECTION_RING_SEGMENTS / DASH_COUNT)),
				1,
				startAngle,
				dashArc,
			);
			segGeo.rotateX(-Math.PI / 2);
			const seg = new THREE.Mesh(segGeo, this.sharedDetectionMat);
			this.sharedDetectionGroup.add(seg);
		}
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

		// Detection rings: frigate players see both tiers, tanker players see own radar only
		const showDirectRings =
			assignedVehicleType === "frigate" || assignedVehicleType === "oil_tanker";
		const showSharedRings = assignedVehicleType === "frigate";

		// Collect radar observers: "direct" = the player's own vessel, "shared" = everyone else
		const directObservers: { x: number; y: number; vehicleType: string }[] = [];
		const sharedObservers: { x: number; y: number; vehicleType: string }[] = [];
		if (showDirectRings || showSharedRings) {
			for (const e of entities) {
				if (
					e.hp > 0 &&
					COALITION_FACTIONS.has(e.faction) &&
					DETECTION_RANGE_SQ[e.vehicleType] != null
				) {
					if (e.id === assignedEntityId) {
						directObservers.push({ x: e.x, y: e.y, vehicleType: e.vehicleType });
					} else {
						sharedObservers.push({ x: e.x, y: e.y, vehicleType: e.vehicleType });
					}
				}
			}
		}

		// Two-tier detection: direct (red) takes priority over shared (pink)
		const detectionTiers = new Map<number, DetectionTier>();

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
			const draftOffset = floodLevel * info.size * 0.08;

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

			// Two-tier radar detection for enemy entities
			if (e.faction === "iran") {
				// Direct detection: player's own vessel type radar
				if (showDirectRings) {
					for (const obs of directObservers) {
						const rangeSq = DETECTION_RANGE_SQ[obs.vehicleType]?.[e.vehicleType];
						if (rangeSq === undefined) continue;
						const dx = obs.x - e.x;
						const dy = obs.y - e.y;
						if (dx * dx + dy * dy < rangeSq) {
							detectionTiers.set(e.id, "direct");
							break;
						}
					}
				}
				// Shared detection: other coalition vessel types (only if not already direct)
				if (showSharedRings && !detectionTiers.has(e.id)) {
					for (const obs of sharedObservers) {
						const rangeSq = DETECTION_RANGE_SQ[obs.vehicleType]?.[e.vehicleType];
						if (rangeSq === undefined) continue;
						const dx = obs.x - e.x;
						const dy = obs.y - e.y;
						if (dx * dx + dy * dy < rangeSq) {
							detectionTiers.set(e.id, "shared");
							break;
						}
					}
				}
			}
		}

		// Update detection indicator rings (two-tier: red=direct, pink=shared)
		for (const e of entities) {
			if (
				e.hp <= 0 ||
				(e.vehicleType !== "shahed" && e.vehicleType !== "quadcopter" && e.vehicleType !== "speedboat")
			)
				continue;

			const tier = detectionTiers.get(e.id);
			if (tier) {
				let entry = this.detectionIndicators.get(e.id);
				if (!entry || entry.tier !== tier) {
					// Create or recreate with correct geometry/material for the tier
					if (entry) {
						this.root.remove(entry.obj);
					}
					let obj: THREE.Object3D;
					if (tier === "direct") {
						obj = new THREE.Mesh(this.directDetectionGeo, this.directDetectionMat);
					} else {
						obj = this.sharedDetectionGroup.clone();
					}
					obj.renderOrder = 5;
					this.root.add(obj);
					entry = { obj, tier };
					this.detectionIndicators.set(e.id, entry);
				}
				const elevation = getElevation(e.x, e.y) + 31;
				entry.obj.position.set(e.x, elevation, e.y);
			} else {
				const entry = this.detectionIndicators.get(e.id);
				if (entry) {
					this.root.remove(entry.obj);
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
		for (const [id, det] of this.detectionIndicators) {
			if (!activeIds.has(id)) {
				this.root.remove(det.obj);
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
		for (const [, det] of this.detectionIndicators) {
			this.root.remove(det.obj);
		}
		this.detectionIndicators.clear();
		this.directDetectionGeo.dispose();
		this.directDetectionMat.dispose();
		for (const child of this.sharedDetectionGroup.children) {
			(child as THREE.Mesh).geometry.dispose();
		}
		this.sharedDetectionMat.dispose();
	}
}
