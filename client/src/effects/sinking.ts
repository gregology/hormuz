/**
 * Sinking effect (Three.js) — a destroyed ship tilts and sinks below
 * the waterline.
 *
 * Captures the vehicle's last position, heading, and appearance.
 * Over its lifetime: the hull tilts (bow rises), sinks (Y decreases),
 * fades in opacity, and emits bubble particles.
 */

import * as THREE from "three";
import type { ThreeEffect } from "./types";

interface Bubble {
	x: number;
	y: number;
	/** Upward rise speed in world units/s */
	riseSpeed: number;
	radius: number;
	age: number;
}

const DURATION = 3.0;
const SQRT6 = Math.sqrt(6);
const MAX_BUBBLES = 64;

export class Sinking implements ThreeEffect {
	alive = true;
	readonly root: THREE.Group;

	private age = 0;
	private x: number;
	private y: number;
	private heading: number;
	private size: number;
	private initialFloodLevel: number;
	private initialListAngle: number;
	private bubbles: Bubble[] = [];
	private bubbleAccum = 0;

	private hullMesh: THREE.Mesh;
	private hullMat: THREE.MeshBasicMaterial;
	private strokeLine: THREE.LineLoop;
	private strokeMat: THREE.LineBasicMaterial;
	private bubbleGeo: THREE.BufferGeometry;

	constructor(
		x: number,
		y: number,
		heading: number,
		size: number,
		color: number,
		floodLevel = 0,
		listAngle = 0,
	) {
		this.x = x;
		this.y = y;
		this.heading = heading;
		this.initialFloodLevel = floodLevel;
		this.initialListAngle = listAngle;
		this.size = size;
		this.root = new THREE.Group();

		const halfLen = size * 0.4;
		const halfBeam = size * 0.08;

		// Hull outline (local forward=X, lateral=Y for Shape, rotated to XZ)
		const outline: [number, number][] = [
			[halfLen, 0],
			[halfLen * 0.7, -halfBeam],
			[-halfLen * 0.5, -halfBeam],
			[-halfLen, -halfBeam * 0.5],
			[-halfLen, halfBeam * 0.5],
			[-halfLen * 0.5, halfBeam],
			[halfLen * 0.7, halfBeam],
		];

		// ShapeGeometry for hull fill
		const shape = new THREE.Shape();
		shape.moveTo(outline[0][0], outline[0][1]);
		for (let i = 1; i < outline.length; i++) {
			shape.lineTo(outline[i][0], outline[i][1]);
		}
		const hullGeo = new THREE.ShapeGeometry(shape);
		hullGeo.rotateX(-Math.PI / 2); // XY → XZ plane

		this.hullMat = new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: 0.3,
			side: THREE.DoubleSide,
			depthWrite: false,
		});
		this.hullMesh = new THREE.Mesh(hullGeo, this.hullMat);
		this.root.add(this.hullMesh);

		// Stroke outline
		const linePoints = outline.map(
			([lx, ly]) => new THREE.Vector3(lx, 0.01, ly),
		);
		const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
		this.strokeMat = new THREE.LineBasicMaterial({
			color: 0x000000,
			transparent: true,
			opacity: 0.18,
		});
		this.strokeLine = new THREE.LineLoop(lineGeo, this.strokeMat);
		this.root.add(this.strokeLine);

		// Bubble Points
		const positions = new Float32Array(MAX_BUBBLES * 3);
		const alphas = new Float32Array(MAX_BUBBLES);
		const sizes = new Float32Array(MAX_BUBBLES);

		this.bubbleGeo = new THREE.BufferGeometry();
		this.bubbleGeo.setAttribute(
			"position",
			new THREE.BufferAttribute(positions, 3),
		);
		this.bubbleGeo.setAttribute(
			"aAlpha",
			new THREE.BufferAttribute(alphas, 1),
		);
		this.bubbleGeo.setAttribute(
			"aSize",
			new THREE.BufferAttribute(sizes, 1),
		);
		this.bubbleGeo.setDrawRange(0, 0);

		const bubbleMat = new THREE.ShaderMaterial({
			vertexShader: BUBBLE_VERT,
			fragmentShader: BUBBLE_FRAG,
			transparent: true,
			depthWrite: false,
			glslVersion: THREE.GLSL3,
		});

		const bubblePoints = new THREE.Points(this.bubbleGeo, bubbleMat);
		bubblePoints.frustumCulled = false;
		this.root.add(bubblePoints);

		// Set initial position and rotation
		this.root.position.set(x, 0, y);
		this.root.rotation.order = "YZX";
		this.root.rotation.y = -heading;
	}

	update(dt: number, zoom: number): void {
		this.age += dt;
		if (this.age >= DURATION) {
			this.alive = false;
			return;
		}

		const t = this.age / DURATION;

		// Slowly drift and rotate
		this.heading += dt * 0.1;
		this.x += Math.cos(this.heading) * dt * 0.5;
		this.y += Math.sin(this.heading) * dt * 0.5;

		// Sinking offset — continues from initial flood draft
		const initialDraft = this.initialFloodLevel * this.size * 0.3;
		const additionalSink = t * this.size * 0.3;
		const sinkOffset = initialDraft + additionalSink;

		// Bow tilt stacks on initial list angle
		const bowRise = t * this.size * 0.1;
		const halfLen = this.size * 0.4;
		const tiltAngle = Math.asin(Math.min(bowRise / halfLen, 1));

		this.root.position.set(this.x, -sinkOffset, this.y);
		this.root.rotation.y = -this.heading;
		this.root.rotation.x = this.initialListAngle * (1 - t); // list fades as ship sinks
		this.root.rotation.z = tiltAngle;

		// Hull opacity: (1-t) * 0.6 * 0.5 for fill, (1-t) * 0.6 * 0.3 for stroke
		const alpha = (1 - t) * 0.6;
		this.hullMat.opacity = alpha * 0.5;
		this.strokeMat.opacity = alpha * 0.3;

		// Emit bubbles
		const bubbleRate = (1 - t) * 8;
		this.bubbleAccum += bubbleRate * dt;
		while (this.bubbleAccum >= 1 && this.bubbles.length < MAX_BUBBLES) {
			this.bubbleAccum -= 1;
			const cos = Math.cos(this.heading);
			const sin = Math.sin(this.heading);
			const ox = (Math.random() - 0.5) * this.size * 0.4;
			const oy = (Math.random() - 0.5) * this.size * 0.2;
			this.bubbles.push({
				x: this.x + cos * ox - sin * oy,
				y: this.y + sin * ox + cos * oy,
				riseSpeed: 4 + Math.random() * 8,
				radius: 1 + Math.random() * 2,
				age: 0,
			});
		}

		// Update bubbles
		for (const b of this.bubbles) {
			b.age += dt;
			b.x += (Math.random() - 0.5) * dt * 3;
		}
		this.bubbles = this.bubbles.filter((b) => b.age < 1.5);

		// Rebuild bubble buffers
		const posAttr = this.bubbleGeo.attributes
			.position as THREE.BufferAttribute;
		const alphaAttr = this.bubbleGeo.attributes
			.aAlpha as THREE.BufferAttribute;
		const sizeAttr = this.bubbleGeo.attributes
			.aSize as THREE.BufferAttribute;
		const positions = posAttr.array as Float32Array;
		const alphas = alphaAttr.array as Float32Array;
		const sizes = sizeAttr.array as Float32Array;

		const pixelScale = zoom * SQRT6;
		let count = 0;

		for (const b of this.bubbles) {
			const bubbleAlpha = (1 - b.age / 1.5) * 0.3 * (1 - t);
			if (bubbleAlpha < 0.01) continue;
			const r = b.radius * pixelScale;
			if (r < 0.3) continue;

			const i3 = count * 3;
			positions[i3] = b.x;
			positions[i3 + 1] = b.riseSpeed * b.age; // float upward
			positions[i3 + 2] = b.y;
			alphas[count] = bubbleAlpha;
			sizes[count] = r * 2;
			count++;
		}

		this.bubbleGeo.setDrawRange(0, count);
		posAttr.needsUpdate = true;
		alphaAttr.needsUpdate = true;
		sizeAttr.needsUpdate = true;
	}

	dispose(): void {
		this.root.traverse((obj) => {
			if (
				obj instanceof THREE.Mesh ||
				obj instanceof THREE.Line ||
				obj instanceof THREE.Points
			) {
				obj.geometry.dispose();
				if (obj.material instanceof THREE.Material) {
					obj.material.dispose();
				}
			}
		});
	}
}

// Bubble shaders (same circular point as stern churn but light blue)
const BUBBLE_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
in float aAlpha;
in float aSize;
out float vAlpha;
void main() {
    vAlpha = aAlpha;
    gl_PointSize = aSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const BUBBLE_FRAG = `
#include <logdepthbuf_pars_fragment>
in float vAlpha;
out vec4 fragColor;
void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    fragColor = vec4(0.667, 0.867, 1.0, vAlpha);
    #include <logdepthbuf_fragment>
}
`;
