/**
 * The single material shared by every vehicle mesh.
 *
 * Reads the paint attributes baked by vehicle-geometry.ts. Palette slots
 * (hull, deck, funnel livery…) are per-object uniforms filled from
 * `mesh.userData.palette`, so ships with different liveries share both
 * geometry and material.
 */

import {
	attribute,
	mx_noise_float,
	positionLocal,
	select,
	uniform,
	vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { lightingUniforms } from "./environment";
import { PALETTE_SLOTS } from "./vehicle-geometry";
import type { Palette } from "./vehicle-models";

/** Linear palette colours in PALETTE_SLOTS order, stored on `mesh.userData.palette`. */
export type PaletteColors = THREE.Color[];

/** Night-time window/lamp emission multiplier (HDR, so it blooms). */
const GLOW_STRENGTH = 3;

let shared: THREE.MeshStandardNodeMaterial | null = null;

export function vehicleMaterial(): THREE.MeshStandardNodeMaterial {
	if (shared) return shared;

	const slot = attribute<"float">("slot", "float");
	const surface = attribute<"vec2">("surface", "vec2");
	let albedo = vec3(attribute<"vec3">("color", "vec3"));
	PALETTE_SLOTS.forEach((_, i) => {
		const color = uniform(new THREE.Color()).onObjectUpdate(
			({ object }) =>
				(object?.userData.palette as PaletteColors | undefined)?.[i],
		);
		albedo = vec3(
			select(
				slot.greaterThan(i + 0.5).and(slot.lessThan(i + 1.5)),
				vec3(color),
				albedo,
			),
		);
	});
	// Subtle grime and weathering so big painted surfaces don't look like plastic.
	const grime = mx_noise_float(positionLocal.mul(vec3(14, 60, 22)))
		.mul(0.07)
		.add(0.97);

	const material = new THREE.MeshStandardNodeMaterial({
		side: THREE.DoubleSide,
	});
	material.colorNode = albedo.mul(grime);
	material.roughnessNode = surface.x;
	material.metalnessNode = surface.y;
	material.emissiveNode = attribute<"vec3">("glow", "vec3")
		.mul(lightingUniforms.artificialLights)
		.mul(GLOW_STRENGTH);
	shared = material;
	return material;
}

export function paletteColors(palette: Palette): PaletteColors {
	return PALETTE_SLOTS.map((slot) => new THREE.Color(palette[slot]));
}
