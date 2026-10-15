/**
 * Scene lighting and atmosphere driven by the real time of day in the
 * strait: sun + moon directional lights, sky-coloured ambient, a physical
 * sky (background for perspective cameras, reflections for everything),
 * view-fitted sun shadows, and horizon fog.
 *
 * Custom materials read the shared `lightingUniforms` (e.g. ship windows
 * glow when `artificialLights` rises at dusk).
 */

import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import {
	distance,
	float,
	fog,
	max,
	min,
	positionWorld,
	smoothstep,
	uniform,
	vec3,
	vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { type DaylightState, daylightFor } from "./daylight";
import { straitSolarPosition, sunDirection } from "./solar";

/** Lighting state shared with custom TSL materials. */
export const lightingUniforms = {
	/** 0 = deep night, 1 = full day. */
	daylight: uniform(1),
	/** 0..1 glow strength for windows, navigation lights, cabin lights. */
	artificialLights: uniform(0),
};

/** Moonlight comes from high in the south-east (phase and orbit are not modelled). */
const MOON_DIRECTION = new THREE.Vector3(0.45, 0.75, 0.48).normalize();

/** Minimum change in sun direction (radians) before re-baking sky reflections. */
const ENVIRONMENT_REBAKE_ANGLE = 0.004;

/**
 * Caps on sky radiance. The physical sky's sun disc is ~10⁵× brighter than
 * the sky and overflows half-float buffers (→ Inf → NaN after blurring).
 * Reflections get a low cap because the sun light already draws the glint.
 */
const MAX_BACKGROUND_RADIANCE = 24;
const MAX_REFLECTED_RADIANCE = 2.5;

/** Hazy Gulf air: dust and humidity scatter more than a clear-sky default. */
const SKY_PARAMS = {
	turbidity: 6,
	rayleigh: 1.6,
	mieCoefficient: 0.007,
	mieDirectionalG: 0.82,
	cloudCoverage: 0.18,
	cloudDensity: 0.35,
};

export class Environment {
	readonly sun = new THREE.DirectionalLight(0xffffff, 3);
	readonly moon = new THREE.DirectionalLight(0x9db4ff, 0);
	readonly ambient = new THREE.HemisphereLight(0x8899bb, 0x443322, 1);
	/** Background sky, shown only to perspective cameras. */
	readonly sky = new SkyMesh();

	private readonly renderer: THREE.WebGPURenderer;
	private readonly scene: THREE.Scene;
	private readonly shadowMapSize: number;
	private readonly skyForReflections = new SkyMesh();
	private readonly reflectionScene = new THREE.Scene();
	private readonly pmrem: THREE.PMREMGenerator;
	private environmentTarget: THREE.RenderTarget | null = null;
	private bakedSunDirection = new THREE.Vector3(0, -1, 0);

	private readonly sunDirection = new THREE.Vector3(0, 1, 0);
	private daylightState: DaylightState = daylightFor(45);
	private readonly fogColor = uniform(new THREE.Color(0x9fb3c8));
	private readonly fogCenter = uniform(new THREE.Vector3());
	private readonly fogNear = uniform(1e9);
	private readonly fogFar = uniform(2e9);

	constructor(
		renderer: THREE.WebGPURenderer,
		scene: THREE.Scene,
		shadowMapSize: number,
	) {
		this.renderer = renderer;
		this.scene = scene;
		this.shadowMapSize = shadowMapSize;
		this.pmrem = new THREE.PMREMGenerator(renderer);

		for (const sky of [this.sky, this.skyForReflections]) {
			sky.turbidity.value = SKY_PARAMS.turbidity;
			sky.rayleigh.value = SKY_PARAMS.rayleigh;
			sky.mieCoefficient.value = SKY_PARAMS.mieCoefficient;
			sky.mieDirectionalG.value = SKY_PARAMS.mieDirectionalG;
			sky.cloudCoverage.value = SKY_PARAMS.cloudCoverage;
			sky.cloudDensity.value = SKY_PARAMS.cloudDensity;
			sky.scale.setScalar(450_000);
		}
		clampSkyRadiance(this.sky, MAX_BACKGROUND_RADIANCE);
		clampSkyRadiance(this.skyForReflections, MAX_REFLECTED_RADIANCE);
		this.sky.visible = false;
		this.skyForReflections.scale.setScalar(50);
		this.reflectionScene.add(this.skyForReflections);

		this.sun.castShadow = shadowMapSize > 0;
		if (this.sun.castShadow) {
			this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
		}
		scene.add(
			this.sun,
			this.sun.target,
			this.moon,
			this.moon.target,
			this.ambient,
			this.sky,
		);

		scene.fogNode = fog(
			this.fogColor,
			smoothstep(
				this.fogNear,
				this.fogFar,
				distance(positionWorld.xz, this.fogCenter.xz),
			),
		);
		// Diffuse sky fill for matte surfaces; glossy surfaces (the sea) opt
		// into stronger reflections via `reflections`.
		scene.environmentIntensity = 0.16;
		this.setTime(new Date());
	}

	/** Pre-filtered sky for glossy materials (stable texture; re-baked in place). */
	get reflections(): THREE.Texture {
		return (this.environmentTarget as THREE.RenderTarget).texture;
	}

	get daylight(): DaylightState {
		return this.daylightState;
	}

	/** Set lighting for a real-world instant (the strait's sun position). */
	setTime(date: Date): void {
		const solar = straitSolarPosition(date);
		const [x, y, z] = sunDirection(solar);
		this.sunDirection.set(x, y, z);
		this.daylightState = daylightFor(solar.elevation);
		const d = this.daylightState;

		this.sun.color.setRGB(...d.sunColor);
		this.sun.intensity = d.sunIntensity;
		this.sun.visible = d.sunIntensity > 0.001;
		this.moon.intensity = d.moonIntensity;
		this.moon.visible = d.moonIntensity > 0.001;
		this.ambient.color.setRGB(...d.skyColor);
		this.ambient.groundColor.setRGB(...d.groundColor);
		this.ambient.intensity = d.ambientIntensity;
		this.renderer.toneMappingExposure = d.exposure;
		lightingUniforms.daylight.value = d.daylight;
		lightingUniforms.artificialLights.value = d.artificialLights;

		this.fogColor.value.setRGB(
			d.skyColor[0] * 0.9 + 0.08 * d.daylight,
			d.skyColor[1] * 0.9 + 0.06 * d.daylight,
			d.skyColor[2] * 0.9 + 0.03 * d.daylight,
		);

		for (const sky of [this.sky, this.skyForReflections]) {
			sky.sunPosition.value.copy(this.sunDirection);
		}
		if (
			this.sunDirection.angleTo(this.bakedSunDirection) >
			ENVIRONMENT_REBAKE_ANGLE
		) {
			this.bakeReflections();
		}
	}

	/**
	 * Fit lights, shadows and fog to the current view. `focus` is the ground
	 * point at the centre of attention and `radius` the visible ground
	 * radius around it.
	 */
	frame(
		focus: THREE.Vector3,
		radius: number,
		perspective: THREE.PerspectiveCamera | null,
	): void {
		this.sky.visible = perspective !== null;
		if (perspective) {
			this.fogCenter.value.copy(perspective.position);
			this.fogNear.value = 6000;
			this.fogFar.value = 60_000;
		} else {
			this.fogNear.value = 1e9;
			this.fogFar.value = 2e9;
		}

		const reach = radius + 2000;
		this.placeLight(this.moon, MOON_DIRECTION, focus, reach);
		this.placeLight(this.sun, this.sunDirection, focus, reach);
		if (this.sun.castShadow) this.fitShadow(radius, reach);
	}

	dispose(): void {
		this.environmentTarget?.dispose();
		this.pmrem.dispose();
		this.sun.shadow.dispose();
	}

	private placeLight(
		light: THREE.DirectionalLight,
		direction: THREE.Vector3,
		focus: THREE.Vector3,
		reach: number,
	): void {
		light.target.position.copy(focus);
		light.position.copy(focus).addScaledVector(direction, reach * 2);
		light.target.updateMatrixWorld();
		light.updateMatrixWorld();
	}

	/**
	 * Size the shadow frustum to the visible area so texel density follows
	 * zoom, and snap it to whole texels so shadows don't shimmer as the
	 * camera pans.
	 */
	private fitShadow(radius: number, reach: number): void {
		const shadow = this.sun.shadow;
		const camera = shadow.camera as THREE.OrthographicCamera;
		const halfExtent = Math.max(radius, 50);
		const texel = (2 * halfExtent) / this.shadowMapSize;

		const right = new THREE.Vector3().crossVectors(
			this.sunDirection,
			THREE.Object3D.DEFAULT_UP,
		);
		if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
		right.normalize();
		const up = new THREE.Vector3()
			.crossVectors(right, this.sunDirection)
			.normalize();
		const target = this.sun.target.position;
		const snapRight =
			Math.round(target.dot(right) / texel) * texel - target.dot(right);
		const snapUp = Math.round(target.dot(up) / texel) * texel - target.dot(up);
		target.addScaledVector(right, snapRight).addScaledVector(up, snapUp);
		this.sun.position
			.addScaledVector(right, snapRight)
			.addScaledVector(up, snapUp);
		this.sun.target.updateMatrixWorld();
		this.sun.updateMatrixWorld();

		camera.left = -halfExtent;
		camera.right = halfExtent;
		camera.top = halfExtent;
		camera.bottom = -halfExtent;
		camera.near = 1;
		camera.far = reach * 4;
		camera.updateProjectionMatrix();
		shadow.normalBias = texel * 1.5;
		shadow.bias = -0.0002;
	}

	private bakeReflections(): void {
		this.bakedSunDirection.copy(this.sunDirection);
		this.environmentTarget = this.pmrem.fromScene(
			this.reflectionScene,
			0,
			0.1,
			100,
			{
				size: 128,
				renderTarget: this.environmentTarget,
			},
		);
		this.scene.environment = this.environmentTarget.texture;
	}
}

function clampSkyRadiance(sky: SkyMesh, maxRadiance: number): void {
	const material = sky.material as THREE.NodeMaterial;
	if (material.colorNode) {
		// The physical sky goes black after dusk; keep a faint moonlit floor.
		const nightFloor = vec4(
			vec3(0.012, 0.018, 0.045).mul(float(1).sub(lightingUniforms.daylight)),
			1,
		);
		material.colorNode = max(
			min(
				vec4(material.colorNode),
				vec4(maxRadiance, maxRadiance, maxRadiance, 1),
			),
			nightFloor,
		);
	}
	// The sky is infinitely far away; horizon fog is applied by the scene instead.
	material.fog = false;
}

/** Visible ground radius below an isometric camera with the given frustum half-size. */
export function isometricGroundRadius(
	halfWidth: number,
	halfHeight: number,
): number {
	// Screen-vertical maps to the ground foreshortened by the 35.26° view
	// elevation, i.e. stretched by √3.
	return Math.hypot(halfWidth, halfHeight * Math.sqrt(3));
}
