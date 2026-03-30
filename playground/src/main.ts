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
	type NavalVehicle,
	type VehicleInput,
	createFrigate,
	createOilTanker,
	createQuadcopter,
	createShahed,
	createSpeedboat,
	createTruck,
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
			vehicle: createSpeedboat(75746, 42781),
			color: FACTION_COLORS.speedboat,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "frigate",
			label: "Frigate",
			vehicle: createFrigate(75540, 43226),
			color: FACTION_COLORS.frigate,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "tanker",
			label: "Oil Tanker",
			vehicle: createOilTanker(75500, 43000),
			color: FACTION_COLORS.tanker,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "truck",
			label: "Box Truck",
			vehicle: createTruck(75698, 42649),
			color: FACTION_COLORS.truck,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "quadcopter",
			label: "Quadcopter",
			vehicle: createQuadcopter(75700, 42900),
			color: FACTION_COLORS.quadcopter,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "shahed",
			label: "Shahed Drone",
			vehicle: createShahed(75600, 42850),
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

	// ---- Input state ----
	const keysDown = new Set<string>();
	let isDragging = false;
	let lastMouseX = 0;
	let lastMouseY = 0;
	let mouseScreenX = 0;
	let mouseScreenY = 0;
	let elapsedTime = 0;

	const mode = { cameraFollow: true, freeCamera: false };

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
		vehicleFolder.add(v, "maxSpeed", 0.5, 100).name("Max Speed");
		vehicleFolder.add(v, "acceleration", 0.1, 25).name("Acceleration");
		vehicleFolder.add(v, "drag", 0.5, 0.99).name("Forward Drag");
		vehicleFolder.add(v, "turnRate", 0.05, 6).name("Turn Rate");
		vehicleFolder.add(v, "driftFactor", 0, 0.5).name("Drift Factor");
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

	// Presets
	const presets = {
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
				pv.hp = 100;
				pv.respawnTimer = 0;
			}
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.3;
		},
	};

	const presetsFolder = gui.addFolder("Presets");
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
			cam.zoom = Math.max(
				0.02,
				Math.min(10, cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1)),
			);
		},
		{ passive: false },
	);

	// ---- Keyboard ----
	window.addEventListener("keydown", (e: KeyboardEvent) => {
		keysDown.add(e.key.toLowerCase());

		// Tab: toggle free camera
		if (e.key === "Tab") {
			e.preventDefault();
			mode.freeCamera = !mode.freeCamera;
			mode.cameraFollow = !mode.freeCamera;
		}

		// 1-6: switch active vehicle
		const digit = Number.parseInt(e.key);
		if (digit >= 1 && digit <= 9 && digit - 1 < vehicles.length) {
			activeIndex = digit - 1;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			rebuildVehicleFolder();
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
			if (keysDown.has("w") || keysDown.has("arrowup")) input.throttle = 1;
			if (keysDown.has("s") || keysDown.has("arrowdown")) input.throttle = -1;
			if (keysDown.has("a") || keysDown.has("arrowleft")) input.rudder = -1;
			if (keysDown.has("d") || keysDown.has("arrowright")) input.rudder = 1;
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

		// -- Camera follow --
		if (mode.cameraFollow) {
			const v = activeVehicle();
			const followSpeed = 5;
			const altOffset = v.airborne ? 30 : 0;
			cam.worldX += (v.x - altOffset - cam.worldX) * followSpeed * rawDt;
			cam.worldY += (v.y - altOffset - cam.worldY) * followSpeed * rawDt;
		}

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
		}));

		// -- Update Three.js renderers --
		elapsedTime += rawDt;
		threeMap.update(elapsedTime, cam.zoom);
		threeVehicles.update(entityStates, activeIndex, FACTION_COLORS);
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
		threeScene.syncCamera(
			cam.worldX,
			cam.worldY,
			cam.zoom,
			cam.screenWidth,
			cam.screenHeight,
		);
		threeScene.render();

		// -- HUD --
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		const omega = v.angularVelocity;
		const pv = vehicles[activeIndex];
		const hpStr =
			pv.hp <= 0 ? `DEAD (${pv.respawnTimer.toFixed(1)}s)` : `HP: ${pv.hp}`;
		coordEl.textContent = `Cursor: (${Math.round(world.x)}, ${Math.round(world.y)})  Elev: ${getElevation(world.x, world.y).toFixed(0)}  Zoom: ${cam.zoom.toFixed(3)}  ${mode.freeCamera ? "[FREE CAM]" : "[FOLLOW]"}  Time: ${simSettings.timeScale.toFixed(1)}x`;
		boatEl.textContent = `${label}: ${hpStr}  Speed: ${v.speed.toFixed(1)}  Drift: ${v.drift.toFixed(2)}  Heading: ${((v.heading * 180) / Math.PI).toFixed(0)}°  AngVel: ${omega.toFixed(3)}  [1-6]`;
	}

	requestAnimationFrame(frame);

	console.log(
		"Hormuz playground — WASD to drive, 1-6 to switch vehicle, Tab for free camera, scroll to zoom",
	);
}

init();
