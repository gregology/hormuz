/**
 * Builds the Three.js object for one vehicle from its model data.
 *
 * Geometry is cached per shape and every vehicle shares one material, so
 * a vehicle costs one draw call plus any animated parts (CIWS turret,
 * rotors). The group's scale is set to the vehicle's size by the
 * renderer; model coordinates are fractions of size.
 *
 * Local axes: X = forward, Y = up, Z = starboard.
 */

import * as THREE from "three/webgpu";
import type { VehicleType } from "../vehicles/physics";
import { buildModelGeometry } from "./vehicle-geometry";
import {
	type PaletteColors,
	paletteColors,
	vehicleMaterial,
} from "./vehicle-material";
import {
	CIWS_MUZZLE_OFFSET,
	CIWS_TURRET_POS,
	type Lamp,
	type VehicleModel,
	ciwsTurretModel,
	vehicleAppearance,
} from "./vehicle-models";

export { CIWS_MUZZLE_OFFSET, CIWS_TURRET_POS };

const geometryCache = new Map<string, THREE.BufferGeometry>();

function cachedGeometry(
	key: string,
	build: () => VehicleModel,
): THREE.BufferGeometry {
	let geometry = geometryCache.get(key);
	if (!geometry) {
		geometry = buildModelGeometry(build());
		geometryCache.set(key, geometry);
	}
	return geometry;
}

let rotorParts: {
	blade: THREE.BufferGeometry;
	disc: THREE.BufferGeometry;
	discMaterial: THREE.Material;
} | null = null;

/** A spinning blade pair plus a faint motion-blur disc, radius 1 about +Y. */
function createRotor(blades: number): THREE.Group {
	if (!rotorParts) {
		const disc = new THREE.CircleGeometry(1, 24);
		disc.rotateX(-Math.PI / 2);
		rotorParts = {
			blade: cachedGeometry("rotor-blade", () => ({
				parts: [
					{
						kind: "box",
						center: [0, 0, 0],
						size: [2, 0.02, 0.09],
						paint: { color: 0x1a1a1a, roughness: 0.5, metalness: 0.3 },
					},
				],
			})),
			disc,
			discMaterial: new THREE.MeshBasicNodeMaterial({
				color: 0x202224,
				transparent: true,
				opacity: 0.22,
				depthWrite: false,
				side: THREE.DoubleSide,
			}),
		};
	}
	const rotor = new THREE.Group();
	const spinner = new THREE.Group();
	for (let i = 0; i < blades / 2; i++) {
		const blade = new THREE.Mesh(rotorParts.blade, vehicleMaterial());
		blade.rotation.y = (i * Math.PI * 2) / blades;
		spinner.add(blade);
	}
	rotor.add(spinner, new THREE.Mesh(rotorParts.disc, rotorParts.discMaterial));
	rotor.userData.spinner = spinner;
	return rotor;
}

export interface VehicleObject {
	group: THREE.Group;
	/** Rotating CIWS turret (frigates only). */
	ciwsTurret: THREE.Group | null;
	/** Rotor/propeller spinners to animate. */
	spinners: THREE.Object3D[];
	/** Navigation lights etc. in model space. */
	lamps: readonly Lamp[];
}

/** Create the visual object for a vehicle. Tanker liveries vary with `entityId`. */
export function createVehicleObject(
	vehicleType: VehicleType,
	entityId: number,
): VehicleObject {
	const appearance = vehicleAppearance(vehicleType, entityId);
	const model = appearance.build();
	const palette: PaletteColors = paletteColors(appearance.palette);
	const group = new THREE.Group();

	const hull = new THREE.Mesh(
		cachedGeometry(appearance.shapeKey, appearance.build),
		vehicleMaterial(),
	);
	hull.castShadow = true;
	hull.receiveShadow = true;
	hull.userData.palette = palette;
	group.add(hull);

	let ciwsTurret: THREE.Group | null = null;
	if (model.ciws) {
		ciwsTurret = new THREE.Group();
		const turret = new THREE.Mesh(
			cachedGeometry("ciws", ciwsTurretModel),
			vehicleMaterial(),
		);
		turret.castShadow = true;
		turret.userData.palette = palette;
		ciwsTurret.add(turret);
		ciwsTurret.position.set(...model.ciws);
		group.add(ciwsTurret);
	}

	const spinners: THREE.Object3D[] = [];
	for (const spec of model.rotors ?? []) {
		const rotor = createRotor(spec.blades);
		rotor.position.set(...spec.center);
		rotor.scale.setScalar(spec.radius);
		if (spec.axis === "forward") rotor.rotation.z = Math.PI / 2;
		for (const child of rotor.children) child.userData.palette = palette;
		group.add(rotor);
		spinners.push(rotor.userData.spinner as THREE.Object3D);
	}

	return { group, ciwsTurret, spinners, lamps: model.lamps ?? [] };
}
