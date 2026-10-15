/**
 * Three.js scene bootstrap — WebGPU renderer, scene, cameras, lighting
 * environment and the post-processing pipeline.
 *
 * Uses three's WebGPURenderer, which falls back to WebGL2 automatically
 * where WebGPU is unavailable. All materials are node materials (TSL), so
 * lights, shadows, fog and logarithmic depth apply to them without any
 * per-shader plumbing.
 *
 * The OrthographicCamera produces the same isometric projection as
 * camera.ts:
 *   screen_x = (wx - wy) * cos30 * zoom
 *   screen_y = (wx + wy) * sin30 * zoom - wz * zoom
 *
 * The camera looks from the "above-southeast" direction (1,1,1),
 * with Three.js axes: X = east, Y = up/height, Z = south.
 */

import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { float, pass, smoothstep, uv, vec2, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import { Environment, isometricGroundRadius } from "./environment";
import {
	type QualityLevel,
	type QualitySettings,
	detectQualityLevel,
	qualitySettings,
} from "./quality";

/** Distance from camera to target along the view direction. */
const VIEW_DISTANCE = 50000;

const VIEW_DIR = new THREE.Vector3(1, 1, 1).normalize();
const CAMERA_UP = new THREE.Vector3(-1, 2, -1).normalize();

/**
 * The frustum half-extents are divided by sqrt(6) to compensate for
 * the non-axis-aligned camera orientation. This factor falls out of
 * the math when matching the orthographic projection to the 2D
 * isometric formula (see camera-sync.ts for derivation).
 */
const SQRT6 = Math.sqrt(6);

const BLOOM_STRENGTH = 0.32;
const BLOOM_RADIUS = 0.35;
/** Only HDR highlights bloom: fire, tracers, lights at night, sun glints. */
const BLOOM_THRESHOLD = 0.9;

/**
 * Update an OrthographicCamera to match the game's Camera state.
 *
 * After this call, a Three.js point at (worldX, height, worldY) projects
 * to the same screen pixel as worldToScreen(cam, worldX, worldY) with
 * height offset applied. Usable without a renderer (for testing).
 */
export function syncCamera(
	camera: THREE.OrthographicCamera,
	worldX: number,
	worldY: number,
	zoom: number,
	screenWidth: number,
	screenHeight: number,
): void {
	const halfW = screenWidth / (zoom * SQRT6);
	const halfH = screenHeight / (zoom * SQRT6);

	camera.left = -halfW;
	camera.right = halfW;
	camera.top = halfH;
	camera.bottom = -halfH;

	camera.position.set(
		worldX + VIEW_DIR.x * VIEW_DISTANCE,
		VIEW_DIR.y * VIEW_DISTANCE,
		worldY + VIEW_DIR.z * VIEW_DISTANCE,
	);
	camera.lookAt(worldX, 0, worldY);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld(true);
}

export interface SceneOptions {
	canvas?: HTMLCanvasElement;
	quality?: QualityLevel;
	/** Force the WebGL2 backend even where WebGPU is available. */
	forceWebGL?: boolean;
}

export class ThreeScene {
	readonly renderer: THREE.WebGPURenderer;
	readonly scene: THREE.Scene;
	readonly camera: THREE.OrthographicCamera;
	readonly perspCamera: THREE.PerspectiveCamera;
	readonly environment: Environment;
	readonly quality: QualitySettings;

	private readonly pipeline: THREE.RenderPipeline;
	private readonly scenePass: ReturnType<typeof pass>;
	private readonly focus = new THREE.Vector3();
	private isoGroundRadius = 1000;

	/** Create the renderer and wait for the GPU backend to initialise. */
	static async create(options: SceneOptions = {}): Promise<ThreeScene> {
		const quality = qualitySettings(options.quality ?? detectQualityLevel());
		const forceWebGL =
			options.forceWebGL ??
			new URLSearchParams(globalThis.location?.search ?? "").has("webgl");
		const renderer = new THREE.WebGPURenderer({
			canvas: options.canvas,
			antialias: quality.antialias,
			logarithmicDepthBuffer: true,
			forceWebGL,
		});
		await renderer.init();
		return new ThreeScene(renderer, quality);
	}

	private constructor(
		renderer: THREE.WebGPURenderer,
		quality: QualitySettings,
	) {
		this.renderer = renderer;
		this.quality = quality;
		renderer.setPixelRatio(
			Math.min(window.devicePixelRatio, quality.maxPixelRatio),
		);
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.shadowMap.enabled = quality.shadowMapSize > 0;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x0a1628);

		this.camera = new THREE.OrthographicCamera(
			-1,
			1,
			1,
			-1,
			1,
			VIEW_DISTANCE * 2,
		);
		this.camera.up.copy(CAMERA_UP);
		this.scene.add(this.camera);

		this.perspCamera = new THREE.PerspectiveCamera(60, 1, 1, 150000);
		this.scene.add(this.perspCamera);

		this.environment = new Environment(
			renderer,
			this.scene,
			quality.shadowMapSize,
		);

		this.scenePass = pass(this.scene, this.camera);
		const color = this.scenePass.getTextureNode("output");
		const lit = quality.bloom
			? color.add(bloom(color, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD))
			: color;
		const edge = uv().sub(0.5).mul(vec2(1.0, 0.8)).length();
		const vignette = float(1).sub(smoothstep(0.45, 0.95, edge).mul(0.28));
		this.pipeline = new THREE.RenderPipeline(renderer);
		this.pipeline.outputNode = vec4(lit.rgb.mul(vignette), lit.a);
	}

	/** Resize the renderer to match the given screen dimensions. */
	setSize(width: number, height: number): void {
		this.renderer.setSize(width, height);
		this.perspCamera.aspect = width / height;
		this.perspCamera.updateProjectionMatrix();
	}

	/** Sync camera to match game Camera state. */
	syncCamera(
		worldX: number,
		worldY: number,
		zoom: number,
		screenWidth: number,
		screenHeight: number,
	): void {
		syncCamera(this.camera, worldX, worldY, zoom, screenWidth, screenHeight);
		this.focus.set(worldX, 0, worldY);
		this.isoGroundRadius = isometricGroundRadius(
			screenWidth / (zoom * SQRT6),
			screenHeight / (zoom * SQRT6),
		);
	}

	/** Render one frame using the orthographic camera. */
	render(): void {
		this.environment.frame(this.focus, this.isoGroundRadius, null);
		this.scenePass.camera = this.camera;
		this.pipeline.render();
	}

	/** Render one frame using a perspective camera (defaults to `perspCamera`). */
	renderPerspective(camera: THREE.PerspectiveCamera = this.perspCamera): void {
		const forward = camera.getWorldDirection(new THREE.Vector3());
		const height = Math.max(camera.position.y, 1);
		// Shadows matter near the camera; follow the point it looks at.
		const along =
			forward.y < -0.05
				? Math.min(height / -forward.y, height * 6)
				: height * 6;
		this.focus.copy(camera.position).addScaledVector(forward, along).setY(0);
		this.environment.frame(
			this.focus,
			Math.min(Math.max(along * 1.5, 400), 12000),
			camera,
		);
		this.scenePass.camera = camera;
		this.pipeline.render();
	}

	/** Clean up GPU resources. */
	dispose(): void {
		this.environment.dispose();
		this.pipeline.dispose();
		this.renderer.dispose();
	}
}
