/**
 * GPU textures for the map shaders, built from CPU-side map data.
 */

import * as THREE from "three/webgpu";
import type { CoastField } from "../map/coast-field";
import {
	BATHYMETRY_DATA,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_WIDTH,
} from "../map/heightmap-data";
import { WAVE_TEXTURE_SIZE, createWaveTexturePixels } from "./water-textures";

const toHalf = THREE.DataUtils.toHalfFloat;

/**
 * RGBA half-float: R = signed coast distance in kilometres (+ over water),
 * G/B = charted shallow / very-shallow zones, A = shoals and rocks.
 */
export function createCoastTexture(field: CoastField): THREE.DataTexture {
	const { width, height } = field.grid;
	const data = new Uint16Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = toHalf(field.signedDistance[i] / 1000);
		data[i * 4 + 1] = toHalf(field.shallow[i]);
		data[i * 4 + 2] = toHalf(field.veryShallow[i]);
		data[i * 4 + 3] = toHalf(field.shoal[i]);
	}
	return dataTexture(
		data,
		width,
		height,
		THREE.RGBAFormat,
		THREE.HalfFloatType,
	);
}

/** R half-float: real water depth in metres (0 on land). */
export function createBathymetryTexture(): THREE.DataTexture {
	const data = new Uint16Array(HEIGHTMAP_WIDTH * HEIGHTMAP_HEIGHT);
	for (let i = 0; i < data.length; i++) data[i] = toHalf(BATHYMETRY_DATA[i]);
	return dataTexture(
		data,
		HEIGHTMAP_WIDTH,
		HEIGHTMAP_HEIGHT,
		THREE.RedFormat,
		THREE.HalfFloatType,
	);
}

/** Tiling wave slopes + noise (see water-textures.ts), mipmapped. */
export function createWaveTexture(): THREE.DataTexture {
	const texture = new THREE.DataTexture(
		createWaveTexturePixels(),
		WAVE_TEXTURE_SIZE,
		WAVE_TEXTURE_SIZE,
		THREE.RGBAFormat,
		THREE.UnsignedByteType,
	);
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.anisotropy = 4;
	texture.needsUpdate = true;
	return texture;
}

function dataTexture(
	data: Uint16Array,
	width: number,
	height: number,
	format: THREE.PixelFormat,
	type: THREE.TextureDataType,
): THREE.DataTexture {
	const texture = new THREE.DataTexture(data, width, height, format, type);
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}
