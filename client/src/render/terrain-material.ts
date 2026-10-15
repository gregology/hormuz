/**
 * Land surface material (TSL) for the displaced terrain mesh.
 *
 * Colour comes from elevation, slope, distance inland and broad regional
 * masks (Arabian dune sea in the south-west), broken up by noise at
 * several scales. Mountains get ridged relief detail in their shading
 * normals so they read as rugged at overview zooms, and fine detail fades
 * in close up. Fragments on the water side of the coastline are clipped,
 * so the visible shoreline follows the coastline polygons at any zoom.
 */

import {
	cameraViewMatrix,
	clamp,
	float,
	fwidth,
	max,
	mix,
	normalWorldGeometry,
	normalize,
	positionLocal,
	positionWorld,
	smoothstep,
	texture,
	uniform,
	vec2,
	vec3,
	vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { TERRAIN_BASE_HEIGHT } from "./terrain-surface";

export interface TerrainMaterialInputs {
	/** See createCoastTexture(). */
	coastTexture: THREE.Texture;
	/** Tiling noise in B (broad) and A (fine) — the wave texture is reused. */
	noiseTexture: THREE.Texture;
	/** World extent (x, z) covered by the coast texture. */
	mapSize: THREE.Vector2;
	maxElevation: number;
}

// Linear-space palette.
const WET_SAND = vec3(0.22, 0.17, 0.11);
const BEACH = vec3(0.62, 0.5, 0.34);
const SABKHA = vec3(0.64, 0.58, 0.47);
const GRAVEL_PLAIN = vec3(0.46, 0.34, 0.21);
const DUNE = vec3(0.68, 0.42, 0.19);
const FOOTHILLS = vec3(0.38, 0.27, 0.17);
const RED_ROCK = vec3(0.33, 0.2, 0.12);
const GREY_ROCK = vec3(0.31, 0.26, 0.21);
const SCREE = vec3(0.2, 0.16, 0.12);
const SCRUB = vec3(0.16, 0.16, 0.08);

/** Spacing (world units) of the larger mountain folds. */
const RIDGE_SCALE = 3400;

export function createTerrainMaterial(inputs: TerrainMaterialInputs) {
	const mapSize = uniform(inputs.mapSize);
	/** 1 = real relief, 0 = flattened (map "terrain" layer off). */
	const relief = uniform(1);

	const xz = positionWorld.xz;
	const coast = texture(inputs.coastTexture, xz.div(mapSize));
	const inland = coast.r.mul(-1000);
	const elevation = clamp(positionWorld.y.div(inputs.maxElevation), 0, 1);
	const slope = float(1).sub(normalWorldGeometry.y);
	const footprint = max(fwidth(xz.x), fwidth(xz.y));

	const noise = (scale: number, channel: "b" | "a") =>
		texture(inputs.noiseTexture, xz.div(scale))[channel];
	const regional = noise(29000, "b");
	const broad = noise(5200, "b");
	const medium = noise(1300, "b");
	const fine = noise(170, "a");

	// Broad regions (game coordinates: x east, z south).
	const duneSea = smoothstep(52000, 60000, positionWorld.z).mul(
		float(1).sub(smoothstep(78000, 88000, positionWorld.x)),
	);

	// Low ground: gravel plains, salt flats near the coast, dunes inland in the south-west.
	const flatLowland = float(1)
		.sub(smoothstep(4, 20, positionWorld.y))
		.mul(float(1).sub(smoothstep(0.02, 0.06, slope)));
	let lowland = mix(
		GRAVEL_PLAIN,
		SABKHA,
		smoothstep(0.5, 0.75, broad).mul(flatLowland),
	);
	lowland = mix(
		lowland,
		DUNE,
		duneSea.mul(smoothstep(0.3, 0.6, broad.add(medium.mul(0.3)))),
	);
	// Sparse scrub and date-palm patches on the coastal plains.
	const scrub = smoothstep(0.72, 0.86, medium.mul(0.5).add(fine.mul(0.5)))
		.mul(float(1).sub(smoothstep(20, 50, positionWorld.y)))
		.mul(float(1).sub(duneSea));
	lowland = mix(lowland, SCRUB, scrub.mul(0.45));

	// High ground: foothills into red-brown rock, greyer on the highest, steepest ground.
	const rock = mix(
		RED_ROCK,
		GREY_ROCK,
		smoothstep(0.45, 0.8, elevation.add(regional.mul(0.3))),
	);
	let color = mix(lowland, FOOTHILLS, smoothstep(0.04, 0.2, elevation));
	color = mix(
		color,
		rock,
		smoothstep(0.22, 0.5, elevation.add(slope.mul(0.6))),
	);
	color = mix(color, SCREE, smoothstep(0.15, 0.4, slope).mul(0.5));

	// Shore: dry beach, then wet sand at the waterline.
	color = mix(
		color,
		BEACH,
		float(1).sub(smoothstep(30, max(float(160), footprint.mul(2)), inland)),
	);
	color = mix(
		color,
		WET_SAND,
		float(1).sub(smoothstep(0, max(float(18), footprint), inland)),
	);

	// Gentle value variation so flat ground doesn't read as a single swatch.
	color = color.mul(
		broad.mul(0.14).add(medium.mul(0.1)).add(fine.mul(0.08)).add(0.84),
	);

	// Relief detail in the shading normal:
	//  - fold ridges on mountains, visible from overview zooms,
	//  - fine grain close up, faded out before it would alias.
	// The Zagros near the strait are long folds running NW–SE, parallel to
	// the coast, so ridges are stretched along that axis and gently warped.
	const ridges = (offsetX: number, offsetZ: number) => {
		const p = xz.add(vec2(offsetX, offsetZ));
		const along = p.x.add(p.y).mul(Math.SQRT1_2);
		const across = p.x
			.sub(p.y)
			.mul(Math.SQRT1_2)
			.add(texture(inputs.noiseTexture, p.div(21000)).b.mul(2600));
		const fold = (scale: number, weight: number) =>
			float(1)
				.sub(
					texture(
						inputs.noiseTexture,
						vec2(along.div(scale * 3.5), across.div(scale)),
					)
						.b.mul(2)
						.sub(1)
						.abs(),
				)
				.mul(weight);
		return fold(RIDGE_SCALE, 1).add(fold(RIDGE_SCALE * 0.45, 0.3));
	};
	const ridgeStep = 40;
	const r0 = ridges(0, 0);
	const mountains = smoothstep(0.08, 0.35, elevation).mul(
		broad.mul(0.6).add(0.6),
	);
	const ridgeStrength = mountains.mul(170).mul(relief);
	const ridgeGradient = vec2(
		ridges(ridgeStep, 0).sub(r0),
		ridges(0, ridgeStep).sub(r0),
	).div(ridgeStep);

	const grainFade = float(1).sub(smoothstep(1.5, 10, footprint));
	const grainStep = 3;
	const g0 = texture(inputs.noiseTexture, xz.div(260)).a;
	const grainGradient = vec2(
		texture(inputs.noiseTexture, xz.add(vec2(grainStep, 0)).div(260)).a.sub(g0),
		texture(inputs.noiseTexture, xz.add(vec2(0, grainStep)).div(260)).a.sub(g0),
	).mul(grainFade.mul(6));

	const gradient = ridgeGradient.mul(ridgeStrength).add(grainGradient);
	const bumped = normalize(
		normalWorldGeometry.sub(vec3(gradient.x, 0, gradient.y)),
	);

	const material = new THREE.MeshStandardNodeMaterial();
	material.colorNode = color;
	material.roughnessNode = mix(
		float(0.55),
		float(0.95),
		smoothstep(0, 20, inland),
	);
	material.metalnessNode = float(0);
	material.normalNode = normalize(cameraViewMatrix.mul(vec4(bumped, 0)).xyz);
	// Clip everything seaward of the coastline.
	material.maskNode = inland.greaterThanEqual(0);
	material.positionNode = vec3(
		positionLocal.x,
		positionLocal.y.mul(relief).max(TERRAIN_BASE_HEIGHT),
		positionLocal.z,
	);

	return { material, relief };
}
