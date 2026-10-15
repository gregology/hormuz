/**
 * Screen-facing particle sprites in one instanced draw call.
 *
 * WebGPU has no point size, so sized points are instanced sprites. Fill
 * the batch each frame with push() and finish with commit(); sizes are in
 * screen pixels, colours are linear RGB (HDR values > 1 bloom).
 */

import {
	float,
	instancedBufferAttribute,
	pow,
	smoothstep,
	uv,
	vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { lightingUniforms } from "./environment";

/** On-screen diameter in pixels of a world-space sphere of `radius` at this zoom. */
export function particleDiameterPixels(radius: number, zoom: number): number {
	// The isometric frustum spans 2·width/(zoom·√6) world units across the screen.
	return radius * zoom * Math.sqrt(6);
}

export interface ParticleBatchOptions {
	/** "disc" = hard-edged dot, "soft" = smoke puff, "glow" = bright core with halo. */
	shape: "disc" | "soft" | "glow";
	additive?: boolean;
	/** Dim with the time of day (smoke, spray) rather than emitting light (fire, lamps). */
	daylit?: boolean;
	renderOrder?: number;
}

export class ParticleBatch {
	readonly object: THREE.Sprite;
	private readonly positions: THREE.InstancedBufferAttribute;
	private readonly sizes: THREE.InstancedBufferAttribute;
	private readonly colors: THREE.InstancedBufferAttribute;
	private readonly material: THREE.PointsNodeMaterial;
	private count = 0;

	constructor(
		readonly capacity: number,
		options: ParticleBatchOptions,
	) {
		this.positions = new THREE.InstancedBufferAttribute(
			new Float32Array(capacity * 3),
			3,
		);
		this.sizes = new THREE.InstancedBufferAttribute(
			new Float32Array(capacity),
			1,
		);
		this.colors = new THREE.InstancedBufferAttribute(
			new Float32Array(capacity * 4),
			4,
		);
		for (const attribute of [this.positions, this.sizes, this.colors]) {
			attribute.setUsage(THREE.DynamicDrawUsage);
		}

		const rgba = instancedBufferAttribute<"vec4">(this.colors, "vec4");
		const radius = uv().sub(0.5).length().mul(2);
		const falloff =
			options.shape === "disc"
				? float(1).sub(smoothstep(0.8, 1, radius))
				: options.shape === "soft"
					? pow(float(1).sub(radius).clamp(0, 1), 1.6)
					: pow(float(1).sub(radius).clamp(0, 1), 3).add(
							float(1).sub(smoothstep(0, 0.25, radius)),
						);

		this.material = new THREE.PointsNodeMaterial({
			transparent: true,
			depthWrite: false,
			sizeAttenuation: false,
			blending: options.additive
				? THREE.AdditiveBlending
				: THREE.NormalBlending,
		});
		this.material.positionNode = instancedBufferAttribute<"vec3">(
			this.positions,
			"vec3",
		);
		this.material.sizeNode = instancedBufferAttribute<"float">(
			this.sizes,
			"float",
		);
		this.material.colorNode = options.daylit
			? rgba.rgb.mul(lightingUniforms.daylight.mul(0.85).add(0.15))
			: vec3(rgba.rgb);
		this.material.opacityNode = rgba.a.mul(falloff);

		this.object = new THREE.Sprite(this.material);
		this.object.count = 0;
		this.object.frustumCulled = false;
		this.object.renderOrder = options.renderOrder ?? 0;
	}

	/** Start a new frame of particles. */
	clear(): void {
		this.count = 0;
	}

	/** Add a particle; ignored once the batch is full. */
	push(
		x: number,
		y: number,
		z: number,
		sizePixels: number,
		r: number,
		g: number,
		b: number,
		alpha: number,
	): void {
		if (this.count >= this.capacity) return;
		const i = this.count++;
		(this.positions.array as Float32Array).set([x, y, z], i * 3);
		(this.sizes.array as Float32Array)[i] = sizePixels;
		(this.colors.array as Float32Array).set([r, g, b, alpha], i * 4);
	}

	/** Upload this frame's particles. */
	commit(): void {
		this.object.count = this.count;
		this.object.visible = this.count > 0;
		for (const attribute of [this.positions, this.sizes, this.colors]) {
			attribute.clearUpdateRanges();
			attribute.addUpdateRange(0, this.count * attribute.itemSize);
			attribute.needsUpdate = true;
		}
	}

	dispose(): void {
		// Sprite geometry is shared by every THREE.Sprite; only the material is ours.
		this.material.dispose();
	}
}
