/**
 * Sea surface material (TSL).
 *
 * A physically lit surface (sky reflections + sun/moon glints come from
 * the standard BRDF and the scene environment) with:
 *   - body colour from real bathymetry (turquoise banks → deep navy) and
 *     distance to the coast,
 *   - layered, scrolling wind-wave normals,
 *   - surf along every coastline, rock and shoal,
 *   - roughness that grows with pixel footprint, so sub-pixel waves turn
 *     into a broad glitter instead of aliasing when zoomed out.
 */

import {
	cameraViewMatrix,
	clamp,
	float,
	fwidth,
	max,
	mix,
	normalize,
	positionWorld,
	sin,
	smoothstep,
	texture,
	time,
	uniform,
	vec2,
	vec3,
	vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";

export interface WaterMaterialInputs {
	/** See createCoastTexture(). */
	coastTexture: THREE.Texture;
	/** See createBathymetryTexture(). */
	bathymetryTexture: THREE.Texture;
	/** See createWaveTexture(). */
	waveTexture: THREE.Texture;
	/** World extent (x, z) covered by the coast and bathymetry textures. */
	mapSize: THREE.Vector2;
}

// Linear-space palette.
const DEEP = vec3(0.004, 0.022, 0.05);
const OPEN = vec3(0.008, 0.055, 0.085);
const GULF = vec3(0.014, 0.11, 0.12);
const BANK = vec3(0.05, 0.25, 0.24);
const SANDY_SHALLOWS = vec3(0.14, 0.36, 0.3);
const FOAM = vec3(0.78, 0.82, 0.82);
const SUBMERGED_ROCK = vec3(0.05, 0.045, 0.04);

export function createWaterMaterial(inputs: WaterMaterialInputs) {
	const depthZones = uniform(1);
	const mapSize = uniform(inputs.mapSize);

	const xz = positionWorld.xz;
	const mapUv = xz.div(mapSize);
	const coast = texture(inputs.coastTexture, mapUv);
	const shoreDistance = coast.r.mul(1000);
	const depth = texture(inputs.bathymetryTexture, mapUv).r;
	// World units covered by one pixel: drives anti-aliasing of fine detail.
	const footprint = max(fwidth(xz.x), fwidth(xz.y));

	// --- Waves: three octaves drifting south-east with the shamal ---
	const wave = (scale: number, drift: [number, number]) =>
		texture(
			inputs.waveTexture,
			xz.div(scale).add(vec2(drift[0], drift[1]).mul(time)),
		).rg.sub(0.5);
	const slope = wave(1500, [0.0035, 0.0021])
		.mul(0.9)
		.add(wave(410, [0.009, 0.0062]).mul(0.75))
		.add(wave(97, [0.021, 0.0115]).mul(0.55));
	const calmInShallows = mix(
		float(0.55),
		float(1),
		smoothstep(0, 600, shoreDistance),
	);
	const slopeStrength = float(0.55).mul(calmInShallows);
	const worldNormal = normalize(
		vec3(
			slope.x.mul(slopeStrength).negate(),
			1,
			slope.y.mul(slopeStrength).negate(),
		),
	);

	// Large-scale slicks and gusts change how rough (and so how shiny) the sea is.
	const gusts = texture(
		inputs.waveTexture,
		xz.div(26000).add(vec2(0.0011, 0.0006).mul(time)),
	).b;
	const foamNoise = texture(
		inputs.waveTexture,
		xz.div(70).add(vec2(0.01, -0.006).mul(time)),
	).a;

	// --- Body colour: real depth, plus sandy shallows right off the beach ---
	let body = mix(BANK, GULF, smoothstep(4, 30, depth));
	body = mix(body, OPEN, smoothstep(40, 110, depth));
	body = mix(body, DEEP, smoothstep(250, 1800, depth));
	body = mix(
		body,
		SANDY_SHALLOWS,
		float(1)
			.sub(smoothstep(0, 450, shoreDistance))
			.mul(0.7),
	);
	body = mix(body, BANK, coast.g.mul(depthZones).mul(0.35));
	body = mix(body, SANDY_SHALLOWS, coast.b.mul(depthZones).mul(0.45));
	body = mix(body, SANDY_SHALLOWS, coast.a.mul(0.6));

	// --- Foam: breaking bands rolling onto every shore, rock and shoal ---
	const surfWidth = max(float(60), footprint.mul(3));
	const surfZone = float(1).sub(smoothstep(0, surfWidth, shoreDistance));
	const swell = sin(
		shoreDistance
			.div(surfWidth)
			.mul(9)
			.sub(time.mul(1.3))
			.add(foamNoise.mul(5)),
	);
	const breakers = surfZone
		.mul(smoothstep(0.35, 0.95, swell))
		.mul(smoothstep(0.3, 0.75, foamNoise));
	const shoreline = float(1).sub(
		smoothstep(0, max(float(10), footprint.mul(1.5)), shoreDistance),
	);
	const shoalNoise = texture(
		inputs.waveTexture,
		xz.div(230).add(vec2(-0.004, 0.003).mul(time)),
	).a;
	const shoalFoam = smoothstep(0.45, 0.85, coast.a)
		.mul(smoothstep(0.45, 0.8, shoalNoise.mul(0.6).add(foamNoise.mul(0.4))))
		.mul(
			sin(time.mul(0.9).add(foamNoise.mul(9)))
				.mul(0.3)
				.add(0.7),
		);
	const foam = clamp(
		breakers.mul(0.85).add(shoreline.mul(0.9)).add(shoalFoam),
		0,
		1,
	);

	// Under overhanging coastal terrain the plane is "land": show wet rock.
	const underLand = smoothstep(0, -8, shoreDistance);

	const color = mix(mix(body, FOAM, foam), SUBMERGED_ROCK, underLand);
	const roughness = clamp(
		float(0.05)
			.add(gusts.mul(0.07))
			// Toksvig-style: sub-pixel waves average into a rougher surface.
			.add(smoothstep(4, 120, footprint).mul(0.22))
			.add(foam.mul(0.55))
			.add(underLand),
		0,
		1,
	);

	const material = new THREE.MeshStandardNodeMaterial();
	material.colorNode = color;
	material.roughnessNode = roughness;
	material.metalnessNode = float(0);
	material.normalNode = normalize(
		cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz,
	);

	return { material, depthZones };
}
