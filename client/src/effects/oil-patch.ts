/**
 * Oil patch effect — dark spreading oil slick spawned when a ship sinks.
 *
 * Rendered as a flat disc on the water surface with a procedural shader
 * that creates organic noise-based edges, slow radial spread, iridescent
 * sheen, and gradual fade. Size and duration scale with vehicle type
 * (a loaded VLCC leaves a massive long-lasting slick; a frigate leaves
 * a small fuel patch).
 */

import * as THREE from "three";
import type { ThreeEffect } from "./types";

/** Height just above water — below wake (0.05) to layer correctly. */
const WATER_Y = 0.02;

/** Oil patch sizing per vehicle type: [radius multiplier, duration seconds]. */
const PATCH_CONFIG: Record<string, [number, number]> = {
	oil_tanker: [3.0, 180],
	frigate: [0.5, 60],
	speedboat: [0.6, 30],
};
const DEFAULT_PATCH: [number, number] = [0.3, 30];

/** Get oil patch radius and duration for a vehicle type and size. */
export function oilPatchParams(
	vehicleType: string,
	size: number,
): { radius: number; duration: number } {
	const [mult, duration] = PATCH_CONFIG[vehicleType] ?? DEFAULT_PATCH;
	return { radius: size * mult, duration };
}

// --- Shaders ---

const OIL_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const OIL_FRAG = `
#include <logdepthbuf_pars_fragment>
uniform float uTime;
in vec2 vUv;
out vec4 fragColor;

// Simple value noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec2 center = vUv - 0.5;
    float dist = length(center) * 2.0; // 0 at center, 1 at UV edge

    // Spread: starts concentrated, grows to full radius
    float spread = 0.3 + uTime * 0.7;
    float nd = dist / spread; // normalized distance within spread

    // Organic edge noise
    float angle = atan(center.y, center.x);
    float edgeNoise = vnoise(vec2(angle * 3.0, uTime * 0.3)) * 0.3;

    if (nd > 1.0 + edgeNoise) discard;

    // Alpha: dense center, thin edges, fades over time
    float edgeFade = 1.0 - smoothstep(0.4, 1.0 + edgeNoise, nd);
    float timeFade = 1.0 - uTime * uTime; // slow start, fast fade at end
    float alpha = edgeFade * timeFade * 0.55;
    if (alpha < 0.003) discard;

    // Base oil color: very dark brown/black with noise variation
    float cn = vnoise(center * 8.0 + uTime * 0.2) * 0.08;
    vec3 oil = vec3(0.04 + cn, 0.025 + cn * 0.5, 0.01);

    // Iridescent rainbow sheen — thin-film interference look
    float irid = vnoise(vec2(angle * 4.0, dist * 5.0)) * 0.12 * edgeFade;
    oil += vec3(
        sin(angle * 3.0 + dist * 8.0) * irid,
        sin(angle * 3.0 + dist * 8.0 + 2.094) * irid,
        sin(angle * 3.0 + dist * 8.0 + 4.189) * irid
    );

    fragColor = vec4(max(oil, 0.0), alpha);
    #include <logdepthbuf_fragment>
}
`;

export class OilPatch implements ThreeEffect {
	alive = true;
	readonly root: THREE.Mesh;
	private age = 0;
	private duration: number;
	private material: THREE.ShaderMaterial;

	constructor(x: number, y: number, radius: number, duration: number) {
		this.duration = duration;

		const planeSize = radius * 2;
		const geo = new THREE.PlaneGeometry(planeSize, planeSize);
		geo.rotateX(-Math.PI / 2); // lay flat in XZ plane

		this.material = new THREE.ShaderMaterial({
			vertexShader: OIL_VERT,
			fragmentShader: OIL_FRAG,
			uniforms: {
				uTime: { value: 0 },
			},
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			glslVersion: THREE.GLSL3,
		});

		this.root = new THREE.Mesh(geo, this.material);
		this.root.position.set(x, WATER_Y, y);
		this.root.frustumCulled = false;
	}

	update(dt: number, _zoom: number): void {
		this.age += dt;
		if (this.age >= this.duration) {
			this.alive = false;
			return;
		}
		this.material.uniforms.uTime.value = this.age / this.duration;
	}

	dispose(): void {
		this.root.geometry.dispose();
		this.material.dispose();
	}
}
