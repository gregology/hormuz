/**
 * Sinking effect — the destroyed vehicle's own model settles by the bow
 * or stern, lists and slips beneath the opaque sea surface (which hides
 * whatever is underwater), burning and venting bubbles as it goes.
 * Drones drop out of the sky into the sea first.
 */

import type * as THREE from "three";
import { VEHICLE_PHYSICS } from "../generated/vehicles";
import { getElevation } from "../map/heightmap";
import { particleDiameterPixels } from "../render/particles";
import { terrainSurfaceHeight } from "../render/terrain-surface";
import { createVehicleObject } from "../render/vehicle-meshes";
import type { VehicleType } from "../vehicles/physics";
import { type EffectParticles, type ThreeEffect, WIND } from "./types";

interface Puff {
	x: number;
	y: number;
	z: number;
	radius: number;
	age: number;
	life: number;
	rise: number;
}

/** Seconds to go under, by vehicle size: big hulls take their time. */
function sinkDuration(size: number): number {
	if (size >= 150) return 16;
	if (size >= 50) return 11;
	if (size >= 8) return 6;
	return 3;
}

const FALL_TIME = 0.9;

export class Sinking implements ThreeEffect {
	alive = true;
	readonly root: THREE.Group;

	private age = 0;
	private x: number;
	private y: number;
	private heading: number;
	private readonly size: number;
	private readonly airborne: boolean;
	private readonly onLand: boolean;
	private readonly duration: number;
	private readonly startHeight: number;
	private readonly initialDraft: number;
	private readonly initialList: number;
	/** +1 sinks by the stern (bow rises), -1 by the bow. */
	private readonly trimDirection: number;
	private readonly puffs: Puff[] = [];
	private readonly bubbles: Puff[] = [];
	private puffAccum = 0;
	private bubbleAccum = 0;

	constructor(
		x: number,
		y: number,
		heading: number,
		vehicleType: VehicleType,
		entityId: number,
		floodLevel = 0,
		listAngle = 0,
	) {
		this.x = x;
		this.y = y;
		this.heading = heading;
		const physics = VEHICLE_PHYSICS[vehicleType];
		this.size = physics?.size ?? 10;
		this.airborne = physics?.airborne ?? false;
		this.onLand = vehicleType === "truck";
		this.duration = sinkDuration(this.size);
		this.startHeight = this.airborne ? getElevation(x, y) + 30 : 0;
		this.initialDraft = floodLevel * this.size * 0.08;
		this.initialList = listAngle;
		this.trimDirection = entityId % 2 === 0 ? 1 : -1;

		this.root = createVehicleObject(vehicleType, entityId).group;
		this.root.scale.setScalar(this.size);
		this.root.rotation.order = "YZX";
		this.place(0);
	}

	update(dt: number, _zoom: number): void {
		this.age += dt;
		if (this.age >= this.duration) {
			this.alive = false;
			return;
		}
		this.heading += dt * 0.03;
		this.x += Math.cos(this.heading) * dt * this.size * 0.004;
		this.y += Math.sin(this.heading) * dt * this.size * 0.004;
		this.place(this.age / this.duration);

		for (const p of [...this.puffs, ...this.bubbles]) {
			p.age += dt;
			p.y += p.rise * dt;
			p.x += WIND.x * dt * (p.rise > 0 ? 1 : 0);
			p.z += WIND.z * dt * (p.rise > 0 ? 1 : 0);
			p.radius += this.size * 0.02 * dt;
		}
		this.prune(this.puffs);
		this.prune(this.bubbles);
		this.emit(dt);
	}

	drawParticles(particles: EffectParticles, zoom: number): void {
		for (const p of this.puffs) {
			const life = p.age / p.life;
			const pixels = particleDiameterPixels(p.radius, zoom);
			particles.smoke.push(
				p.x,
				p.y,
				p.z,
				pixels,
				0.05,
				0.048,
				0.045,
				(1 - life) * Math.min(1, p.age * 4) * 0.55,
			);
			if (p.age < 0.4) {
				particles.glow.push(
					p.x,
					p.y - p.radius * 0.3,
					p.z,
					pixels * 0.5,
					5,
					1.6,
					0.3,
					(1 - p.age / 0.4) * 0.8,
				);
			}
		}
		for (const b of this.bubbles) {
			const fade = 1 - b.age / b.life;
			particles.spray.push(
				b.x,
				0.15,
				b.z,
				particleDiameterPixels(b.radius, zoom),
				0.85,
				0.92,
				0.95,
				fade * 0.5,
			);
		}
	}

	dispose(): void {
		// Geometry and material are shared with live vehicles.
	}

	private place(t: number): void {
		let height: number;
		if (this.airborne) {
			const fall = Math.min(this.age / FALL_TIME, 1);
			height =
				this.startHeight * (1 - fall * fall) -
				Math.max(0, t - 0.3) * this.size * 0.6;
		} else if (this.onLand) {
			height = terrainSurfaceHeight(this.x, this.y) - t * this.size * 0.4;
		} else {
			// Slow at first as compartments flood, then the hull goes quickly.
			height = -this.initialDraft - t ** 1.6 * this.size * 0.55;
		}
		this.root.position.set(this.x, height, this.y);
		this.root.rotation.y = -this.heading;
		this.root.rotation.z = this.trimDirection * Math.min(t * 1.4, 1) * 0.2;
		this.root.rotation.x = this.initialList * (1 + t * 1.5);
	}

	private emit(dt: number): void {
		const t = this.age / this.duration;
		if (this.airborne && this.age < FALL_TIME) return;
		const cos = Math.cos(this.heading);
		const sin = Math.sin(this.heading);
		const along = () => (Math.random() - 0.5) * this.size * 0.6;

		// Burning while the deck is still above water.
		this.puffAccum +=
			(1 - t) * (this.onLand ? 6 : 10) * dt * (t < 0.65 ? 1 : 0);
		while (this.puffAccum >= 1) {
			this.puffAccum -= 1;
			const offset = along();
			this.puffs.push({
				x: this.x + cos * offset,
				y: Math.max(this.root.position.y + this.size * 0.12, 1),
				z: this.y + sin * offset,
				radius: this.size * (0.04 + Math.random() * 0.04),
				age: 0,
				life: 3 + Math.random() * 3,
				rise: this.size * (0.12 + Math.random() * 0.1),
			});
		}

		if (this.onLand) return;
		this.bubbleAccum += (1 - t) * 14 * dt;
		while (this.bubbleAccum >= 1) {
			this.bubbleAccum -= 1;
			const offset = along();
			const lateral = (Math.random() - 0.5) * this.size * 0.2;
			this.bubbles.push({
				x: this.x + cos * offset - sin * lateral,
				y: 0,
				z: this.y + sin * offset + cos * lateral,
				radius: this.size * (0.01 + Math.random() * 0.02),
				age: 0,
				life: 1 + Math.random(),
				rise: 0,
			});
		}
	}

	private prune(list: Puff[]): void {
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].age >= list[i].life) list.splice(i, 1);
		}
	}
}
