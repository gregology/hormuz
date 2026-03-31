/**
 * Three.js mesh factory for vehicle models.
 *
 * Converts VehicleModel block definitions into ExtrudeGeometry groups with
 * normal-based isometric shading via ShaderMaterial. Each block gets a
 * separate material so faction color can be updated per-entity.
 *
 * Coordinate convention (Three.js local space):
 *   X = forward, Y = height (up), Z = starboard
 *
 * The group's scale is set to the vehicle's size by the renderer,
 * so all coordinates here are in "fraction of size" units.
 */

import * as THREE from "three";
import type { VehicleType } from "../vehicles/physics";
import type { Block, FlatDetail, LP } from "./vehicle-models";
import { getModel } from "./vehicle-models";

// ---------------------------------------------------------------------------
// Block shaders — normal-based isometric shading
// ---------------------------------------------------------------------------

const BLOCK_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
out vec3 vWorldNormal;
void main() {
    vWorldNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
}
`;

const BLOCK_FRAG = `
#include <logdepthbuf_pars_fragment>
uniform vec3 uFactionColor;
uniform vec3 uTopColor;
uniform float uTopAlpha;
uniform float uSideAlpha;
in vec3 vWorldNormal;
out vec4 fragColor;

void main() {
    vec3 n = normalize(vWorldNormal);
    if (n.y > 0.5) {
        fragColor = vec4(uTopColor, uTopAlpha);
    } else if (n.z > abs(n.x)) {
        fragColor = vec4(uFactionColor * 0.45, uSideAlpha);
    } else {
        fragColor = vec4(uFactionColor * 0.65, uSideAlpha);
    }
    #include <logdepthbuf_fragment>
}
`;

// ---------------------------------------------------------------------------
// Geometry creation
// ---------------------------------------------------------------------------

/**
 * Create extruded block geometry from an outline polygon.
 *
 * Uses THREE.ExtrudeGeometry with a coordinate transform:
 * Shape XY (forward, starboard) → Three.js XYZ (forward, height, starboard).
 */
function createBlockGeometry(
	outline: LP[],
	baseHeight: number,
	topHeight: number,
): THREE.BufferGeometry {
	const shape = new THREE.Shape();
	shape.moveTo(outline[0][0], outline[0][1]);
	for (let i = 1; i < outline.length; i++) {
		shape.lineTo(outline[i][0], outline[i][1]);
	}

	const geo = new THREE.ExtrudeGeometry(shape, {
		depth: topHeight - baseHeight,
		bevelEnabled: false,
	});

	// ExtrudeGeometry produces geometry in XY with extrusion along +Z.
	// We need X=forward, Y=height, Z=starboard → swap Y↔Z, offset Y by baseHeight.
	const pos = geo.attributes.position as THREE.BufferAttribute;
	const norm = geo.attributes.normal as THREE.BufferAttribute;
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i);
		const z = pos.getZ(i);
		pos.setY(i, z + baseHeight);
		pos.setZ(i, y);

		const ny = norm.getY(i);
		const nz = norm.getZ(i);
		norm.setY(i, nz);
		norm.setZ(i, ny);
	}

	pos.needsUpdate = true;
	norm.needsUpdate = true;
	geo.computeBoundingSphere();
	geo.computeBoundingBox();

	return geo;
}

// ---------------------------------------------------------------------------
// Material creation
// ---------------------------------------------------------------------------

function createBlockMaterial(block: Block): THREE.ShaderMaterial {
	const hasTopOverride = block.topColor !== undefined;
	const topColor = hasTopOverride
		? new THREE.Color(block.topColor)
		: new THREE.Color(0xffffff);

	return new THREE.ShaderMaterial({
		glslVersion: THREE.GLSL3,
		uniforms: {
			uFactionColor: { value: new THREE.Color(0xffffff) },
			uTopColor: { value: topColor },
			uTopAlpha: { value: block.topAlpha ?? 1 },
			uSideAlpha: { value: block.sideAlpha ?? 1 },
		},
		vertexShader: BLOCK_VERT,
		fragmentShader: BLOCK_FRAG,
		transparent: true,
		side: THREE.DoubleSide,
		depthWrite: true,
	});
}

// ---------------------------------------------------------------------------
// Detail objects (lines and circles)
// ---------------------------------------------------------------------------

function createLineDetail(detail: FlatDetail): THREE.Line {
	const points = [
		new THREE.Vector3(detail.x1 ?? 0, detail.height, detail.y1 ?? 0),
		new THREE.Vector3(detail.x2 ?? 0, detail.height, detail.y2 ?? 0),
	];
	const geo = new THREE.BufferGeometry().setFromPoints(points);
	const mat = new THREE.LineBasicMaterial({
		color: detail.color,
		transparent: true,
		opacity: detail.alpha,
	});
	return new THREE.Line(geo, mat);
}

function createCircleDetail(detail: FlatDetail): THREE.Mesh {
	const geo = new THREE.CircleGeometry(detail.r ?? 0, 16);
	// CircleGeometry is in XY plane — rotate to XZ (lay flat)
	geo.rotateX(-Math.PI / 2);
	const mat = new THREE.MeshBasicMaterial({
		color: detail.color,
		transparent: true,
		opacity: detail.alpha,
		side: THREE.DoubleSide,
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.position.set(detail.cx ?? 0, detail.height, detail.cy ?? 0);
	return mesh;
}

// ---------------------------------------------------------------------------
// Top edge outline
// ---------------------------------------------------------------------------

function createTopOutline(outline: LP[], topHeight: number): THREE.LineLoop {
	// Tiny Y offset to prevent z-fighting with the top face
	const points = outline.map(
		([lx, ly]) => new THREE.Vector3(lx, topHeight + 0.001, ly),
	);
	const geo = new THREE.BufferGeometry().setFromPoints(points);
	const mat = new THREE.LineBasicMaterial({
		color: 0x000000,
		transparent: true,
		opacity: 0.25,
	});
	return new THREE.LineLoop(geo, mat);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a Three.js Group containing all block meshes, details, and outlines
 * for a vehicle type. The group's coordinates are in "fraction of size" units;
 * set group.scale to the vehicle's size to get world units.
 */
export function createVehicleMesh(vehicleType: VehicleType): THREE.Group {
	const model = getModel(vehicleType);
	const group = new THREE.Group();
	const blockMaterials: THREE.ShaderMaterial[] = [];
	const topColorOverrides: boolean[] = [];

	for (const block of model.blocks) {
		const geo = createBlockGeometry(
			block.outline,
			block.baseHeight,
			block.topHeight,
		);
		const mat = createBlockMaterial(block);
		const mesh = new THREE.Mesh(geo, mat);
		group.add(mesh);
		blockMaterials.push(mat);
		topColorOverrides.push(block.topColor !== undefined);

		group.add(createTopOutline(block.outline, block.topHeight));
	}

	for (const detail of model.details) {
		if (detail.kind === "line") {
			group.add(createLineDetail(detail));
		} else {
			group.add(createCircleDetail(detail));
		}
	}

	// Store references for color updates
	group.userData.blockMaterials = blockMaterials;
	group.userData.topColorOverrides = topColorOverrides;

	return group;
}

/** Update the faction color on all block materials in a vehicle group. */
export function setVehicleColor(group: THREE.Group, color: number): void {
	const colorVec = new THREE.Color(color);
	const mats = group.userData.blockMaterials as THREE.ShaderMaterial[];
	const overrides = group.userData.topColorOverrides as boolean[];
	for (let i = 0; i < mats.length; i++) {
		mats[i].uniforms.uFactionColor.value.copy(colorVec);
		if (!overrides[i]) {
			mats[i].uniforms.uTopColor.value.copy(colorVec);
		}
	}
}

/** Dispose all GPU resources owned by a vehicle mesh group. */
export function disposeVehicleMesh(group: THREE.Group): void {
	group.traverse((obj) => {
		if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
			obj.geometry.dispose();
			if (obj.material instanceof THREE.Material) {
				obj.material.dispose();
			}
		}
	});
}
