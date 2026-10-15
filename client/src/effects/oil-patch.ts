/**
 * Oil patch effect — dark spreading oil slick spawned when a ship sinks.
 *
 * A flat disc on the water with organic noise edges, slow radial spread,
 * a thin-film rainbow sheen and gradual fade. Oil calms the surface, so
 * the slick is glossier than the sea around it and catches the sky. Size
 * and duration scale with vehicle type (a loaded VLCC leaves a massive
 * long-lasting slick; a frigate leaves a small fuel patch).
 */

import {
	cos,
	float,
	mix,
	mx_noise_float,
	sin,
	smoothstep,
	uniform,
	uv,
	vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import type { ThreeEffect } from "./types";

/** Height just above water — below wake (0.08) to layer correctly. */
const WATER_Y = 0.03;

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

export class OilPatch implements ThreeEffect {
	alive = true;
	readonly root: THREE.Mesh;
	private age = 0;
	private readonly duration: number;
	private readonly progress = uniform(0);
	private readonly material: THREE.MeshStandardNodeMaterial;

	constructor(x: number, y: number, radius: number, duration: number) {
		this.duration = duration;

		const geo = new THREE.PlaneGeometry(radius * 2, radius * 2);
		geo.rotateX(-Math.PI / 2);

		const t = this.progress;
		const centre = uv().sub(0.5);
		const distance = centre.length().mul(2);
		const direction = centre.normalize();
		const spread = t.mul(0.7).add(0.3);
		const ragged = mx_noise_float(vec3(direction.mul(2.2), t.mul(2.5))).mul(
			0.28,
		);
		const edge = float(1).sub(
			smoothstep(0.35, float(1).add(ragged), distance.div(spread)),
		);
		const fade = float(1).sub(t.mul(t));

		const swirl = mx_noise_float(vec3(centre.mul(9), t.mul(0.6)));
		const film = swirl.mul(2).add(distance.mul(4));
		const rainbow = vec3(cos(film), cos(film.add(2.09)), cos(film.add(4.19)))
			.mul(0.5)
			.add(0.5);
		const sheen = smoothstep(0.2, 0.9, edge)
			.mul(float(1).sub(edge.mul(0.6)))
			.mul(0.12);
		const crude = vec3(0.012, 0.009, 0.006).mul(
			sin(swirl.mul(3)).mul(0.25).add(1),
		);

		this.material = new THREE.MeshStandardNodeMaterial({
			transparent: true,
			depthWrite: false,
		});
		this.material.colorNode = mix(crude, rainbow.mul(0.4), sheen);
		this.material.roughnessNode = float(0.12);
		this.material.metalnessNode = float(0);
		this.material.opacityNode = edge.mul(fade).mul(0.82);

		this.root = new THREE.Mesh(geo, this.material);
		this.root.position.set(x, WATER_Y, y);
		this.root.receiveShadow = true;
		this.root.frustumCulled = false;
	}

	update(dt: number, _zoom: number): void {
		this.age += dt;
		if (this.age >= this.duration) {
			this.alive = false;
			return;
		}
		this.progress.value = this.age / this.duration;
	}

	dispose(): void {
		this.root.geometry.dispose();
		this.material.dispose();
	}
}
