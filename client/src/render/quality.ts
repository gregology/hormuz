/**
 * Render quality tiers. Up to 200 players on anything from phones to
 * desktops share one renderer, so the costly features (shadow maps,
 * bloom, MSAA, high pixel ratios) scale with the device.
 */

export type QualityLevel = "low" | "medium" | "high";

export interface QualitySettings {
	readonly level: QualityLevel;
	readonly maxPixelRatio: number;
	/** Sun shadow map resolution; 0 disables shadows. */
	readonly shadowMapSize: number;
	readonly bloom: boolean;
	readonly antialias: boolean;
}

const SETTINGS: Record<QualityLevel, QualitySettings> = {
	low: {
		level: "low",
		maxPixelRatio: 1,
		shadowMapSize: 0,
		bloom: false,
		antialias: false,
	},
	medium: {
		level: "medium",
		maxPixelRatio: 1.5,
		shadowMapSize: 2048,
		bloom: true,
		antialias: true,
	},
	high: {
		level: "high",
		maxPixelRatio: 2,
		shadowMapSize: 4096,
		bloom: true,
		antialias: true,
	},
};

export function qualitySettings(level: QualityLevel): QualitySettings {
	return SETTINGS[level];
}

/**
 * Pick a tier: `?quality=low|medium|high` wins, otherwise touch devices and
 * low-core machines get medium, everything else high.
 */
export function detectQualityLevel(
	search: string = globalThis.location?.search ?? "",
): QualityLevel {
	const requested = new URLSearchParams(search).get("quality");
	if (requested === "low" || requested === "medium" || requested === "high") {
		return requested;
	}
	const touch = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
	const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
	return touch || cores < 4 ? "medium" : "high";
}
