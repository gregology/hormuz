/**
 * Turns VehicleModel part lists (vehicle-models.ts) into a single merged
 * BufferGeometry per model, so each vehicle is one draw call.
 *
 * Paint is baked into vertex attributes and resolved by the shared vehicle
 * material (vehicle-material.ts):
 *   color   (vec3)  fixed albedo, linear
 *   slot    (float) palette slot index, 0 = use `color`
 *   surface (vec2)  roughness, metalness
 *   glow    (vec3)  night-time emission, linear
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
	type HullSpec,
	type Paint,
	type PaletteSlot,
	type Part,
	type VehicleModel,
	deckHeightAt,
	halfBeamAt,
} from "./vehicle-models";

/** Palette slot order; index + 1 is the value stored in the `slot` attribute. */
export const PALETTE_SLOTS: readonly PaletteSlot[] = [
	"hull",
	"bottom",
	"deck",
	"house",
	"funnel",
	"band",
];

const HULL_STATIONS = 44;

export function buildModelGeometry(model: VehicleModel): THREE.BufferGeometry {
	const pieces: THREE.BufferGeometry[] = [];
	for (const part of model.parts) {
		for (const [geometry, paint] of partGeometries(part)) {
			pieces.push(painted(geometry, paint));
		}
	}
	const merged = mergeGeometries(pieces);
	for (const piece of pieces) piece.dispose();
	if (!merged) throw new Error("vehicle geometry: incompatible parts");
	merged.computeBoundingSphere();
	merged.computeBoundingBox();
	return merged;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function partGeometries(part: Part): [THREE.BufferGeometry, Paint][] {
	switch (part.kind) {
		case "hull":
			return hullGeometries(part.spec);
		case "box":
			return boxGeometries(part);
		case "cylinder": {
			const from = new THREE.Vector3(...part.from);
			const to = new THREE.Vector3(...part.to);
			const length = from.distanceTo(to);
			const geometry = new THREE.CylinderGeometry(
				part.radiusTo ?? part.radius,
				part.radius,
				length,
				part.segments ?? 12,
			);
			geometry.applyQuaternion(
				new THREE.Quaternion().setFromUnitVectors(
					new THREE.Vector3(0, 1, 0),
					to.clone().sub(from).normalize(),
				),
			);
			geometry.translate(
				(from.x + to.x) / 2,
				(from.y + to.y) / 2,
				(from.z + to.z) / 2,
			);
			return [[geometry, part.paint]];
		}
		case "sphere": {
			const geometry = new THREE.SphereGeometry(
				part.radius,
				20,
				part.dome ? 8 : 14,
				0,
				Math.PI * 2,
				0,
				part.dome ? Math.PI / 2 : Math.PI,
			);
			if (part.scale) geometry.scale(...part.scale);
			geometry.translate(...part.center);
			return [[geometry, part.paint]];
		}
		case "prism":
			return [[prismGeometry(part.outline, part.base, part.top), part.paint]];
	}
}

/** Box with optional tapered top, yaw and pitch; flat-shaded. */
function boxGeometries(
	part: Extract<Part, { kind: "box" }>,
): [THREE.BufferGeometry, Paint][] {
	const [lx, ly, lz] = part.size;
	const shrink = 1 - (part.taper ?? 0);
	const hx = lx / 2;
	const hy = ly / 2;
	const hz = lz / 2;
	const b = [
		[-hx, -hy, -hz],
		[hx, -hy, -hz],
		[hx, -hy, hz],
		[-hx, -hy, hz],
	];
	const t = b.map(([x, , z]) => [x * shrink, hy, z * shrink]);
	const sides = [
		[b[0], b[1], t[1], t[0]],
		[b[1], b[2], t[2], t[1]],
		[b[2], b[3], t[3], t[2]],
		[b[3], b[0], t[0], t[3]],
		[b[3], b[2], b[1], b[0]],
	];
	const transform = new THREE.Matrix4()
		.makeTranslation(...part.center)
		.multiply(new THREE.Matrix4().makeRotationY(part.yaw ?? 0))
		.multiply(new THREE.Matrix4().makeRotationZ(part.pitch ?? 0));
	const walls = quadsGeometry(sides).applyMatrix4(transform);
	const roof = quadsGeometry([[t[0], t[1], t[2], t[3]]]).applyMatrix4(
		transform,
	);
	return [
		[walls, part.paint],
		[roof, part.top ?? part.paint],
	];
}

/** Flat plan outline [forward, starboard] extruded vertically. */
function prismGeometry(
	outline: readonly (readonly [number, number])[],
	base: number,
	top: number,
): THREE.BufferGeometry {
	const quads: number[][][] = [];
	for (let i = 0; i < outline.length; i++) {
		const [x0, z0] = outline[i];
		const [x1, z1] = outline[(i + 1) % outline.length];
		quads.push([
			[x0, base, z0],
			[x1, base, z1],
			[x1, top, z1],
			[x0, top, z0],
		]);
	}
	const walls = quadsGeometry(quads);
	const capTriangles = THREE.ShapeUtils.triangulateShape(
		outline.map(([x, z]) => new THREE.Vector2(x, z)),
		[],
	);
	const caps: number[] = [];
	for (const [a, b, c] of capTriangles) {
		for (const y of [base, top]) {
			for (const i of y === top ? [a, b, c] : [c, b, a]) {
				caps.push(outline[i][0], y, outline[i][1]);
			}
		}
	}
	const capGeometry = new THREE.BufferGeometry();
	capGeometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(caps, 3),
	);
	capGeometry.computeVertexNormals();
	const merged = mergeGeometries([walls, capGeometry]);
	walls.dispose();
	capGeometry.dispose();
	return merged as THREE.BufferGeometry;
}

/** Non-indexed, flat-shaded geometry from quads given as 4 corners each. */
function quadsGeometry(quads: number[][][]): THREE.BufferGeometry {
	const positions: number[] = [];
	for (const [a, b, c, d] of quads) {
		positions.push(...a, ...b, ...c, ...a, ...c, ...d);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3),
	);
	geometry.computeVertexNormals();
	return geometry;
}

// ---------------------------------------------------------------------------
// Hull loft
// ---------------------------------------------------------------------------

/**
 * Loft a hull through cross-sections at stations along its length. Each
 * paint band (topsides, boot-top, bottom, deck, transom) is a separate
 * strip so colour boundaries stay crisp while each band shades smoothly.
 */
function hullGeometries(spec: HullSpec): [THREE.BufferGeometry, Paint][] {
	const stern = spec.stations[0][0];
	const bow = spec.stations[spec.stations.length - 1][0];
	const xs: number[] = [];
	for (let i = 0; i <= HULL_STATIONS; i++) {
		// Cosine spacing: more stations where the hull curves most (bow, stern).
		const t = i / HULL_STATIONS;
		xs.push(stern + (bow - stern) * (0.5 - 0.5 * Math.cos(Math.PI * t)));
	}

	const topsides: number[][][] = [];
	const boot: number[][][] = [];
	const bottom: number[][][] = [];
	const deck: number[][][] = [];

	for (const x of xs) {
		const beam = halfBeamAt(spec.stations, x);
		const deckY = deckHeightAt(spec, x);
		const waterline = beam * (1 - spec.flare);
		const bootY = Math.min(spec.bootTop, deckY * 0.5);
		const atBoot = waterline + (beam - waterline) * (bootY / deckY);
		const t = spec.draft;
		const flat = [
			[waterline * 0.995, -0.45 * t],
			[waterline * 0.93, -0.85 * t],
			[waterline * 0.72, -t],
		];
		const vee = [
			[waterline * 0.86, -0.22 * t],
			[waterline * 0.62, -0.5 * t],
			[waterline * 0.3, -0.8 * t],
		];
		const keelward = flat.map(([z, y], i) => [
			z + (vee[i][0] - z) * spec.deadrise,
			y + (vee[i][1] - y) * spec.deadrise,
		]);

		// Starboard half-profile from deck edge to waterline.
		const upper = [
			[beam, deckY],
			[beam - (beam - waterline) * 0.3, deckY * 0.55 + bootY * 0.45],
			[atBoot, bootY],
		];
		topsides.push(upper.map(([z, y]) => [x, y, z]));
		boot.push([
			[x, bootY, atBoot],
			[x, 0, waterline],
		]);
		const lower = [[waterline, 0], ...keelward, [0, -t]];
		bottom.push([
			...lower.map(([z, y]) => [x, y, z]),
			...lower
				.slice(0, -1)
				.reverse()
				.map(([z, y]) => [x, y, -z]),
		]);
		deck.push([
			[x, deckY, beam],
			[x, deckY + spec.camber * beam, 0],
			[x, deckY, -beam],
		]);
	}

	const mirror = (rows: number[][][]) =>
		rows.map((row) => row.map(([x, y, z]) => [x, y, -z]));

	const transomRing = [
		...topsides[0],
		...boot[0].slice(1),
		...bottom[0].slice(1),
		...mirror([boot[0]])[0].reverse().slice(1),
		...mirror([topsides[0]])[0].reverse().slice(1),
	];

	return [
		[loft(topsides), spec.topsides],
		[loft(mirror(topsides)), spec.topsides],
		[loft(boot), spec.boot],
		[loft(mirror(boot)), spec.boot],
		[loft(bottom), spec.bottom],
		[loft(deck), spec.deck],
		[fan(transomRing), spec.topsides],
	];
}

/** Indexed, smooth-shaded surface through rows of points (one row per station). */
function loft(rows: number[][][]): THREE.BufferGeometry {
	const columns = rows[0].length;
	const positions: number[] = [];
	for (const row of rows) for (const p of row) positions.push(...p);
	const indices: number[] = [];
	for (let r = 0; r < rows.length - 1; r++) {
		for (let c = 0; c < columns - 1; c++) {
			const a = r * columns + c;
			const b = a + columns;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3),
	);
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	return geometry;
}

/** Flat polygon closing a ring of points (the transom). */
function fan(ring: number[][]): THREE.BufferGeometry {
	const centre = ring
		.reduce(
			(sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]],
			[0, 0, 0],
		)
		.map((v) => v / ring.length);
	const positions: number[] = [];
	for (let i = 0; i < ring.length; i++) {
		positions.push(...centre, ...ring[i], ...ring[(i + 1) % ring.length]);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3),
	);
	geometry.computeVertexNormals();
	return geometry;
}

// ---------------------------------------------------------------------------
// Paint attributes
// ---------------------------------------------------------------------------

const _color = new THREE.Color();

/** Non-indexed copy of `geometry` with paint attributes for the shared material. */
function painted(
	geometry: THREE.BufferGeometry,
	paint: Paint,
): THREE.BufferGeometry {
	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	if (flat !== geometry) geometry.dispose();
	for (const name of Object.keys(flat.attributes)) {
		if (name !== "position" && name !== "normal") flat.deleteAttribute(name);
	}
	const count = flat.getAttribute("position").count;

	const slot =
		typeof paint.color === "string"
			? PALETTE_SLOTS.indexOf(paint.color) + 1
			: 0;
	_color.set(typeof paint.color === "number" ? paint.color : 0xffffff);
	const glow = new THREE.Color(paint.glow ?? 0x000000);

	const colors = new Float32Array(count * 3);
	const slots = new Float32Array(count);
	const surfaces = new Float32Array(count * 2);
	const glows = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		colors.set([_color.r, _color.g, _color.b], i * 3);
		slots[i] = slot;
		surfaces.set([paint.roughness, paint.metalness ?? 0], i * 2);
		glows.set([glow.r, glow.g, glow.b], i * 3);
	}
	flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
	flat.setAttribute("slot", new THREE.BufferAttribute(slots, 1));
	flat.setAttribute("surface", new THREE.BufferAttribute(surfaces, 2));
	flat.setAttribute("glow", new THREE.BufferAttribute(glows, 3));
	return flat;
}
