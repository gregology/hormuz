/**
 * Explosion effect — a turbulent HDR fireball that cools into smoke, a
 * shockwave ring across the surface, hot fragments, a column of spray
 * when it happens on water, and a smoke cloud that drifts downwind.
 *
 * The fireball is a camera-facing sprite (works for every camera mode);
 * fragments, spray and smoke go into the shared particle batches.
 */

import {
	float,
	mix,
	mx_noise_float,
	pow,
	smoothstep,
	uniform,
	uv,
	vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { isLand } from "../map/terrain";
import { particleDiameterPixels } from "../render/particles";
import { terrainSurfaceHeight } from "../render/terrain-surface";
import { type EffectParticles, type ThreeEffect, WIND } from "./types";

const FIREBALL_DURATION = 1.4;
const SHOCKWAVE_DURATION = 1.2;

interface Particle {
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	radius: number;
	age: number;
	life: number;
}

const LAND_SHOCKWAVE = new THREE.Color(0xc9b48a);
const WATER_SHOCKWAVE = new THREE.Color(0xe8f0f0);

interface SharedLook {
	fireball: THREE.SpriteNodeMaterial;
	shockwave: THREE.MeshBasicNodeMaterial;
	ring: THREE.BufferGeometry;
}

let sharedLook: SharedLook | null = null;

/**
 * One fireball and one shockwave material for every explosion. Building a
 * node material's shader takes ~25 ms on the main thread, and a fight
 * spawns several explosions a second, so per-explosion materials made the
 * frame rate collapse. Each object's progress, opacity and colour come from
 * its userData instead.
 */
function look(): SharedLook {
	if (sharedLook) return sharedLook;

	const t = uniform(0).onObjectUpdate(
		({ object }) => object?.userData.progress as number,
	);

	// --- Fireball: turbulent, white-hot core cooling to dark smoke ---
	const centre = uv().sub(0.5);
	const distance = centre.length().mul(2);
	const turbulence = mx_noise_float(vec3(centre.mul(5.5), t.mul(2.5)));
	const extent = mix(float(0.35), float(1), pow(t, 0.4));
	const body = float(1).sub(
		smoothstep(extent.mul(0.55), extent, distance.add(turbulence.mul(0.2))),
	);
	const heat = float(1)
		.sub(smoothstep(0, extent.mul(0.75), distance.add(turbulence.mul(0.12))))
		.mul(float(1).sub(t));
	const flame = mix(vec3(0.85, 0.2, 0.03), vec3(1, 0.85, 0.5), heat);
	const intensity = pow(float(1).sub(t), 2).mul(6).add(0.8);
	const smoky = smoothstep(0.3, 0.85, t);
	const fireball = new THREE.SpriteNodeMaterial({
		transparent: true,
		depthWrite: false,
	});
	fireball.colorNode = mix(
		flame.mul(intensity),
		vec3(0.05, 0.045, 0.04),
		smoky,
	);
	fireball.opacityNode = body.mul(float(1).sub(smoothstep(0.75, 1, t)));

	// --- Shockwave across the water / ground ---
	const ring = new THREE.RingGeometry(0.9, 1, 64);
	ring.rotateX(-Math.PI / 2);
	const shockwave = new THREE.MeshBasicNodeMaterial({
		transparent: true,
		depthWrite: false,
	});
	shockwave.colorNode = uniform(new THREE.Color()).onObjectUpdate(
		({ object }) => object?.userData.color as THREE.Color,
	);
	// Feathered on both edges, broken up like a ring of spray.
	const across = uv().sub(0.5).length().mul(2).sub(0.95).abs().mul(20);
	const ragged = mx_noise_float(vec3(uv().mul(14), t.mul(3)))
		.mul(0.5)
		.add(0.5);
	const opacity = uniform(0).onObjectUpdate(
		({ object }) => object?.userData.opacity as number,
	);
	shockwave.opacityNode = float(1)
		.sub(across.clamp(0, 1))
		.mul(ragged)
		.mul(opacity);

	sharedLook = { fireball, shockwave, ring };
	return sharedLook;
}

export class Explosion implements ThreeEffect {
	alive = true;
	readonly root: THREE.Group;

	private age = 0;
	private readonly surface: number;
	private readonly radius: number;
	private readonly fireball: THREE.Sprite;
	private readonly shockwave: THREE.Mesh;
	private readonly fragments: Particle[] = [];
	private readonly spray: Particle[] = [];
	private readonly smoke: Particle[] = [];

	constructor(x: number, y: number, radius = 60) {
		this.root = new THREE.Group();
		this.radius = radius;
		const onLand = isLand(x, y);
		this.surface = onLand ? terrainSurfaceHeight(x, y) : 0;
		const { fireball, shockwave, ring } = look();

		this.fireball = new THREE.Sprite(fireball);
		this.fireball.userData.progress = 0;
		this.fireball.scale.setScalar(radius * 2.6);
		// Lifted so the sea surface doesn't slice off the bottom of the sprite.
		this.fireball.position.set(x, this.surface + radius * 1.2, y);
		this.fireball.renderOrder = 9;
		this.root.add(this.fireball);

		this.shockwave = new THREE.Mesh(ring, shockwave);
		this.shockwave.userData = {
			progress: 0,
			opacity: 0,
			color: onLand ? LAND_SHOCKWAVE : WATER_SHOCKWAVE,
		};
		this.shockwave.position.set(x, this.surface + 0.4, y);
		this.root.add(this.shockwave);

		// --- Hot fragments ---
		const fragmentCount = 14 + Math.floor(Math.random() * 10);
		for (let i = 0; i < fragmentCount; i++) {
			const angle = Math.random() * Math.PI * 2;
			const outward = radius * (0.8 + Math.random() * 2.2);
			this.fragments.push({
				x,
				y: this.surface + radius * 0.3,
				z: y,
				vx: Math.cos(angle) * outward,
				vy: radius * (1 + Math.random() * 2.5),
				vz: Math.sin(angle) * outward,
				radius: radius * (0.015 + Math.random() * 0.03),
				age: 0,
				life: 0.8 + Math.random() * 1.2,
			});
		}

		// --- Spray column on water ---
		if (!onLand) {
			for (let i = 0; i < 40; i++) {
				const angle = Math.random() * Math.PI * 2;
				const out = radius * Math.random() * 0.8;
				this.spray.push({
					x: x + Math.cos(angle) * radius * 0.2,
					y: 0,
					z: y + Math.sin(angle) * radius * 0.2,
					vx: Math.cos(angle) * out,
					vy: radius * (2 + Math.random() * 2.5),
					vz: Math.sin(angle) * out,
					radius: radius * (0.08 + Math.random() * 0.12),
					age: 0,
					life: 1.2 + Math.random() * 0.8,
				});
			}
		}

		// --- Smoke cloud ---
		for (let i = 0; i < 18; i++) {
			const angle = Math.random() * Math.PI * 2;
			const out = radius * Math.random() * 0.6;
			this.smoke.push({
				x: x + Math.cos(angle) * radius * 0.2,
				y: this.surface + radius * (0.3 + Math.random() * 0.6),
				z: y + Math.sin(angle) * radius * 0.2,
				vx: Math.cos(angle) * out + WIND.x,
				vy: radius * (0.25 + Math.random() * 0.4),
				vz: Math.sin(angle) * out + WIND.z,
				radius: radius * (0.25 + Math.random() * 0.25),
				age: -Math.random() * 0.5,
				life: 4 + Math.random() * 3,
			});
		}
	}

	update(dt: number, _zoom: number): void {
		this.age += dt;
		const progress = Math.min(this.age / FIREBALL_DURATION, 1);
		this.fireball.userData.progress = progress;
		this.shockwave.userData.progress = progress;

		const wave = Math.min(this.age / SHOCKWAVE_DURATION, 1);
		this.shockwave.scale.setScalar(this.radius * (0.4 + 3.2 * wave ** 0.6));
		this.shockwave.userData.opacity = (1 - wave) * 0.5;
		this.shockwave.visible = wave < 1;

		const gravity = this.radius * 3;
		for (const p of [...this.fragments, ...this.spray]) {
			p.age += dt;
			p.vy -= gravity * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.z += p.vz * dt;
			p.vx *= 0.97;
			p.vz *= 0.97;
		}
		for (const p of this.smoke) {
			p.age += dt;
			if (p.age < 0) continue;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.z += p.vz * dt;
			p.vx = p.vx * 0.96 + WIND.x * 0.04;
			p.vz = p.vz * 0.96 + WIND.z * 0.04;
			p.vy *= 0.985;
			p.radius += this.radius * 0.25 * dt;
		}

		this.alive =
			this.smoke.some((p) => p.age < p.life) || this.age < FIREBALL_DURATION;
	}

	drawParticles(particles: EffectParticles, zoom: number): void {
		for (const p of this.fragments) {
			if (p.age > p.life || p.y < this.surface) continue;
			const cool = p.age / p.life;
			particles.glow.push(
				p.x,
				p.y,
				p.z,
				Math.max(1.5, particleDiameterPixels(p.radius, zoom)),
				6 * (1 - cool * 0.5),
				2.2 * (1 - cool),
				0.4 * (1 - cool),
				1 - cool,
			);
		}
		for (const p of this.spray) {
			if (p.age > p.life || p.y < -1) continue;
			const fade = 1 - p.age / p.life;
			particles.spray.push(
				p.x,
				p.y,
				p.z,
				particleDiameterPixels(p.radius, zoom),
				0.9,
				0.93,
				0.95,
				fade * 0.7,
			);
		}
		for (const p of this.smoke) {
			if (p.age < 0 || p.age > p.life) continue;
			const life = p.age / p.life;
			const alpha = Math.min(1, p.age * 3) * (1 - life) * 0.6;
			const shade = 0.06 + life * 0.1;
			particles.smoke.push(
				p.x,
				p.y,
				p.z,
				particleDiameterPixels(p.radius, zoom),
				shade,
				shade * 0.95,
				shade * 0.9,
				alpha,
			);
		}
	}

	dispose(): void {
		// The materials and ring geometry are shared by every explosion.
	}
}
