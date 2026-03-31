/**
 * Explosion effect (Three.js) — expanding fireball with shockwave ring
 * and debris particles.
 *
 * Uses a billboarded plane with a custom shader for the core flash,
 * shockwave ring, and smoke cloud. Debris is a separate Points object.
 */

import * as THREE from "three";
import type { ThreeEffect } from "./types";

interface Debris {
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	/** Packed RGB as 0xRRGGBB */
	color: number;
}

const DURATION = 1.5;
const CORE_DURATION = 0.3;
const SQRT6 = Math.sqrt(6);
const MAX_DEBRIS = 24;

// Billboard quaternion: orient plane to face the isometric camera.
// Camera looks along (1,1,1). Plane default normal is +Z.
// Rotate +Z to face camera direction (-1,-1,-1).
const BILLBOARD_QUAT = new THREE.Quaternion().setFromUnitVectors(
	new THREE.Vector3(0, 0, 1),
	new THREE.Vector3(-1, -1, -1).normalize(),
);

const EXPLOSION_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const EXPLOSION_FRAG = `
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uAge;
uniform float uCoreDuration;
uniform float uMaxRadius;
uniform float uPixelsToWorld;
in vec2 vUv;
out vec4 fragColor;

void main() {
    float dist = length(vUv - 0.5) * 2.0;
    // World distance from center (plane half-extent = maxRadius * 1.5)
    float worldDist = dist * uMaxRadius * 1.5;

    vec4 col = vec4(0.0);

    // Smoke cloud (expands slowly, persists longer)
    if (uAge > 0.1) {
        float smokeR = uMaxRadius * (0.2 + uTime * 0.6);
        float smokeAlpha = (1.0 - uTime) * 0.15;
        if (worldDist < smokeR && smokeAlpha > 0.005) {
            col = vec4(0.2, 0.2, 0.2, smokeAlpha);
        }
    }

    // Shockwave ring
    float ringR = uMaxRadius * uTime * 1.5;
    float ringPixelWidth = 2.0 + (1.0 - uTime) * 3.0;
    float ringHalfWidth = ringPixelWidth * uPixelsToWorld * 0.5;
    float ringAlpha = (1.0 - uTime) * 0.4;
    float ringDist = abs(worldDist - ringR);
    if (ringDist < ringHalfWidth && ringAlpha > 0.01 && ringR > 0.1) {
        float ringFade = 1.0 - ringDist / ringHalfWidth;
        col = mix(col, vec4(1.0, 0.533, 0.0, ringAlpha), ringFade);
    }

    // Core flash (bright yellow-white)
    if (uAge < uCoreDuration) {
        float coreT = uAge / uCoreDuration;
        float coreR = uMaxRadius * (0.3 + coreT * 0.4);
        float coreAlpha = 1.0 - coreT * 0.7;
        if (worldDist < coreR) {
            col = vec4(1.0, 0.8, 0.0, coreAlpha);
        }
        // Inner white hot core
        if (worldDist < coreR * 0.4) {
            col = vec4(1.0, 1.0, 1.0, coreAlpha * 0.8);
        }
    }

    if (col.a < 0.003) discard;
    fragColor = col;
    #include <logdepthbuf_fragment>
}
`;

const DEBRIS_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
in float aAlpha;
in float aSize;
in vec3 aColor;
out float vAlpha;
out vec3 vColor;
void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const DEBRIS_FRAG = `
#include <logdepthbuf_pars_fragment>
in float vAlpha;
in vec3 vColor;
out vec4 fragColor;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    fragColor = vec4(vColor, vAlpha);
    #include <logdepthbuf_fragment>
}
`;

export class Explosion implements ThreeEffect {
	alive = true;
	readonly root: THREE.Group;

	private age = 0;
	private debris: Debris[] = [];

	private planeMat: THREE.ShaderMaterial;
	private debrisGeo: THREE.BufferGeometry;

	constructor(x: number, y: number, radius = 60) {
		this.root = new THREE.Group();

		// Billboard plane for core/ring/smoke
		const planeSize = radius * 3; // diameter covers ring at max expansion
		const planeGeo = new THREE.PlaneGeometry(planeSize, planeSize);
		this.planeMat = new THREE.ShaderMaterial({
			vertexShader: EXPLOSION_VERT,
			fragmentShader: EXPLOSION_FRAG,
			uniforms: {
				uTime: { value: 0 },
				uAge: { value: 0 },
				uCoreDuration: { value: CORE_DURATION },
				uMaxRadius: { value: radius },
				uPixelsToWorld: { value: 1 },
			},
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			glslVersion: THREE.GLSL3,
		});
		const planeMesh = new THREE.Mesh(planeGeo, this.planeMat);
		planeMesh.position.set(x, 0.5, y);
		planeMesh.quaternion.copy(BILLBOARD_QUAT);
		this.root.add(planeMesh);

		// Debris particles
		const count = 12 + Math.floor(Math.random() * 8);
		for (let i = 0; i < count && i < MAX_DEBRIS; i++) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 20 + Math.random() * 80;
			this.debris.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				radius: 1 + Math.random() * 3,
				color:
					Math.random() > 0.5
						? 0xff6600
						: Math.random() > 0.5
							? 0xff3300
							: 0x444444,
			});
		}

		const positions = new Float32Array(MAX_DEBRIS * 3);
		const debrisAlphas = new Float32Array(MAX_DEBRIS);
		const debrisSizes = new Float32Array(MAX_DEBRIS);
		const debrisColors = new Float32Array(MAX_DEBRIS * 3);

		this.debrisGeo = new THREE.BufferGeometry();
		this.debrisGeo.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);
		this.debrisGeo.setAttribute(
			"aAlpha",
			new THREE.BufferAttribute(debrisAlphas, 1),
		);
		this.debrisGeo.setAttribute(
			"aSize",
			new THREE.BufferAttribute(debrisSizes, 1),
		);
		this.debrisGeo.setAttribute(
			"aColor",
			new THREE.BufferAttribute(debrisColors, 3),
		);
		this.debrisGeo.setDrawRange(0, 0);

		const debrisMat = new THREE.ShaderMaterial({
			vertexShader: DEBRIS_VERT,
			fragmentShader: DEBRIS_FRAG,
			transparent: true,
			depthWrite: false,
			glslVersion: THREE.GLSL3,
		});

		const debrisPoints = new THREE.Points(this.debrisGeo, debrisMat);
		debrisPoints.frustumCulled = false;
		this.root.add(debrisPoints);

		// Pre-fill debris colors (don't change over lifetime)
		for (let i = 0; i < this.debris.length; i++) {
			const c = this.debris[i].color;
			debrisColors[i * 3] = ((c >> 16) & 0xff) / 255;
			debrisColors[i * 3 + 1] = ((c >> 8) & 0xff) / 255;
			debrisColors[i * 3 + 2] = (c & 0xff) / 255;
		}
		(
			this.debrisGeo.attributes.aColor as THREE.BufferAttribute
		).needsUpdate = true;
	}

	update(dt: number, zoom: number): void {
		this.age += dt;
		if (this.age >= DURATION) {
			this.alive = false;
			return;
		}

		const t = this.age / DURATION;
		const pixelsToWorld = 2 / (zoom * SQRT6);

		// Update plane shader uniforms
		this.planeMat.uniforms.uTime.value = t;
		this.planeMat.uniforms.uAge.value = this.age;
		this.planeMat.uniforms.uPixelsToWorld.value = pixelsToWorld;

		// Move debris
		const drag = 0.95;
		for (const d of this.debris) {
			d.x += d.vx * dt;
			d.y += d.vy * dt;
			d.vx *= drag;
			d.vy *= drag;
		}

		// Update debris buffers
		const posAttr = this.debrisGeo.attributes
			.position as THREE.BufferAttribute;
		const alphaAttr = this.debrisGeo.attributes
			.aAlpha as THREE.BufferAttribute;
		const sizeAttr = this.debrisGeo.attributes
			.aSize as THREE.BufferAttribute;
		const positions = posAttr.array as Float32Array;
		const alphas = alphaAttr.array as Float32Array;
		const sizes = sizeAttr.array as Float32Array;

		const pixelScale = zoom * SQRT6;
		let count = 0;

		for (const d of this.debris) {
			const alpha = (1 - t) * 0.6;
			if (alpha < 0.01) continue;
			const r = d.radius * pixelScale;
			if (r < 0.3) continue;

			const i3 = count * 3;
			positions[i3] = d.x;
			positions[i3 + 1] = 0.3;
			positions[i3 + 2] = d.y;
			alphas[count] = alpha;
			sizes[count] = r * 2;
			count++;
		}

		this.debrisGeo.setDrawRange(0, count);
		posAttr.needsUpdate = true;
		alphaAttr.needsUpdate = true;
		sizeAttr.needsUpdate = true;
	}

	dispose(): void {
		this.root.traverse((obj) => {
			if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
				obj.geometry.dispose();
				if (obj.material instanceof THREE.Material) {
					obj.material.dispose();
				}
			}
		});
	}
}
