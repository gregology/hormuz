/**
 * Procedural, tileable textures for the sea surface, generated once at
 * startup (no image assets to ship).
 *
 * Channels of the wave texture:
 *   R, G — surface slope along X and Z (0.5 = flat), from a sum of
 *          periodic wind waves travelling roughly south-east (the shamal
 *          blows from the north-west)
 *   B    — smooth fractal noise (large-scale variation, wind slicks)
 *   A    — fine fractal noise (foam breakup)
 */

export const WAVE_TEXTURE_SIZE = 256;

/** Wind waves travel towards the south-east (+X, +Z). */
const WIND_ANGLE = Math.PI / 4;
const WAVE_COUNT = 56;

export function createWaveTexturePixels(size = WAVE_TEXTURE_SIZE): Uint8Array {
	const random = mulberry32(0x5eaf00d);
	const slopeX = new Float32Array(size * size);
	const slopeZ = new Float32Array(size * size);

	for (let w = 0; w < WAVE_COUNT; w++) {
		const magnitude = 3 + random() ** 1.6 * 34;
		const angle = WIND_ANGLE + (random() - 0.5) * 2.4;
		// Integer wave vectors keep every wave periodic over the tile.
		const kx = Math.round(Math.cos(angle) * magnitude);
		const kz = Math.round(Math.sin(angle) * magnitude);
		if (kx === 0 && kz === 0) continue;
		const k = Math.hypot(kx, kz);
		const amplitude = 1 / k ** 1.7;
		const phase = random() * Math.PI * 2;
		for (let row = 0; row < size; row++) {
			for (let col = 0; col < size; col++) {
				const theta = (2 * Math.PI * (kx * col + kz * row)) / size + phase;
				const c = Math.cos(theta) * amplitude * 2 * Math.PI;
				slopeX[row * size + col] += c * kx;
				slopeZ[row * size + col] += c * kz;
			}
		}
	}

	let maxSlope = 0;
	for (let i = 0; i < slopeX.length; i++) {
		maxSlope = Math.max(maxSlope, Math.abs(slopeX[i]), Math.abs(slopeZ[i]));
	}

	const broad = periodicFbm(size, 4, 4, mulberry32(0xb10b));
	const fine = periodicFbm(size, 16, 4, mulberry32(0xf0a3));

	const pixels = new Uint8Array(size * size * 4);
	for (let i = 0; i < size * size; i++) {
		pixels[i * 4] = toByte(slopeX[i] / maxSlope / 2 + 0.5);
		pixels[i * 4 + 1] = toByte(slopeZ[i] / maxSlope / 2 + 0.5);
		pixels[i * 4 + 2] = toByte(broad[i]);
		pixels[i * 4 + 3] = toByte(fine[i]);
	}
	return pixels;
}

/** Fractal value noise that wraps seamlessly at the tile edges, normalised to 0..1. */
function periodicFbm(
	size: number,
	baseCells: number,
	octaves: number,
	random: () => number,
): Float32Array {
	const out = new Float32Array(size * size);
	let amplitude = 1;
	let cells = baseCells;
	for (let octave = 0; octave < octaves; octave++) {
		const lattice = Float32Array.from({ length: cells * cells }, () =>
			random(),
		);
		for (let row = 0; row < size; row++) {
			const gy = (row / size) * cells;
			const y0 = Math.floor(gy);
			const fy = smooth(gy - y0);
			for (let col = 0; col < size; col++) {
				const gx = (col / size) * cells;
				const x0 = Math.floor(gx);
				const fx = smooth(gx - x0);
				const a = lattice[(y0 % cells) * cells + (x0 % cells)];
				const b = lattice[(y0 % cells) * cells + ((x0 + 1) % cells)];
				const c = lattice[((y0 + 1) % cells) * cells + (x0 % cells)];
				const d = lattice[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
				const top = a + (b - a) * fx;
				const bottom = c + (d - c) * fx;
				out[row * size + col] += (top + (bottom - top) * fy) * amplitude;
			}
		}
		amplitude *= 0.5;
		cells *= 2;
	}

	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const v of out) {
		min = Math.min(min, v);
		max = Math.max(max, v);
	}
	for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / (max - min);
	return out;
}

function smooth(t: number): number {
	return t * t * (3 - 2 * t);
}

function toByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/** Small deterministic PRNG so every client generates identical textures. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
