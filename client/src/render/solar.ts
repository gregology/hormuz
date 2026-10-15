/**
 * Sun position over the Strait of Hormuz for a real-world instant.
 *
 * The game's time of day follows the real clock in the strait (README:
 * "Time of day matches the real-world time in the Strait of Hormuz").
 * Uses the NOAA solar position approximation — accurate to well under a
 * degree, which is far more than lighting needs.
 */

import { MAP, toLatLon } from "../map/data";

const DEG = Math.PI / 180;

const [STRAIT_LAT, STRAIT_LON] = toLatLon(MAP.center.x, MAP.center.y);

/** Clock offset used for the HUD's "strait time" (Gulf Standard Time, Musandam/UAE side). */
export const STRAIT_UTC_OFFSET_HOURS = 4;

export interface SolarPosition {
	/** Degrees above the horizon (negative = below). */
	elevation: number;
	/** Degrees clockwise from true north. */
	azimuth: number;
}

/** Sun elevation/azimuth for an observer at (latitude, longitude) degrees. */
export function solarPosition(
	date: Date,
	latitude: number,
	longitude: number,
): SolarPosition {
	const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
	const t = (julianDay - 2_451_545) / 36_525;

	const meanLongitude = mod(
		280.46646 + t * (36_000.76983 + t * 0.0003032),
		360,
	);
	const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
	const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

	const m = meanAnomaly * DEG;
	const equationOfCenter =
		Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
		Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
		Math.sin(3 * m) * 0.000289;

	const omega = (125.04 - 1934.136 * t) * DEG;
	const apparentLongitude =
		(meanLongitude + equationOfCenter - 0.00569 - 0.00478 * Math.sin(omega)) *
		DEG;

	const meanObliquity =
		23 +
		(26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
	const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;

	const declination = Math.asin(
		Math.sin(obliquity) * Math.sin(apparentLongitude),
	);

	const y = Math.tan(obliquity / 2) ** 2;
	const l0 = meanLongitude * DEG;
	const equationOfTimeMinutes =
		(4 / DEG) *
		(y * Math.sin(2 * l0) -
			2 * eccentricity * Math.sin(m) +
			4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
			0.5 * y * y * Math.sin(4 * l0) -
			1.25 * eccentricity * eccentricity * Math.sin(2 * m));

	const utcMinutes =
		date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
	const trueSolarMinutes = mod(
		utcMinutes + equationOfTimeMinutes + 4 * longitude,
		1440,
	);
	const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;

	const lat = latitude * DEG;
	const sinElevation =
		Math.sin(lat) * Math.sin(declination) +
		Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
	const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));

	const azimuthFromSouth = Math.atan2(
		Math.sin(hourAngle),
		Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat),
	);

	return {
		elevation: elevation / DEG,
		azimuth: mod(azimuthFromSouth / DEG + 180, 360),
	};
}

/** Sun position as seen from the centre of the strait. */
export function straitSolarPosition(date: Date): SolarPosition {
	return solarPosition(date, STRAIT_LAT, STRAIT_LON);
}

/**
 * Unit vector pointing from the ground towards the sun, in Three.js world
 * axes (X = east, Y = up, Z = south).
 */
export function sunDirection(
	position: SolarPosition,
): [number, number, number] {
	const el = position.elevation * DEG;
	const az = position.azimuth * DEG;
	return [
		Math.sin(az) * Math.cos(el),
		Math.sin(el),
		-Math.cos(az) * Math.cos(el),
	];
}

/** Wall-clock time in the strait as "HH:MM". */
export function formatStraitTime(date: Date): string {
	const local = new Date(date.getTime() + STRAIT_UTC_OFFSET_HOURS * 3_600_000);
	const hours = String(local.getUTCHours()).padStart(2, "0");
	const minutes = String(local.getUTCMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

/** The instant on `date`'s strait-local calendar day at the given strait-local hour. */
export function atStraitHour(date: Date, hour: number): Date {
	const offsetMs = STRAIT_UTC_OFFSET_HOURS * 3_600_000;
	const local = new Date(date.getTime() + offsetMs);
	const midnightLocalAsUtc = Date.UTC(
		local.getUTCFullYear(),
		local.getUTCMonth(),
		local.getUTCDate(),
	);
	return new Date(midnightLocalAsUtc - offsetMs + hour * 3_600_000);
}

function mod(value: number, modulus: number): number {
	return ((value % modulus) + modulus) % modulus;
}
