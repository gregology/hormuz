/**
 * Lighting palette as a function of sun elevation.
 *
 * Keyframed rather than physically simulated: the sky model drives
 * reflections, but direct/ambient light is art-directed so night stays
 * playable and dusk reads as dusk.
 */

export type RGB = [number, number, number];

export interface DaylightState {
	/** 0 = deep night, 1 = full day. */
	daylight: number;
	/** 0..1 — how strongly ship windows and navigation lights glow. */
	artificialLights: number;
	sunColor: RGB;
	sunIntensity: number;
	skyColor: RGB;
	groundColor: RGB;
	ambientIntensity: number;
	moonIntensity: number;
	/** Tone-mapping exposure (eye adaptation: brighter at night). */
	exposure: number;
}

interface Keyframe {
	elevation: number;
	sunColor: RGB;
	sunIntensity: number;
	skyColor: RGB;
	groundColor: RGB;
	ambientIntensity: number;
}

// Elevations in degrees, ascending. Colours are linear RGB.
const KEYFRAMES: Keyframe[] = [
	{
		elevation: -18,
		sunColor: [0, 0, 0],
		sunIntensity: 0,
		skyColor: [0.11, 0.15, 0.28],
		groundColor: [0.03, 0.035, 0.05],
		ambientIntensity: 1.1,
	},
	{
		elevation: -6,
		sunColor: [0.6, 0.25, 0.2],
		sunIntensity: 0,
		skyColor: [0.3, 0.26, 0.42],
		groundColor: [0.08, 0.06, 0.07],
		ambientIntensity: 1.0,
	},
	{
		elevation: 0,
		sunColor: [1.0, 0.42, 0.16],
		sunIntensity: 1.1,
		skyColor: [0.5, 0.42, 0.5],
		groundColor: [0.16, 0.11, 0.08],
		ambientIntensity: 0.7,
	},
	{
		elevation: 6,
		sunColor: [1.0, 0.64, 0.36],
		sunIntensity: 2.2,
		skyColor: [0.58, 0.6, 0.7],
		groundColor: [0.22, 0.17, 0.12],
		ambientIntensity: 0.5,
	},
	{
		elevation: 20,
		sunColor: [1.0, 0.86, 0.7],
		sunIntensity: 2.9,
		skyColor: [0.6, 0.66, 0.76],
		groundColor: [0.3, 0.24, 0.17],
		ambientIntensity: 0.4,
	},
	{
		elevation: 50,
		sunColor: [1.0, 0.96, 0.9],
		sunIntensity: 3.2,
		skyColor: [0.6, 0.67, 0.78],
		groundColor: [0.32, 0.26, 0.19],
		ambientIntensity: 0.4,
	},
];

export function daylightFor(sunElevation: number): DaylightState {
	const [a, b, t] = bracket(sunElevation);
	const night = 1 - smoothstep(-10, 4, sunElevation);
	return {
		daylight: smoothstep(-8, 10, sunElevation),
		artificialLights: 1 - smoothstep(-4, 5, sunElevation),
		sunColor: lerpRgb(a.sunColor, b.sunColor, t),
		sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
		skyColor: lerpRgb(a.skyColor, b.skyColor, t),
		groundColor: lerpRgb(a.groundColor, b.groundColor, t),
		ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, t),
		moonIntensity: 0.6 * night,
		exposure: lerp(1.0, 1.5, night),
	};
}

function bracket(elevation: number): [Keyframe, Keyframe, number] {
	const first = KEYFRAMES[0];
	const last = KEYFRAMES[KEYFRAMES.length - 1];
	if (elevation <= first.elevation) return [first, first, 0];
	if (elevation >= last.elevation) return [last, last, 0];
	for (let i = 0; i < KEYFRAMES.length - 1; i++) {
		const a = KEYFRAMES[i];
		const b = KEYFRAMES[i + 1];
		if (elevation <= b.elevation) {
			const t = (elevation - a.elevation) / (b.elevation - a.elevation);
			return [a, b, t * t * (3 - 2 * t)];
		}
	}
	return [last, last, 0];
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}
