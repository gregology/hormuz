/**
 * Three.js vehicle renderer with object pooling.
 *
 * Maintains a pool of vehicle objects keyed by entity ID. Each frame,
 * existing objects are repositioned and new ones are created on demand.
 * The depth buffer handles isometric sorting — no manual sort needed.
 *
 * Ships ride the sea surface with a gentle roll and pitch; trucks follow
 * the rendered terrain; drones fly at a fixed altitude. Vehicles wear
 * realistic paint, so faction is shown by an IFF ring beneath each one
 * that keeps a minimum on-screen size when zoomed out.
 *
 * Coordinate mapping: game (x, y) → Three.js (x, height, y).
 */

import { uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import type { EntityState } from "../game/entities";
import { DETECTION_RANGE, VEHICLE_PHYSICS } from "../generated/vehicles";
import { getElevation, getSlopeAlongHeading } from "../map/heightmap";
import type { VehicleType } from "../vehicles/physics";
import { lightingUniforms } from "./environment";
import { ParticleBatch } from "./particles";
import { terrainSurfaceHeight } from "./terrain-surface";
import { type VehicleObject, createVehicleObject } from "./vehicle-meshes";

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

const AIRBORNE_ALTITUDE = 30;

/** Ship motion in a light Gulf sea: roll amplitude (radians) at size 1, scaled down for big hulls. */
const ROLL_AMPLITUDE = 0.05;
/** Bow-up trim of a planing speedboat at full speed (radians). */
const PLANING_TRIM = 0.07;

/** IFF ring: never smaller than this many pixels across when zoomed out. */
const IFF_MIN_RADIUS_PX = 7;
const IFF_Y = 0.35;

/** Lamp sprite size range in pixels. */
const LAMP_MIN_PX = 2.5;
const LAMP_MAX_PX = 9;
const LAMP_INTENSITY = 6;

// ---------------------------------------------------------------------------
// Pool entry
// ---------------------------------------------------------------------------

interface VehicleEntry extends VehicleObject {
	vehicleType: string;
	ring: THREE.Mesh;
}

// Two-tier detection: "direct" = own radar (red), "shared" = coalition intel (pink)
type DetectionTier = "direct" | "shared";

interface DetectionEntry {
	obj: THREE.Object3D;
	tier: DetectionTier;
}

const _lamp = new THREE.Vector3();
const _lampColor = new THREE.Color();

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
	private ringGeometry: THREE.RingGeometry;
	private ringMaterial: THREE.MeshBasicNodeMaterial;
	private lamps = new ParticleBatch(4096, {
		shape: "glow",
		additive: true,
		renderOrder: 7,
	});

	constructor() {
		this.root = new THREE.Group();
		this.root.add(this.lamps.object);

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

		// IFF rings: one material, colour and opacity per ring object.
		this.ringGeometry = new THREE.RingGeometry(0.84, 1, 48);
		this.ringGeometry.rotateX(-Math.PI / 2);
		this.ringMaterial = new THREE.MeshBasicNodeMaterial({
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
		});
		// Rings are UI, so unlit — but toned down at night so they don't glare.
		this.ringMaterial.colorNode = uniform(new THREE.Color())
			.onObjectUpdate(({ object }) => object?.userData.ringColor as THREE.Color)
			.mul(lightingUniforms.daylight.mul(0.45).add(0.55));
		this.ringMaterial.opacityNode = uniform(1).onObjectUpdate(
			({ object }) => object?.userData.ringOpacity as number,
		);
	}

	/**
	 * Update all vehicle meshes for this frame.
	 *
	 * Creates new objects for entities entering the scene,
	 * updates position/rotation/IFF ring for existing ones,
	 * and removes objects for entities that are dead or gone.
	 * `zoom` is screen pixels per world unit (for IFF and lamp sizing).
	 */
	update(
		entities: EntityState[],
		assignedEntityId: number | null,
		assignedVehicleType: string,
		factionColors: Record<string, number>,
		zoom: number,
	): void {
		const activeIds = new Set<number>();
		const time = performance.now() / 1000;
		const nightLights = lightingUniforms.artificialLights.value;
		this.lamps.clear();

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
						directObservers.push({
							x: e.x,
							y: e.y,
							vehicleType: e.vehicleType,
						});
					} else {
						sharedObservers.push({
							x: e.x,
							y: e.y,
							vehicleType: e.vehicleType,
						});
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
				const object = createVehicleObject(e.vehicleType as VehicleType, e.id);
				const ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
				ring.userData.ringColor = new THREE.Color();
				ring.renderOrder = 4;
				this.root.add(object.group, ring);
				entry = { ...object, vehicleType: e.vehicleType, ring };
				this.pool.set(e.id, entry);
			}

			const info = VEHICLE_INFO[e.vehicleType] ?? DEFAULT_INFO;
			const group = entry.group;
			const phase = e.id * 1.618;

			// Height and trim: sea surface, rendered terrain, or flight altitude
			let height: number;
			let pitch = 0;
			let roll = e.listAngle ?? 0;
			if (info.airborne) {
				height = getElevation(e.x, e.y) + AIRBORNE_ALTITUDE;
			} else if (e.vehicleType === "truck") {
				height = terrainSurfaceHeight(e.x, e.y);
				pitch = getSlopeAlongHeading(e.x, e.y, e.heading);
			} else {
				// Flooding: ship rides lower as it takes on water
				const floodLevel = e.floodLevel ?? 0;
				const swell = 1 / Math.sqrt(info.size);
				height =
					-floodLevel * info.size * 0.08 +
					Math.sin(time * 0.9 + phase) * info.size * 0.003;
				roll += Math.sin(time * 0.7 + phase) * ROLL_AMPLITUDE * swell;
				pitch =
					Math.sin(time * 0.55 + phase * 0.7) * ROLL_AMPLITUDE * 0.4 * swell;
				if (e.vehicleType === "speedboat") {
					pitch += Math.min(Math.abs(e.speed) / 40, 1) * PLANING_TRIM;
				}
			}

			group.position.set(e.x, height, e.y);
			group.scale.setScalar(info.size);
			group.rotation.order = "YZX";
			group.rotation.y = -e.heading;
			group.rotation.z = pitch;
			group.rotation.x = roll;
			group.updateMatrixWorld();

			for (const spinner of entry.spinners) spinner.rotation.y = time * 70;

			// IFF ring: faction colour (white for the player), fades as the ship grows on screen
			const isPlayer = e.id === assignedEntityId;
			const screenLength = info.size * zoom;
			const ring = entry.ring;
			(ring.userData.ringColor as THREE.Color).set(
				isPlayer ? 0xffffff : (factionColors[e.faction] ?? 0xcccccc),
			);
			// Once the vehicle itself is readable on screen the ring gets out of the way.
			const fade = THREE.MathUtils.smoothstep(screenLength, 20, 90);
			ring.userData.ringOpacity = (isPlayer ? 0.95 : 0.85) * (1 - fade);
			ring.visible = ring.userData.ringOpacity > 0.01;
			ring.scale.setScalar(Math.max(info.size * 0.6, IFF_MIN_RADIUS_PX / zoom));
			ring.position.set(
				e.x,
				(info.airborne ? height : Math.max(height, 0)) + IFF_Y,
				e.y,
			);

			// Navigation lights, drone strobes, headlights
			for (const lamp of entry.lamps) {
				const lit = lamp.always ? 1 : nightLights;
				const on = lamp.blink ? (Math.sin(time * 8 + phase) > 0.6 ? 1 : 0) : 1;
				const alpha = lit * on;
				if (alpha < 0.02) continue;
				_lamp.set(...lamp.position).applyMatrix4(group.matrixWorld);
				_lampColor.set(lamp.color);
				const size = THREE.MathUtils.clamp(
					info.size * zoom * 0.05,
					LAMP_MIN_PX,
					LAMP_MAX_PX,
				);
				this.lamps.push(
					_lamp.x,
					_lamp.y,
					_lamp.z,
					size,
					_lampColor.r * LAMP_INTENSITY,
					_lampColor.g * LAMP_INTENSITY,
					_lampColor.b * LAMP_INTENSITY,
					alpha,
				);
			}

			// Two-tier radar detection for enemy entities
			if (e.faction === "iran") {
				// Direct detection: player's own vessel type radar
				if (showDirectRings) {
					for (const obs of directObservers) {
						const rangeSq =
							DETECTION_RANGE_SQ[obs.vehicleType]?.[e.vehicleType];
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
						const rangeSq =
							DETECTION_RANGE_SQ[obs.vehicleType]?.[e.vehicleType];
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
		this.lamps.commit();

		// Update detection indicator rings (two-tier: red=direct, pink=shared)
		for (const e of entities) {
			if (
				e.hp <= 0 ||
				(e.vehicleType !== "shahed" &&
					e.vehicleType !== "quadcopter" &&
					e.vehicleType !== "speedboat")
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
						obj = new THREE.Mesh(
							this.directDetectionGeo,
							this.directDetectionMat,
						);
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
				this.root.remove(entry.group, entry.ring);
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
		return this.pool.get(entityId)?.ciwsTurret ?? null;
	}

	/** Clean up GPU resources owned by the renderer (vehicle geometry is shared and cached). */
	dispose(): void {
		for (const [, entry] of this.pool) {
			this.root.remove(entry.group, entry.ring);
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
		this.ringGeometry.dispose();
		this.ringMaterial.dispose();
		this.lamps.dispose();
	}
}
