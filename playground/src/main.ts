import GUI from "lil-gui";
import * as THREE from "three";
import { ThreeEffectManager } from "../../client/src/effects/manager";
import type { EntityState } from "../../client/src/game/entities";
import { MAP } from "../../client/src/map/data";
import { getElevation } from "../../client/src/map/heightmap";
import {
	type Camera,
	createCamera,
	screenToWorld,
} from "../../client/src/render/camera";
import { CiwsController } from "../../client/src/render/ciws-controller";
import { COLORS } from "../../client/src/render/colors";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	ThreeMapRenderer,
} from "../../client/src/render/map-renderer";
import { ThreeScene } from "../../client/src/render/scene";
import { ThreeVehicleRenderer } from "../../client/src/render/vehicle-renderer";
import {
	COLLISION_POLYGONS,
	resolveTerrainCollision,
	resolveVehicleCollisions,
} from "../../client/src/vehicles/collision";
import {
	FLOOD,
	type NavalVehicle,
	type VehicleInput,
	addBreach,
	createVehicle,
	equilibriumSpeed,
	updateFlooding,
	updateVehicle,
} from "../../client/src/vehicles/physics";

const FACTION_COLORS: Record<string, number> = {
	speedboat: COLORS.spawnIran,
	frigate: COLORS.spawnUS,
	tanker: COLORS.spawnTanker,
	truck: 0xeeeeee,
	quadcopter: 0x44cc44,
	shahed: 0xcc4444,
};

interface PlayableVehicle {
	key: string;
	label: string;
	vehicle: NavalVehicle;
	color: number;
	hp: number;
	respawnTimer: number;
}

function init() {
	const screenW = window.innerWidth;
	const screenH = window.innerHeight;

	// ---- Three.js scene ----
	const threeScene = new ThreeScene();
	threeScene.setSize(screenW, screenH);
	document.body.appendChild(threeScene.renderer.domElement);

	// ---- Camera ----
	const cam: Camera = createCamera(screenW, screenH);
	cam.zoom = 0.04;

	// ---- Map (Three.js) ----
	const layers: MapLayers = { ...DEFAULT_LAYERS };
	const threeMap = new ThreeMapRenderer(layers);
	threeScene.scene.add(threeMap.root);

	// ---- Vehicles (Three.js) ----
	const threeVehicles = new ThreeVehicleRenderer();
	threeScene.scene.add(threeVehicles.root);

	// ---- Effects (Three.js) ----
	const threeEffects = new ThreeEffectManager();
	threeScene.scene.add(threeEffects.root);

	// ---- CIWS autocannon controller ----
	const ciwsController = new CiwsController();
	threeScene.scene.add(ciwsController.root);

	// ---- Perspective camera (for first/third-person views) ----
	const perspCamera = new THREE.PerspectiveCamera(
		60,
		screenW / screenH,
		1,
		100000,
	);
	threeScene.scene.add(perspCamera);

	// ---- Collision debug wireframes ----
	// 6 vehicles × 8 edges max × 2 vertices per segment = 96 vertices
	const MAX_COLLISION_VERTS = 96;
	const collisionPositions = new Float32Array(MAX_COLLISION_VERTS * 3);
	const collisionGeo = new THREE.BufferGeometry();
	collisionGeo.setAttribute(
		"position",
		new THREE.BufferAttribute(collisionPositions, 3),
	);
	collisionGeo.setDrawRange(0, 0);
	const collisionLines = new THREE.LineSegments(
		collisionGeo,
		new THREE.LineBasicMaterial({
			color: 0x00ff00,
			transparent: true,
			opacity: 0.5,
		}),
	);
	collisionLines.renderOrder = 100;
	threeScene.scene.add(collisionLines);

	// ---- Vehicles ----
	const RESPAWN_TIME = 4.0;

	const vehicles: PlayableVehicle[] = [
		{
			key: "speedboat",
			label: "Speedboat",
			vehicle: createVehicle("speedboat", 75746, 42781),
			color: FACTION_COLORS.speedboat,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "frigate",
			label: "Frigate",
			vehicle: createVehicle("frigate", 75540, 43226),
			color: FACTION_COLORS.frigate,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "tanker",
			label: "Oil Tanker",
			vehicle: createVehicle("oil_tanker", 75500, 43000),
			color: FACTION_COLORS.tanker,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "truck",
			label: "Box Truck",
			vehicle: createVehicle("truck", 75698, 42649),
			color: FACTION_COLORS.truck,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "quadcopter",
			label: "Quadcopter",
			vehicle: createVehicle("quadcopter", 75700, 42900),
			color: FACTION_COLORS.quadcopter,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "shahed",
			label: "Shahed Drone",
			vehicle: createVehicle("shahed", 75600, 42850),
			color: FACTION_COLORS.shahed,
			hp: 100,
			respawnTimer: 0,
		},
	];

	const SPAWN_POSITIONS = [
		[75746, 42781],
		[75540, 43226],
		[75500, 43000],
		[75698, 42649],
		[75700, 42900],
		[75600, 42850],
	];

	// Set initial headings (all heading west through the strait)
	for (const pv of vehicles) {
		pv.vehicle.heading = Math.PI;
	}

	let activeIndex = 0;

	function activeVehicle(): NavalVehicle {
		return vehicles[activeIndex].vehicle;
	}

	// Camera starts on active vehicle
	cam.worldX = activeVehicle().x;
	cam.worldY = activeVehicle().y;

	// ---- HUD (DOM overlay) ----
	const hudEl = document.createElement("div");
	Object.assign(hudEl.style, {
		position: "fixed",
		bottom: "0",
		left: "0",
		padding: "10px",
		fontFamily: "monospace",
		fontSize: "14px",
		color: "#aaaaaa",
		pointerEvents: "none",
		textShadow: "1px 1px 2px #000",
		lineHeight: "20px",
	} satisfies Partial<CSSStyleDeclaration>);
	const coordEl = document.createElement("div");
	const boatEl = document.createElement("div");
	hudEl.append(coordEl, boatEl);
	document.body.appendChild(hudEl);

	// ---- Throttle bar (right edge, vertical) ----
	const throttleContainer = document.createElement("div");
	Object.assign(throttleContainer.style, {
		position: "fixed",
		right: "20px",
		top: "50%",
		transform: "translateY(-50%)",
		display: "none",
		flexDirection: "column",
		alignItems: "center",
		gap: "1px",
		pointerEvents: "none",
	} satisfies Partial<CSSStyleDeclaration>);

	const throttleSegments: HTMLDivElement[] = [];
	for (let i = 0; i < 21; i++) {
		const level = 10 - i;
		const seg = document.createElement("div");
		Object.assign(seg.style, {
			width: "8px",
			height: level === 0 ? "3px" : "10px",
			backgroundColor: level === 0 ? "#ffffff" : "#333333",
			borderRadius: "1px",
		} satisfies Partial<CSSStyleDeclaration>);
		if (level !== 0) {
			seg.style.border = "1px solid #555";
		}
		throttleContainer.appendChild(seg);
		throttleSegments.push(seg);
	}

	const throttleLabelEl = document.createElement("div");
	Object.assign(throttleLabelEl.style, {
		color: "#ffffff",
		fontFamily: "monospace",
		fontSize: "12px",
		marginTop: "4px",
		textShadow: "1px 1px 2px #000",
	} satisfies Partial<CSSStyleDeclaration>);
	throttleLabelEl.textContent = "0";
	throttleContainer.appendChild(throttleLabelEl);
	document.body.appendChild(throttleContainer);

	// ---- Autopilot badge ----
	const apBadge = document.createElement("div");
	Object.assign(apBadge.style, {
		position: "fixed",
		right: "48px",
		top: "50%",
		transform: "translateY(-50%)",
		fontFamily: "monospace",
		fontSize: "16px",
		fontWeight: "bold",
		padding: "4px 8px",
		borderRadius: "4px",
		pointerEvents: "none",
		display: "none",
		textShadow: "1px 1px 2px #000",
	} satisfies Partial<CSSStyleDeclaration>);
	apBadge.textContent = "AP";
	document.body.appendChild(apBadge);

	// ---- Input state ----
	const keysDown = new Set<string>();
	let isDragging = false;
	let lastMouseX = 0;
	let lastMouseY = 0;
	let mouseScreenX = 0;
	let mouseScreenY = 0;
	let elapsedTime = 0;

	// Stepped throttle for ships (-10 to +10)
	let throttleLevel = 0;
	let autopilotOn = false;

	function isShipVehicle(v: NavalVehicle): boolean {
		return v.propellerOffset !== 0;
	}

	function isTankerVehicle(v: NavalVehicle): boolean {
		return v.vehicleType === "oil_tanker";
	}

	type CameraMode = "isometric" | "third-person" | "first-person";
	const mode = {
		cameraFollow: true,
		freeCamera: false,
		cameraMode: "isometric" as CameraMode,
	};
	let prevCameraMode: CameraMode = "isometric";
	const _tPos = new THREE.Vector3();
	const _tLook = new THREE.Vector3();

	// ---- Perspective camera settings (tunable via GUI) ----
	const perspSettings = {
		tpDistance: 3, // behind vehicle, multiplier of size
		tpHeight: 1.5, // above vehicle, multiplier of size
		fpHeight: 0.5, // eye height, multiplier of size
		fpForward: 0.3, // forward from center, multiplier of size
		smoothing: 8, // camera lerp speed
	};

	// ---- Simulation settings ----
	const simSettings = { timeScale: 1.0, showCollisionPolygons: true };

	// ---- Dev panel ----
	const gui = new GUI({ title: "Hormuz Playground" });

	// Vehicle stats folder — rebuilt when switching vehicles
	let vehicleFolder: GUI | null = null;

	function rebuildVehicleFolder() {
		if (vehicleFolder) vehicleFolder.destroy();
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		vehicleFolder = gui.addFolder(`${label} [${activeIndex + 1}]`);
		vehicleFolder.add(v, "enginePower", 10, 10000).name("Engine Power");
		vehicleFolder.add(v, "dragCoefficient", 0.01, 50).name("Drag Coefficient");
		vehicleFolder.add(v, "mass", 1, 5000).name("Mass");
		if (v.propellerOffset !== 0) {
			vehicleFolder.add(v, "propellerOffset", -0.5, 0).name("Propeller Offset");
			vehicleFolder.add(v, "rudderMaxAngle", 0.1, 1.2).name("Rudder Max Angle");
			vehicleFolder
				.add(v, "momentOfInertia", 100, 5000000)
				.name("Moment of Inertia");
			vehicleFolder
				.add(v, "rudderFlowCoefficient", 0, 30)
				.name("Rudder Flow Coeff");
		} else {
			vehicleFolder.add(v, "turnRate", 0.05, 6).name("Turn Rate");
			vehicleFolder.add(v, "driftFactor", 0, 0.5).name("Drift Factor");
		}
		vehicleFolder.add(v, "lateralDrag", 0.01, 0.8).name("Lateral Drag");
		vehicleFolder.add(v, "cruiseSpeed", 0, 100).name("Cruise Speed");
		vehicleFolder.add(v, "size", 0.5, 300).name("Visual Size");
		vehicleFolder.add(v, "angularDrag", 0.01, 0.5).name("Angular Drag");
	}

	rebuildVehicleFolder();

	// Camera folder
	const cameraFolder = gui.addFolder("Camera");
	cameraFolder.add(cam, "zoom", 0.02, 10).name("Zoom").listen();
	cameraFolder
		.add(mode, "freeCamera")
		.name("Free Camera (Tab)")
		.listen()
		.onChange((v: boolean) => {
			mode.cameraFollow = !v;
		});
	cameraFolder
		.add(mode, "cameraMode", ["isometric", "third-person", "first-person"])
		.name("Mode (V)")
		.listen()
		.onChange((v: CameraMode) => {
			if (v !== "isometric") {
				mode.freeCamera = false;
				mode.cameraFollow = true;
			}
		});
	const perspFolder = gui.addFolder("Perspective Camera");
	perspFolder
		.add(perspCamera, "fov", 30, 120)
		.name("FOV")
		.step(1)
		.onChange(() => perspCamera.updateProjectionMatrix());
	perspFolder.add(perspSettings, "tpDistance", 1, 10).name("TP Distance");
	perspFolder.add(perspSettings, "tpHeight", 0.5, 5).name("TP Height");
	perspFolder.add(perspSettings, "fpHeight", 0.1, 1.5).name("FP Height");
	perspFolder.add(perspSettings, "fpForward", -0.5, 0.5).name("FP Forward");
	perspFolder.add(perspSettings, "smoothing", 1, 20).name("Smoothing");

	// Simulation folder
	const simFolder = gui.addFolder("Simulation");
	simFolder
		.add(simSettings, "timeScale", 0.1, 3.0)
		.name("Time Scale")
		.step(0.1);
	simFolder.add(simSettings, "showCollisionPolygons").name("Show Collision");

	// Collision test folder
	const collisionTests = {
		"T-bone collision"() {
			// Place two tankers on collision course
			const tankerA = vehicles[2].vehicle;
			const tankerB = vehicles[1].vehicle;

			tankerA.x = 75500;
			tankerA.y = 43000;
			tankerA.heading = 0; // heading east
			tankerA.speed = 14;
			tankerA.drift = 0;
			tankerA.angularVelocity = 0;

			// Frigate comes from north, perpendicular
			tankerB.x = 75700;
			tankerB.y = 42800;
			tankerB.heading = Math.PI / 2; // heading south
			tankerB.speed = 26;
			tankerB.drift = 0;
			tankerB.angularVelocity = 0;

			activeIndex = 2;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.15;
			rebuildVehicleFolder();
		},
		"Head-on collision"() {
			const a = vehicles[2].vehicle; // tanker
			const b = vehicles[1].vehicle; // frigate

			a.x = 75300;
			a.y = 43000;
			a.heading = 0; // east
			a.speed = 14;
			a.drift = 0;
			a.angularVelocity = 0;

			b.x = 75800;
			b.y = 43000;
			b.heading = Math.PI; // west
			b.speed = 26;
			b.drift = 0;
			b.angularVelocity = 0;

			activeIndex = 2;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.1;
			rebuildVehicleFolder();
		},
		"Speedboat rams tanker"() {
			const boat = vehicles[0].vehicle;
			const tanker = vehicles[2].vehicle;

			tanker.x = 75500;
			tanker.y = 43000;
			tanker.heading = 0;
			tanker.speed = 8;
			tanker.drift = 0;
			tanker.angularVelocity = 0;

			// Speedboat approaches from port bow at angle
			boat.x = 75350;
			boat.y = 42900;
			boat.heading = Math.PI / 6; // heading ~30deg south-east
			boat.speed = 52;
			boat.drift = 0;
			boat.angularVelocity = 0;

			activeIndex = 0;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.15;
			rebuildVehicleFolder();
		},
		"Destroy active vehicle"() {
			const pv = vehicles[activeIndex];
			if (pv.hp <= 0) return;
			pv.hp = 0;
			pv.respawnTimer = RESPAWN_TIME;
			threeEffects.spawnExplosion(pv.vehicle.x, pv.vehicle.y);
		},
		"Spawn explosion (no kill)"() {
			const v = activeVehicle();
			threeEffects.spawnExplosion(v.x, v.y);
		},
	};

	const collisionFolder = gui.addFolder("Collision Tests");
	collisionFolder.add(collisionTests, "T-bone collision");
	collisionFolder.add(collisionTests, "Head-on collision");
	collisionFolder.add(collisionTests, "Speedboat rams tanker");
	collisionFolder.add(collisionTests, "Destroy active vehicle");
	collisionFolder.add(collisionTests, "Spawn explosion (no kill)");

	// Damage folder
	const damageActions = {
		"Damage Port"() {
			const v = activeVehicle();
			addBreach(v, -1);
		},
		"Damage Starboard"() {
			const v = activeVehicle();
			addBreach(v, 1);
		},
		"Damage Center"() {
			const v = activeVehicle();
			addBreach(v, 0);
		},
	};
	const damageFolder = gui.addFolder("Damage");
	damageFolder.add(damageActions, "Damage Port");
	damageFolder.add(damageActions, "Damage Starboard");
	damageFolder.add(damageActions, "Damage Center");

	// Flooding tuning folder
	const floodingFolder = gui.addFolder("Flooding");
	floodingFolder.add(FLOOD, "breachRate", 0.005, 0.1).name("Breach Rate");
	floodingFolder.add(FLOOD, "maxList", 0.1, 0.8).name("Max List (rad)");
	floodingFolder.add(FLOOD, "floodDragFactor", 0, 3).name("Flood Drag Factor");
	floodingFolder.add(FLOOD, "lerpRate", 0.5, 10).name("List Lerp Rate");

	// CIWS tuning folder
	const ciwsFolder = gui.addFolder("CIWS Autocannon");
	const cp = ciwsController.params;
	ciwsFolder.add(cp, "rotationSpeed", 0.5, 12).name("Rotation (rad/s)");
	ciwsFolder.add(cp, "burstCooldown", 0.1, 2).name("Burst Cooldown (s)");
	ciwsFolder.add(cp, "burstDuration", 0.05, 1).name("Burst Duration (s)");
	ciwsFolder.add(cp, "tracerRate", 5, 100).step(1).name("Tracer Rate (/s)");
	ciwsFolder.add(cp, "range", 200, 3000).name("Range");
	ciwsFolder.add(cp, "projectileSpeed", 50, 1000).name("Projectile Speed");
	ciwsFolder.add(cp, "spread", 0, 0.2).name("Spread (rad)");
	ciwsFolder.add(cp, "aimTolerance", 0.01, 0.5).name("Aim Tolerance (rad)");
	ciwsFolder.add(cp, "tracerMaxAge", 0.3, 5).name("Tracer MaxAge (s)");
	ciwsFolder.add(cp, "tracerSize", 1, 15).name("Tracer Size (px)");
	ciwsFolder.add(cp, "muzzleFlashScale", 1, 10).name("Flash Scale");
	ciwsFolder
		.add(cp, "muzzleFlashDuration", 0.02, 0.2)
		.name("Flash Duration (s)");

	// Presets
	const presets = {
		"CIWS Demo"() {
			// Position frigate heading east with some speed
			const frig = vehicles[1].vehicle;
			frig.x = 75540;
			frig.y = 43226;
			frig.heading = 0;
			frig.speed = 8;
			frig.drift = 0;
			frig.angularVelocity = 0;
			vehicles[1].hp = 100;

			// Position shahed approaching from the east
			const shahed = vehicles[5].vehicle;
			shahed.x = 75540 + 1000;
			shahed.y = 43226 + 200;
			shahed.heading = Math.PI; // heading west toward frigate
			shahed.speed = 80;
			shahed.drift = 0;
			shahed.angularVelocity = 0;
			vehicles[5].hp = 100;

			// Position quadcopter from the south
			const quad = vehicles[4].vehicle;
			quad.x = 75540 - 300;
			quad.y = 43226 + 500;
			quad.heading = -Math.PI / 2; // heading north toward frigate
			quad.speed = 22;
			quad.drift = 0;
			quad.angularVelocity = 0;
			vehicles[4].hp = 100;

			activeIndex = 1;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.12;
			rebuildVehicleFolder();
		},
		"Full Map"() {
			mode.freeCamera = true;
			mode.cameraFollow = false;
			cam.worldX = MAP.width / 2;
			cam.worldY = MAP.height / 2;
			cam.zoom = 0.012;
		},
		Strait() {
			mode.freeCamera = true;
			mode.cameraFollow = false;
			cam.worldX = MAP.center.x;
			cam.worldY = MAP.center.y;
			cam.zoom = 0.04;
		},
		"Follow Vehicle"() {
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.3;
		},
		"Reset All"() {
			for (let i = 0; i < vehicles.length; i++) {
				const pv = vehicles[i];
				pv.vehicle.x = SPAWN_POSITIONS[i][0];
				pv.vehicle.y = SPAWN_POSITIONS[i][1];
				pv.vehicle.heading = Math.PI;
				pv.vehicle.speed = 0;
				pv.vehicle.drift = 0;
				pv.vehicle.angularVelocity = 0;
				pv.vehicle.floodLevel = 0;
				pv.vehicle.listAngle = 0;
				pv.vehicle.hullBreaches = 0;
				pv.vehicle.breachSide = 0;
				pv.hp = 100;
				pv.respawnTimer = 0;
			}
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.3;
		},
	};

	const presetsFolder = gui.addFolder("Presets");
	presetsFolder.add(presets, "CIWS Demo");
	presetsFolder.add(presets, "Full Map");
	presetsFolder.add(presets, "Strait");
	presetsFolder.add(presets, "Follow Vehicle");
	presetsFolder.add(presets, "Reset All");

	// Layers
	const layersFolder = gui.addFolder("Layers");
	const onLayerChange = () => threeMap.setLayers(layers);
	layersFolder
		.add(layers, "showDepthZones")
		.name("Depth Zones")
		.onChange(onLayerChange);
	layersFolder
		.add(layers, "showShippingLanes")
		.name("Shipping Lanes")
		.onChange(onLayerChange);
	layersFolder
		.add(layers, "showHazards")
		.name("Hazards")
		.onChange(onLayerChange);
	layersFolder
		.add(layers, "showSpawnPoints")
		.name("Spawn Points")
		.onChange(onLayerChange);
	layersFolder
		.add(layers, "showTerrain")
		.name("Terrain")
		.onChange(onLayerChange);
	layersFolder.add(layers, "showGrid").name("Grid").onChange(onLayerChange);
	layersFolder
		.add(layers, "showExclusionZones")
		.name("Exclusion Zones")
		.onChange(onLayerChange);

	// ---- Mouse controls ----
	const canvas = threeScene.renderer.domElement;

	canvas.addEventListener("mousedown", (e: MouseEvent) => {
		if (e.button === 0 || e.button === 1) {
			isDragging = true;
			lastMouseX = e.clientX;
			lastMouseY = e.clientY;
		}
	});

	canvas.addEventListener("mousemove", (e: MouseEvent) => {
		mouseScreenX = e.clientX;
		mouseScreenY = e.clientY;
		if (isDragging && mode.freeCamera) {
			cam.worldX -= (e.clientX - lastMouseX) / cam.zoom;
			cam.worldY -= (e.clientY - lastMouseY) / cam.zoom;
		}
		lastMouseX = e.clientX;
		lastMouseY = e.clientY;
	});

	canvas.addEventListener("mouseup", () => {
		isDragging = false;
	});
	canvas.addEventListener("mouseleave", () => {
		isDragging = false;
	});

	canvas.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			e.preventDefault();
			if (mode.cameraMode === "isometric") {
				cam.zoom = Math.max(
					0.02,
					Math.min(10, cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1)),
				);
			}
		},
		{ passive: false },
	);

	// ---- Keyboard ----
	window.addEventListener("keydown", (e: KeyboardEvent) => {
		const key = e.key.toLowerCase();
		keysDown.add(key);

		// Stepped throttle for ships: ArrowUp/W increments, ArrowDown/S decrements
		if (isShipVehicle(activeVehicle()) && !mode.freeCamera) {
			if (key === "arrowup" || key === "w") {
				throttleLevel = Math.min(10, throttleLevel + 1);
				e.preventDefault();
			} else if (key === "arrowdown" || key === "s") {
				throttleLevel = Math.max(-10, throttleLevel - 1);
				e.preventDefault();
			}
		}

		// Autopilot toggle: P key
		if (key === "p" && !e.repeat && isTankerVehicle(activeVehicle())) {
			autopilotOn = !autopilotOn;
		}

		// Steering disengages autopilot
		if (
			(key === "a" ||
				key === "arrowleft" ||
				key === "d" ||
				key === "arrowright") &&
			autopilotOn
		) {
			autopilotOn = false;
		}

		// Tab: toggle free camera
		if (e.key === "Tab") {
			e.preventDefault();
			mode.freeCamera = !mode.freeCamera;
			mode.cameraFollow = !mode.freeCamera;
		}

		// V: cycle camera mode
		if (key === "v") {
			const modes: CameraMode[] = ["isometric", "third-person", "first-person"];
			const idx = modes.indexOf(mode.cameraMode);
			mode.cameraMode = modes[(idx + 1) % modes.length];
			if (mode.cameraMode !== "isometric") {
				mode.freeCamera = false;
				mode.cameraFollow = true;
			}
		}

		// 1-6: switch active vehicle
		const digit = Number.parseInt(e.key);
		if (digit >= 1 && digit <= 9 && digit - 1 < vehicles.length) {
			activeIndex = digit - 1;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			rebuildVehicleFolder();
			// Reset throttle and autopilot for new vehicle
			throttleLevel = 0;
			autopilotOn = isTankerVehicle(activeVehicle());
		}
	});

	window.addEventListener("keyup", (e: KeyboardEvent) => {
		keysDown.delete(e.key.toLowerCase());
	});

	// ---- Resize ----
	window.addEventListener("resize", () => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		cam.screenWidth = w;
		cam.screenHeight = h;
		threeScene.setSize(w, h);
		perspCamera.aspect = w / h;
		perspCamera.updateProjectionMatrix();
	});

	// ---- Render loop ----
	let lastTime = performance.now();

	function frame(now: number) {
		requestAnimationFrame(frame);

		const rawDt = (now - lastTime) / 1000;
		lastTime = now;
		const dt = rawDt * simSettings.timeScale;

		// -- Input --
		const input: VehicleInput = { throttle: 0, rudder: 0 };
		if (!mode.freeCamera) {
			const ship = isShipVehicle(activeVehicle());
			if (ship) {
				// Ships use stepped throttle (player always controls throttle)
				input.throttle = throttleLevel / 10;
			} else {
				// Non-ships use hold-to-move
				if (keysDown.has("w") || keysDown.has("arrowup")) input.throttle = 1;
				if (keysDown.has("s") || keysDown.has("arrowdown")) input.throttle = -1;
			}
			// Autopilot controls steering only — rudder is 0 (go straight)
			// When off, player steers manually
			if (!autopilotOn) {
				if (keysDown.has("a") || keysDown.has("arrowleft")) input.rudder = -1;
				if (keysDown.has("d") || keysDown.has("arrowright")) input.rudder = 1;
			}
		} else {
			const panSpeed = 500 / cam.zoom;
			if (keysDown.has("a") || keysDown.has("arrowleft")) {
				cam.worldX -= panSpeed * rawDt;
			}
			if (keysDown.has("d") || keysDown.has("arrowright")) {
				cam.worldX += panSpeed * rawDt;
			}
			if (keysDown.has("w") || keysDown.has("arrowup")) {
				cam.worldY -= panSpeed * rawDt;
			}
			if (keysDown.has("s") || keysDown.has("arrowdown")) {
				cam.worldY += panSpeed * rawDt;
			}
		}

		// -- Respawn dead vehicles --
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) {
				pv.respawnTimer -= dt;
				if (pv.respawnTimer <= 0) {
					pv.hp = 100;
					pv.respawnTimer = 0;
					pv.vehicle.x = SPAWN_POSITIONS[i][0];
					pv.vehicle.y = SPAWN_POSITIONS[i][1];
					pv.vehicle.heading = Math.PI;
					pv.vehicle.speed = 0;
					pv.vehicle.drift = 0;
					pv.vehicle.angularVelocity = 0;
					pv.vehicle.floodLevel = 0;
					pv.vehicle.listAngle = 0;
					pv.vehicle.hullBreaches = 0;
					pv.vehicle.breachSide = 0;
				}
			}
		}

		// -- Update all alive vehicles (save positions for collision rollback) --
		const prevPositions: { x: number; y: number }[] = [];
		for (const pv of vehicles) {
			prevPositions.push({ x: pv.vehicle.x, y: pv.vehicle.y });
		}

		const aliveVehicles: NavalVehicle[] = [];
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) continue;
			if (i === activeIndex) {
				updateVehicle(pv.vehicle, input, dt);
			} else {
				updateVehicle(pv.vehicle, { throttle: 0, rudder: 0 }, dt);
			}
			aliveVehicles.push(pv.vehicle);
		}

		// -- Collisions (alive vehicles only) --
		for (let i = 0; i < vehicles.length; i++) {
			if (vehicles[i].hp <= 0) continue;
			resolveTerrainCollision(
				vehicles[i].vehicle,
				prevPositions[i].x,
				prevPositions[i].y,
			);
		}
		resolveVehicleCollisions(aliveVehicles);

		// -- Flooding simulation --
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) continue;
			updateFlooding(pv.vehicle, dt);
			if (pv.vehicle.floodLevel >= 1) {
				pv.hp = 0;
				pv.respawnTimer = RESPAWN_TIME;
			}
		}

		// -- Camera follow --
		if (mode.cameraFollow) {
			const v = activeVehicle();
			const followSpeed = 5;
			const altOffset = v.airborne ? 30 : 0;
			cam.worldX += (v.x - altOffset - cam.worldX) * followSpeed * rawDt;
			cam.worldY += (v.y - altOffset - cam.worldY) * followSpeed * rawDt;
		}

		// -- Update perspective camera for first/third-person modes --
		if (mode.cameraMode !== "isometric") {
			const v = activeVehicle();
			const sz = v.size;
			const elev = v.airborne
				? getElevation(v.x, v.y) + 30
				: getElevation(v.x, v.y);
			const fwdX = Math.cos(v.heading);
			const fwdZ = Math.sin(v.heading);

			if (mode.cameraMode === "third-person") {
				const dist = sz * perspSettings.tpDistance;
				const height = sz * perspSettings.tpHeight;
				_tPos.set(v.x - fwdX * dist, elev + height, v.y - fwdZ * dist);
				_tLook.set(v.x, elev + sz * 0.2, v.y);
			} else {
				const fwd = sz * perspSettings.fpForward;
				const height = sz * perspSettings.fpHeight;
				_tPos.set(v.x + fwdX * fwd, elev + height, v.y + fwdZ * fwd);
				_tLook.set(
					v.x + fwdX * (fwd + sz * 2),
					elev + height * 0.8,
					v.y + fwdZ * (fwd + sz * 2),
				);
			}

			// Snap on mode switch, smooth-lerp otherwise
			if (prevCameraMode !== mode.cameraMode) {
				perspCamera.position.copy(_tPos);
			} else {
				const t = 1 - Math.exp(-perspSettings.smoothing * rawDt);
				perspCamera.position.lerp(_tPos, t);
			}
			perspCamera.lookAt(_tLook);
		}
		prevCameraMode = mode.cameraMode;

		// -- Build entity states for Three.js renderers --
		const entityStates: EntityState[] = vehicles.map((pv, i) => ({
			id: i,
			vehicleType: pv.vehicle.vehicleType,
			faction: pv.key,
			x: pv.vehicle.x,
			y: pv.vehicle.y,
			heading: pv.vehicle.heading,
			speed: pv.vehicle.speed,
			drift: pv.vehicle.drift,
			hp: pv.hp,
			angularVelocity: pv.vehicle.angularVelocity,
			floodLevel: pv.vehicle.floodLevel,
			listAngle: pv.vehicle.listAngle,
		}));

		// -- Update Three.js renderers --
		elapsedTime += rawDt;
		threeMap.update(elapsedTime, cam.zoom);
		threeVehicles.update(
			entityStates,
			activeIndex,
			vehicles[activeIndex].vehicle.vehicleType,
			FACTION_COLORS,
		);
		ciwsController.update(
			entityStates,
			(id) => threeVehicles.getCiwsTurret(id),
			dt,
			cam.zoom,
		);
		threeEffects.update(entityStates, dt, cam.zoom);

		// -- Collision debug wireframes --
		let vertexCount = 0;
		if (simSettings.showCollisionPolygons) {
			for (const pv of vehicles) {
				if (pv.hp <= 0) continue;
				const verts = COLLISION_POLYGONS[pv.vehicle.vehicleType];
				if (!verts) continue;
				const cos = Math.cos(pv.vehicle.heading);
				const sin = Math.sin(pv.vehicle.heading);
				const sz = pv.vehicle.size;
				const elev = pv.vehicle.airborne
					? getElevation(pv.vehicle.x, pv.vehicle.y) + 30.5
					: getElevation(pv.vehicle.x, pv.vehicle.y) + 0.5;
				for (let k = 0; k < verts.length; k++) {
					const [lx0, ly0] = verts[k];
					const [lx1, ly1] = verts[(k + 1) % verts.length];
					const wx0 = pv.vehicle.x + (lx0 * cos - ly0 * sin) * sz;
					const wy0 = pv.vehicle.y + (lx0 * sin + ly0 * cos) * sz;
					const wx1 = pv.vehicle.x + (lx1 * cos - ly1 * sin) * sz;
					const wy1 = pv.vehicle.y + (lx1 * sin + ly1 * cos) * sz;
					collisionPositions[vertexCount * 3] = wx0;
					collisionPositions[vertexCount * 3 + 1] = elev;
					collisionPositions[vertexCount * 3 + 2] = wy0;
					vertexCount++;
					collisionPositions[vertexCount * 3] = wx1;
					collisionPositions[vertexCount * 3 + 1] = elev;
					collisionPositions[vertexCount * 3 + 2] = wy1;
					vertexCount++;
				}
			}
		}
		collisionGeo.setDrawRange(0, vertexCount);
		(
			collisionGeo.getAttribute("position") as THREE.BufferAttribute
		).needsUpdate = true;

		// -- Render Three.js scene --
		if (mode.cameraMode === "isometric") {
			threeScene.syncCamera(
				cam.worldX,
				cam.worldY,
				cam.zoom,
				cam.screenWidth,
				cam.screenHeight,
			);
			threeScene.render();
		} else {
			threeScene.renderer.render(threeScene.scene, perspCamera);
		}

		// -- HUD --
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		const pv = vehicles[activeIndex];
		const hpStr =
			pv.hp <= 0 ? `DEAD (${pv.respawnTimer.toFixed(1)}s)` : `HP: ${pv.hp}`;
		const camLabel =
			mode.cameraMode !== "isometric"
				? `[${mode.cameraMode.toUpperCase()}]`
				: mode.freeCamera
					? "[FREE CAM]"
					: "[FOLLOW]";
		coordEl.textContent = `Cursor: (${Math.round(world.x)}, ${Math.round(world.y)})  Elev: ${getElevation(world.x, world.y).toFixed(0)}  Zoom: ${cam.zoom.toFixed(3)}  ${camLabel}  Time: ${simSettings.timeScale.toFixed(1)}x`;
		const eqSpd = equilibriumSpeed(v);
		const floodStr =
			v.floodLevel > 0
				? `  Flood: ${(v.floodLevel * 100).toFixed(0)}%  List: ${((v.listAngle * 180) / Math.PI).toFixed(1)}°`
				: "";
		const controlHint = isShipVehicle(v)
			? "arrows steer/throttle, P autopilot"
			: "WASD";
		boatEl.textContent = `${label}: ${hpStr}  Speed: ${v.speed.toFixed(1)} kn (max ${eqSpd.toFixed(0)})  Heading: ${((v.heading * 180) / Math.PI).toFixed(0)}°${floodStr}  [1-6] ${controlHint}`;

		// -- Throttle bar --
		const showThrottle = isShipVehicle(v);
		throttleContainer.style.display = showThrottle ? "flex" : "none";
		if (showThrottle) {
			throttleLabelEl.textContent =
				throttleLevel > 0 ? `+${throttleLevel}` : `${throttleLevel}`;
			for (let i = 0; i < 21; i++) {
				const segLevel = 10 - i;
				const seg = throttleSegments[i];
				if (segLevel === 0) {
					seg.style.backgroundColor = "#ffffff";
				} else if (
					throttleLevel > 0 &&
					segLevel > 0 &&
					segLevel <= throttleLevel
				) {
					seg.style.backgroundColor = "#00cc44";
				} else if (
					throttleLevel < 0 &&
					segLevel < 0 &&
					segLevel >= throttleLevel
				) {
					seg.style.backgroundColor = "#cc4400";
				} else {
					seg.style.backgroundColor = "#333333";
				}
			}
		}

		// -- Autopilot badge --
		const showAp = isTankerVehicle(v);
		apBadge.style.display = showAp ? "block" : "none";
		if (showAp) {
			apBadge.style.backgroundColor = autopilotOn ? "#00aa44" : "#555555";
			apBadge.style.color = autopilotOn ? "#ffffff" : "#999999";
		}
	}

	requestAnimationFrame(frame);

	console.log(
		"Hormuz playground — WASD to drive, arrows steer/throttle (ships), P autopilot (tanker), 1-6 switch vehicle, Tab free camera, V cycle camera, scroll zoom",
	);
}

init();
