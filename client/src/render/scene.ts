/**
 * Three.js scene bootstrap — renderer, scene, camera.
 *
 * Sets up a WebGL renderer with an OrthographicCamera positioned
 * to produce the same isometric projection as camera.ts:
 *   screen_x = (wx - wy) * cos30 * zoom
 *   screen_y = (wx + wy) * sin30 * zoom - wz * zoom
 *
 * The camera looks from the "above-northeast" direction (1,1,1),
 * with Three.js axes: X = east, Y = up/height, Z = south.
 */

import * as THREE from "three";

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

/**
 * Update an OrthographicCamera to match the game's Camera state.
 *
 * After this call, a Three.js point at (worldX, height, worldY) projects
 * to the same screen pixel as worldToScreen(cam, worldX, worldY) with
 * height offset applied. Usable without a WebGLRenderer (for testing).
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

export class ThreeScene {
	readonly renderer: THREE.WebGLRenderer;
	readonly scene: THREE.Scene;
	readonly camera: THREE.OrthographicCamera;

	constructor(canvas?: HTMLCanvasElement) {
		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			stencil: true,
		});
		this.renderer.setPixelRatio(window.devicePixelRatio);

		this.scene = new THREE.Scene();

		this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, VIEW_DISTANCE * 2);
		this.camera.up.copy(CAMERA_UP);
		this.scene.add(this.camera);
	}

	/** Resize the renderer to match the given screen dimensions. */
	setSize(width: number, height: number): void {
		this.renderer.setSize(width, height);
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
	}

	/** Render one frame. */
	render(): void {
		this.renderer.render(this.scene, this.camera);
	}

	/** Clean up WebGL resources. */
	dispose(): void {
		this.renderer.dispose();
	}
}
