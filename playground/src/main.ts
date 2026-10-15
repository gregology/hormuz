import GUI, { type Controller } from "lil-gui";
import * as THREE from "three/webgpu";
import { buildClientGameData } from "../../client/src/ai/game-data";
import {
	type AIBotState,
	type AIEntitySnapshot,
	LuaAIHost,
} from "../../client/src/ai/lua-host";
import { ThreeEffectManager } from "../../client/src/effects/manager";
import type { EntityState } from "../../client/src/game/entities";
import {
	IRAN_SPAWNS,
	QUADCOPTER_SPAWNS,
	SPEEDBOAT_SPAWNS,
	type SpawnPoint,
	TANKER_SPAWNS,
	US_SPAWNS,
} from "../../client/src/generated/map_data";
import { LANE_ALT_OUTBOUND, MAP } from "../../client/src/map/data";
import { getElevation } from "../../client/src/map/heightmap";
import { isLand } from "../../client/src/map/terrain";
import {
	type Camera,
	createCamera,
	screenToWorld,
	worldToScreen,
} from "../../client/src/render/camera";
import { CiwsController } from "../../client/src/render/ciws-controller";
import { COLORS } from "../../client/src/render/colors";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	ThreeMapRenderer,
} from "../../client/src/render/map-renderer";
import { ThreeScene } from "../../client/src/render/scene";
import {
	atStraitHour,
	formatStraitTime,
	straitSolarPosition,
} from "../../client/src/render/solar";
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
	type VehicleType,
	addBreach,
	createVehicle,
	equilibriumSpeed,
	updateFlooding,
	updateVehicle,
} from "../../client/src/vehicles/physics";

type Faction = "iran" | "us" | "civilian";

const FACTION_BY_TYPE: Record<VehicleType, Faction> = {
	speedboat: "iran",
	shahed: "iran",
	quadcopter: "iran",
	frigate: "us",
	oil_tanker: "civilian",
	truck: "civilian",
};

const FACTION_COLORS: Record<string, number> = {
	iran: COLORS.spawnIran,
	us: COLORS.spawnUS,
	civilian: COLORS.spawnTanker,
};

const VEHICLE_TYPES: VehicleType[] = [
	"oil_tanker",
	"frigate",
	"speedboat",
	"shahed",
	"quadcopter",
	"truck",
];

const TYPE_LABELS: Record<VehicleType, string> = {
	oil_tanker: "Oil Tanker",
	frigate: "Frigate",
	speedboat: "Speedboat",
	shahed: "Shahed",
	quadcopter: "Quadcopter",
	truck: "Box Truck",
};

const BEHAVIOR_BY_TYPE: Partial<Record<VehicleType, string>> = {
	oil_tanker: "tanker_transit",
	frigate: "escort",
	speedboat: "swarm_attack",
	shahed: "shahed_intercept",
	quadcopter: "quadcopter_intercept",
};

interface PlayableVehicle {
	id: number;
	vehicle: NavalVehicle;
	faction: Faction;
	label: string;
	hp: number;
	respawnTimer: number;
	home: { x: number; y: number; heading: number };
	aiEnabled: boolean;
	bot: AIBotState | null;
}

const RESPAWN_TIME = 4.0;
// Trucks have no gameplay spawn point — use the old fixed starter location.
const TRUCK_SPAWN = { x: 75698, y: 42649 };

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

/** Mirror of server map_data._scatter_around. */
function scatterAround(spawn: SpawnPoint): {
	x: number;
	y: number;
	heading: number;
} {
	const [sx, sy] = spawn.position;
	const radius = spawn.scatterRadius ?? 500;
	const angle = Math.random() * Math.PI * 2;
	const dist = Math.random() * radius;
	return {
		x: sx + Math.cos(angle) * dist,
		y: sy + Math.sin(angle) * dist,
		heading: (spawn.heading ?? 0) + (Math.random() - 0.5) * 0.52,
	};
}

function headingBetween(
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

async function init() {
	const screenW = window.innerWidth;
	const screenH = window.innerHeight;

	// ---- Three.js scene (WebGPU, falling back to WebGL2) ----
	const threeScene = await ThreeScene.create();
	threeScene.setSize(screenW, screenH);
	document.body.appendChild(threeScene.renderer.domElement);

	// ---- Camera ----
	const cam: Camera = createCamera(screenW, screenH);
	cam.zoom = 0.04;

	// ---- Map (Three.js) ----
	const layers: MapLayers = { ...DEFAULT_LAYERS };
	const threeMap = new ThreeMapRenderer(
		layers,
		threeScene.environment.reflections,
	);
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
	const perspCamera = threeScene.perspCamera;

	// ---- Collision debug wireframes ----
	const MAX_COLLISION_VERTS = 4096;
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

	// ------------------------------------------------------------------
	// Vehicle spawn manager
	// ------------------------------------------------------------------
	const vehicles = new Map<number, PlayableVehicle>();
	let nextId = 1;
	let activeId = -1;
	let shahedSpawnCounter = 0;
	const typeCounters = new Map<VehicleType, number>();

	// ---- AI host (shared Lua behaviors) ----
	const aiHost = new LuaAIHost({
		isLand,
		gameData: buildClientGameData(),
	});
	let aiSimTime = 0;
	let aiErrors: string[] = [];
	const aiSettings = { enabled: true, aiForNewSpawns: true };

	function activePv(): PlayableVehicle | undefined {
		return vehicles.get(activeId);
	}

	function spawnVehicle(
		type: VehicleType,
		x: number,
		y: number,
		heading: number,
		opts?: { destination?: string },
	): PlayableVehicle {
		const id = nextId++;
		const count = (typeCounters.get(type) ?? 0) + 1;
		typeCounters.set(type, count);
		const behavior = BEHAVIOR_BY_TYPE[type];
		const pv: PlayableVehicle = {
			id,
			vehicle: createVehicle(type, x, y),
			faction: FACTION_BY_TYPE[type],
			label: `${TYPE_LABELS[type]} ${count}`,
			hp: 100,
			respawnTimer: 0,
			home: { x, y, heading },
			aiEnabled: behavior !== undefined && aiSettings.aiForNewSpawns,
			bot: behavior
				? {
						throttle: 0,
						rudder: 0,
						stamina: 1,
						waypoint_index: 0,
						target: 0,
						destination: opts?.destination ?? "oman",
					}
				: null,
		};
		pv.vehicle.heading = heading;
		vehicles.set(id, pv);
		rebuildSelectionDropdown();
		return pv;
	}

	function removeVehicle(id: number): void {
		vehicles.delete(id);
		if (activeId === id) {
			const first = vehicles.keys().next();
			setActive(first.done ? -1 : first.value);
		}
		rebuildSelectionDropdown();
	}

	function clearAll(): void {
		vehicles.clear();
		setActive(-1);
		rebuildSelectionDropdown();
	}

	function setActive(id: number): void {
		activeId = id;
		selection.active = id;
		throttleLevel = 0;
		const pv = activePv();
		autopilotOn = pv ? isTankerVehicle(pv.vehicle) : false;
		activeAIProxy.ai = pv?.aiEnabled ?? false;
		rebuildVehicleFolder();
	}

	function spawnAtSpawnPoint(type: VehicleType): PlayableVehicle {
		switch (type) {
			case "oil_tanker": {
				const spawn = pick(TANKER_SPAWNS);
				const { x, y, heading } = scatterAround(spawn);
				// Gulf spawns head east to Oman; Oman spawns head west into the Gulf
				const destination = spawn.group === "oman" ? "gulf" : "oman";
				return spawnVehicle(type, x, y, heading, { destination });
			}
			case "frigate":
			case "speedboat":
			case "quadcopter": {
				const spawns = {
					frigate: US_SPAWNS,
					speedboat: SPEEDBOAT_SPAWNS,
					quadcopter: QUADCOPTER_SPAWNS,
				}[type];
				const { x, y, heading } = scatterAround(pick(spawns));
				return spawnVehicle(type, x, y, heading);
			}
			case "shahed": {
				const spawn = IRAN_SPAWNS[shahedSpawnCounter++ % IRAN_SPAWNS.length];
				return spawnVehicle(
					type,
					spawn.position[0],
					spawn.position[1],
					spawn.heading ?? 0,
				);
			}
			case "truck":
				return spawnVehicle(type, TRUCK_SPAWN.x, TRUCK_SPAWN.y, 0);
			default:
				throw new Error(`no spawn point for vehicle type: ${type}`);
		}
	}

	function spawnStarterSet(): void {
		spawnVehicle("speedboat", 75746, 42781, Math.PI);
		spawnVehicle("frigate", 75540, 43226, Math.PI);
		spawnVehicle("oil_tanker", 75500, 43000, Math.PI);
		spawnVehicle("truck", TRUCK_SPAWN.x, TRUCK_SPAWN.y, Math.PI);
		spawnVehicle("quadcopter", 75700, 42900, Math.PI);
		spawnVehicle("shahed", 75600, 42850, Math.PI);
	}

	// Starter set is spawned after the GUI is built (spawn helpers touch GUI state).

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
	let mouseDownX = 0;
	let mouseDownY = 0;
	let isDragging = false;
	let lastMouseX = 0;
	let lastMouseY = 0;
	let mouseScreenX = 0;
	let mouseScreenY = 0;

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
		tpDistance: 3,
		tpHeight: 1.5,
		fpHeight: 0.5,
		fpForward: 0.3,
		smoothing: 8,
	};

	// ---- Simulation settings ----
	const simSettings = {
		timeScale: 1.0,
		paused: false,
		showCollisionPolygons: true,
	};

	const timeOfDay = {
		followRealTime: true,
		/** Strait local hour (GST) used when not following real time. */
		hour: 16.5,
		clock: "",
		sunElevation: 0,
	};

	// ---- Dev panel ----
	const gui = new GUI({ title: "Hormuz Playground" });

	// Vehicle stats folder — rebuilt when switching vehicles
	let vehicleFolder: GUI | null = null;

	function rebuildVehicleFolder() {
		if (vehicleFolder) vehicleFolder.destroy();
		const pv = activePv();
		if (!pv) {
			vehicleFolder = null;
			return;
		}
		const v = pv.vehicle;
		vehicleFolder = gui.addFolder(pv.label);
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
		vehicleFolder.close();
	}

	// ---- Spawn folder ----
	const selection = { active: activeId };
	const activeAIProxy = { ai: false };
	const spawnControls = {
		type: "frigate" as VehicleType,
		spawnAtCursor: false,
		count: vehicles.size,
		"Spawn at spawn point"() {
			const pv = spawnAtSpawnPoint(spawnControls.type);
			setActive(pv.id);
		},
		"Teleport active to cursor (T)"() {
			teleportActiveToCursor();
		},
		"Remove active (Del)"() {
			if (activeId !== -1) removeVehicle(activeId);
		},
		"Clear all"() {
			clearAll();
		},
	};

	function teleportActiveToCursor(): void {
		const pv = activePv();
		if (!pv) return;
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		pv.vehicle.x = world.x;
		pv.vehicle.y = world.y;
		pv.vehicle.speed = 0;
		pv.vehicle.drift = 0;
		pv.vehicle.angularVelocity = 0;
	}

	const spawnFolder = gui.addFolder("Spawn");
	spawnFolder.add(spawnControls, "type", VEHICLE_TYPES).name("Vehicle Type");
	spawnFolder.add(spawnControls, "Spawn at spawn point");
	spawnFolder
		.add(spawnControls, "spawnAtCursor")
		.name("Spawn at cursor (click map)")
		.listen();
	spawnFolder.add(spawnControls, "Teleport active to cursor (T)");
	spawnFolder.add(spawnControls, "Remove active (Del)");
	spawnFolder.add(spawnControls, "Clear all");
	spawnFolder.add(spawnControls, "count").name("Vehicles").listen().disable();

	let activeDropdown: Controller | null = null;

	function rebuildSelectionDropdown(): void {
		spawnControls.count = vehicles.size;
		if (activeDropdown) {
			activeDropdown.destroy();
			activeDropdown = null;
		}
		const options: Record<string, number> = {};
		for (const [id, pv] of vehicles) {
			options[`${pv.label} [${pv.faction}]`] = id;
		}
		if (Object.keys(options).length === 0) return;
		if (!vehicles.has(selection.active)) {
			selection.active = vehicles.keys().next().value ?? -1;
		}
		activeDropdown = spawnFolder
			.add(selection, "active", options)
			.name("Active vehicle")
			.listen()
			.onChange((id: number) => setActive(id));
		// Keep the dropdown at the top of the folder after rebuilds
		spawnFolder.$children.prepend(activeDropdown.domElement);
	}

	rebuildVehicleFolder();

	// Initial vehicles (after GUI so dropdown/folders reflect them)
	spawnStarterSet();
	setActive(vehicles.keys().next().value ?? -1);
	rebuildSelectionDropdown();
	const startPv = activePv();
	if (startPv) {
		cam.worldX = startPv.vehicle.x;
		cam.worldY = startPv.vehicle.y;
	}

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
	simFolder.add(simSettings, "paused").name("Paused (Space)").listen();
	simFolder.add(simSettings, "showCollisionPolygons").name("Show Collision");

	// ---- AI folder ----
	const aiFolder = gui.addFolder("AI");
	aiFolder.add(aiSettings, "enabled").name("Master AI enabled");
	aiFolder.add(aiSettings, "aiForNewSpawns").name("AI on new spawns");
	aiFolder
		.add(activeAIProxy, "ai")
		.name("Active vehicle AI")
		.listen()
		.onChange((v: boolean) => {
			const apv = activePv();
			if (apv?.bot) apv.aiEnabled = v;
		});
	const aiErrorDisplay = { lastError: "" };
	aiFolder
		.add(aiErrorDisplay, "lastError")
		.name("AI errors")
		.listen()
		.disable();

	// Live-tunable behavior constants (from shared/ai/config.lua)
	const aiConfigFlat = aiHost.getConfigFlat();
	const aiSections = new Map<string, Record<string, number>>();
	for (const [path, value] of Object.entries(aiConfigFlat)) {
		const section = path.split(".")[0];
		let group = aiSections.get(section);
		if (!group) {
			group = {};
			aiSections.set(section, group);
		}
		group[path] = value;
	}
	for (const [section, entries] of aiSections) {
		const folder = aiFolder.addFolder(section);
		for (const [path, value] of Object.entries(entries)) {
			const max = value <= 1 ? 2 : value <= 100 ? value * 3 : value * 2;
			folder
				.add(entries, path, 0, max)
				.name(path.slice(section.length + 1))
				.onChange((v: number) => aiHost.setConfig(path, v));
		}
		folder.close();
	}

	// ---- Collision tests (spawn fresh vehicles) ----
	function spawnPair(
		typeA: VehicleType,
		xA: number,
		yA: number,
		headingA: number,
		speedA: number,
		typeB: VehicleType,
		xB: number,
		yB: number,
		headingB: number,
		speedB: number,
	): [PlayableVehicle, PlayableVehicle] {
		const a = spawnVehicle(typeA, xA, yA, headingA);
		a.vehicle.speed = speedA;
		const b = spawnVehicle(typeB, xB, yB, headingB);
		b.vehicle.speed = speedB;
		return [a, b];
	}

	function focusOn(pv: PlayableVehicle, zoom: number): void {
		setActive(pv.id);
		mode.freeCamera = false;
		mode.cameraFollow = true;
		cam.worldX = pv.vehicle.x;
		cam.worldY = pv.vehicle.y;
		cam.zoom = zoom;
	}

	const collisionTests = {
		"T-bone collision"() {
			const [a] = spawnPair(
				"oil_tanker",
				75500,
				43000,
				0,
				14,
				"frigate",
				75700,
				42800,
				Math.PI / 2,
				26,
			);
			focusOn(a, 0.15);
		},
		"Head-on collision"() {
			const [a] = spawnPair(
				"oil_tanker",
				75300,
				43000,
				0,
				14,
				"frigate",
				75800,
				43000,
				Math.PI,
				26,
			);
			focusOn(a, 0.1);
		},
		"Speedboat rams tanker"() {
			const [a] = spawnPair(
				"speedboat",
				75350,
				42900,
				Math.PI / 6,
				52,
				"oil_tanker",
				75500,
				43000,
				0,
				8,
			);
			focusOn(a, 0.15);
		},
		"Destroy active vehicle"() {
			const pv = activePv();
			if (!pv || pv.hp <= 0) return;
			pv.hp = 0;
			pv.respawnTimer = RESPAWN_TIME;
			threeEffects.spawnExplosion(pv.vehicle.x, pv.vehicle.y);
			aiHost.addScent(pv.vehicle.x, pv.vehicle.y);
		},
		"Spawn explosion (no kill)"() {
			const pv = activePv();
			if (!pv) return;
			threeEffects.spawnExplosion(pv.vehicle.x, pv.vehicle.y);
			aiHost.addScent(pv.vehicle.x, pv.vehicle.y);
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
			const pv = activePv();
			if (pv) addBreach(pv.vehicle, -1);
		},
		"Damage Starboard"() {
			const pv = activePv();
			if (pv) addBreach(pv.vehicle, 1);
		},
		"Damage Center"() {
			const pv = activePv();
			if (pv) addBreach(pv.vehicle, 0);
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

	// ---- Scenario presets (group spawns) ----
	const presets = {
		"Starter set (6)"() {
			spawnStarterSet();
			const first = vehicles.keys().next();
			if (!first.done) {
				const pv = vehicles.get(first.value);
				if (pv) focusOn(pv, 0.3);
			}
		},
		"Convoy under attack"() {
			// 3 tankers steaming east along the outbound lane through the strait
			const lane = LANE_ALT_OUTBOUND;
			const tankerWps = [lane[3], lane[4], lane[5]];
			let lead: PlayableVehicle | null = null;
			for (let i = 0; i < tankerWps.length; i++) {
				const wp = tankerWps[i];
				const next = tankerWps[i + 1] ?? lane[6];
				const pv = spawnVehicle(
					"oil_tanker",
					wp[0],
					wp[1],
					headingBetween(wp, next),
				);
				if (i === tankerWps.length - 1) lead = pv;
			}
			// 2 frigate escorts, one north and one south of the convoy
			spawnVehicle("frigate", 83000, 46500, -0.2);
			spawnVehicle("frigate", 84500, 41500, 0.3);
			// 3 shaheds inbound from Iran spawns toward the lead tanker
			for (const idx of [0, 1, 3]) {
				const s = IRAN_SPAWNS[idx];
				spawnVehicle(
					"shahed",
					s.position[0],
					s.position[1],
					headingBetween(s.position, lane[5]),
				);
			}
			if (lead) focusOn(lead, 0.05);
		},
		"Speedboat wolf pack"() {
			// One speedboat per spawn point, converging on a lone tanker
			const lane = LANE_ALT_OUTBOUND;
			for (const s of SPEEDBOAT_SPAWNS) {
				spawnVehicle(
					"speedboat",
					s.position[0],
					s.position[1],
					s.heading ?? headingBetween(s.position, lane[5]),
				);
			}
			const tanker = spawnVehicle(
				"oil_tanker",
				lane[5][0],
				lane[5][1],
				headingBetween(lane[5], lane[6]),
			);
			focusOn(tanker, 0.05);
		},
		"Drone swarm vs frigate screen"() {
			const f1 = spawnVehicle("frigate", 84000, 44000, Math.PI * 0.9);
			spawnVehicle("frigate", 85000, 44600, Math.PI * 0.9);
			for (let i = 0; i < 4; i++) {
				const s = IRAN_SPAWNS[i % IRAN_SPAWNS.length];
				spawnVehicle(
					"shahed",
					s.position[0],
					s.position[1],
					headingBetween(s.position, [84500, 44300]),
				);
			}
			for (let i = 0; i < 2; i++) {
				const s = QUADCOPTER_SPAWNS[i];
				spawnVehicle(
					"quadcopter",
					s.position[0],
					s.position[1],
					headingBetween(s.position, [84500, 44300]),
				);
			}
			focusOn(f1, 0.04);
		},
		"CIWS Demo"() {
			const frig = spawnVehicle("frigate", 75540, 43226, 0);
			frig.vehicle.speed = 8;
			const shahed = spawnVehicle("shahed", 76540, 43426, Math.PI);
			shahed.vehicle.speed = 80;
			const quad = spawnVehicle("quadcopter", 75240, 43726, -Math.PI / 2);
			quad.vehicle.speed = 22;
			focusOn(frig, 0.12);
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
	};

	const presetsFolder = gui.addFolder("Presets");
	presetsFolder.add(presets, "Starter set (6)");
	presetsFolder.add(presets, "Convoy under attack");
	presetsFolder.add(presets, "Speedboat wolf pack");
	presetsFolder.add(presets, "Drone swarm vs frigate screen");
	presetsFolder.add(presets, "CIWS Demo");
	presetsFolder.add(presets, "Full Map");
	presetsFolder.add(presets, "Strait");
	presetsFolder.add(presets, "Follow Vehicle");

	// Time of day (lighting follows the strait's local time unless overridden)
	const timeFolder = gui.addFolder("Time of Day");
	timeFolder.add(timeOfDay, "followRealTime").name("Real strait time");
	timeFolder
		.add(timeOfDay, "hour", 0, 24, 0.05)
		.name("Hour (GST)")
		.onChange(() => {
			timeOfDay.followRealTime = false;
		})
		.listen();
	timeFolder.add(timeOfDay, "clock").name("Clock").listen().disable();
	timeFolder
		.add(timeOfDay, "sunElevation")
		.name("Sun elevation°")
		.listen()
		.disable();

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

	function handleClick(x: number, y: number): void {
		const world = screenToWorld(cam, x, y);
		if (spawnControls.spawnAtCursor) {
			const pv = spawnVehicle(spawnControls.type, world.x, world.y, Math.PI);
			setActive(pv.id);
			return;
		}
		// Select the nearest vehicle within a screen-space threshold
		let bestId = -1;
		let bestDistSq = 40 * 40;
		for (const [id, pv] of vehicles) {
			if (pv.hp <= 0) continue;
			const s = worldToScreen(cam, pv.vehicle.x, pv.vehicle.y);
			const dx = s.x - x;
			const dy = s.y - y;
			const dSq = dx * dx + dy * dy;
			if (dSq < bestDistSq) {
				bestDistSq = dSq;
				bestId = id;
			}
		}
		if (bestId !== -1) setActive(bestId);
	}

	canvas.addEventListener("mousedown", (e: MouseEvent) => {
		if (e.button === 0 || e.button === 1) {
			isDragging = true;
			mouseDownX = e.clientX;
			mouseDownY = e.clientY;
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

	canvas.addEventListener("mouseup", (e: MouseEvent) => {
		if (isDragging) {
			const moved = Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY);
			if (moved < 6) handleClick(e.clientX, e.clientY);
		}
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
		if (e.target instanceof HTMLInputElement) return;
		const key = e.key.toLowerCase();
		keysDown.add(key);

		const active = activePv();

		// Grab the wheel: any movement key disables AI on the active vehicle
		if (
			active?.aiEnabled &&
			(key === "w" ||
				key === "a" ||
				key === "s" ||
				key === "d" ||
				key.startsWith("arrow"))
		) {
			active.aiEnabled = false;
			activeAIProxy.ai = false;
		}

		// Stepped throttle for ships: ArrowUp/W increments, ArrowDown/S decrements
		if (active && isShipVehicle(active.vehicle) && !mode.freeCamera) {
			if (key === "arrowup" || key === "w") {
				throttleLevel = Math.min(10, throttleLevel + 1);
				e.preventDefault();
			} else if (key === "arrowdown" || key === "s") {
				throttleLevel = Math.max(-10, throttleLevel - 1);
				e.preventDefault();
			}
		}

		// Autopilot toggle: P key
		if (key === "p" && !e.repeat && active && isTankerVehicle(active.vehicle)) {
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

		// Space: pause
		if (e.key === " " && !e.repeat) {
			e.preventDefault();
			simSettings.paused = !simSettings.paused;
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

		// T: teleport active vehicle to cursor
		if (key === "t" && !e.repeat) {
			teleportActiveToCursor();
		}

		// Delete/Backspace: remove active vehicle
		if ((e.key === "Delete" || e.key === "Backspace") && activeId !== -1) {
			removeVehicle(activeId);
		}

		// [ / ]: cycle through vehicles
		if ((key === "[" || key === "]") && vehicles.size > 0 && !e.repeat) {
			const ids = [...vehicles.keys()];
			const idx = ids.indexOf(activeId);
			const next =
				key === "["
					? ids[(idx - 1 + ids.length) % ids.length]
					: ids[(idx + 1) % ids.length];
			setActive(next);
		}

		// 1-9: select nth vehicle
		const digit = Number.parseInt(e.key);
		if (digit >= 1 && digit <= 9) {
			const ids = [...vehicles.keys()];
			if (digit - 1 < ids.length) {
				setActive(ids[digit - 1]);
				mode.freeCamera = false;
				mode.cameraFollow = true;
			}
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

		// Clamp so a long frame (e.g. a shader-compile hitch) can't destabilise the
		// camera follow (gain × dt > 2 diverges) or tunnel vehicles through land.
		const rawDt = Math.min((now - lastTime) / 1000, 0.1);
		lastTime = now;
		const dt = simSettings.paused ? 0 : rawDt * simSettings.timeScale;

		const pv = activePv();

		// -- Input --
		const input: VehicleInput = { throttle: 0, rudder: 0 };
		if (!mode.freeCamera && pv) {
			const ship = isShipVehicle(pv.vehicle);
			if (ship) {
				input.throttle = throttleLevel / 10;
			} else {
				if (keysDown.has("w") || keysDown.has("arrowup")) input.throttle = 1;
				if (keysDown.has("s") || keysDown.has("arrowdown")) input.throttle = -1;
			}
			if (!autopilotOn) {
				if (keysDown.has("a") || keysDown.has("arrowleft")) input.rudder = -1;
				if (keysDown.has("d") || keysDown.has("arrowright")) input.rudder = 1;
			}
		} else if (mode.freeCamera) {
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
		for (const rp of vehicles.values()) {
			if (rp.hp <= 0) {
				rp.respawnTimer -= dt;
				if (rp.respawnTimer <= 0) {
					rp.hp = 100;
					rp.respawnTimer = 0;
					rp.vehicle.x = rp.home.x;
					rp.vehicle.y = rp.home.y;
					rp.vehicle.heading = rp.home.heading;
					rp.vehicle.speed = 0;
					rp.vehicle.drift = 0;
					rp.vehicle.angularVelocity = 0;
					rp.vehicle.floodLevel = 0;
					rp.vehicle.listAngle = 0;
					rp.vehicle.hullBreaches = 0;
					rp.vehicle.breachSide = 0;
					if (rp.bot) {
						rp.bot.throttle = 0;
						rp.bot.rudder = 0;
						rp.bot.stamina = 1;
						rp.bot.waypoint_index = 0;
						rp.bot.target = 0;
					}
				}
			}
		}

		// -- AI (shared Lua behaviors) --
		if (aiSettings.enabled && dt > 0) {
			const snapshots: AIEntitySnapshot[] = [];
			for (const [id, ep] of vehicles) {
				if (ep.hp <= 0) continue;
				const v = ep.vehicle;
				const snap: AIEntitySnapshot = {
					id,
					type: v.vehicleType,
					faction: ep.faction,
					x: v.x,
					y: v.y,
					heading: v.heading,
					speed: v.speed,
					hp: ep.hp,
					airborne: v.airborne,
					size: v.size,
				};
				if (ep.aiEnabled && ep.bot) {
					snap.behavior = BEHAVIOR_BY_TYPE[v.vehicleType];
					snap.bot = ep.bot;
				}
				snapshots.push(snap);
			}
			aiSimTime += dt;
			const result = aiHost.compute(snapshots, dt, aiSimTime);
			aiErrors = result.errors;
			for (const c of result.controls) {
				const ep = vehicles.get(c.id);
				if (!ep?.bot) continue;
				ep.bot.throttle = c.throttle;
				ep.bot.rudder = c.rudder;
				ep.bot.target = c.target;
				ep.bot.waypoint_index = c.waypoint_index;
				ep.bot.stamina = c.stamina;
			}
		}

		// -- Update all alive vehicles (save positions for collision rollback) --
		const prevPositions = new Map<number, { x: number; y: number }>();
		for (const [id, ep] of vehicles) {
			prevPositions.set(id, { x: ep.vehicle.x, y: ep.vehicle.y });
		}

		const aliveVehicles: NavalVehicle[] = [];
		for (const [id, ep] of vehicles) {
			if (ep.hp <= 0) continue;
			if (ep.aiEnabled && ep.bot) {
				updateVehicle(
					ep.vehicle,
					{ throttle: ep.bot.throttle, rudder: ep.bot.rudder },
					dt,
				);
			} else if (id === activeId && !mode.freeCamera) {
				updateVehicle(ep.vehicle, input, dt);
			} else {
				updateVehicle(ep.vehicle, { throttle: 0, rudder: 0 }, dt);
			}
			aliveVehicles.push(ep.vehicle);
		}

		// -- Collisions (alive vehicles only) --
		for (const [id, ep] of vehicles) {
			if (ep.hp <= 0) continue;
			const prev = prevPositions.get(id);
			if (prev) resolveTerrainCollision(ep.vehicle, prev.x, prev.y);
		}
		resolveVehicleCollisions(aliveVehicles);

		// -- Flooding simulation --
		for (const ep of vehicles.values()) {
			if (ep.hp <= 0) continue;
			updateFlooding(ep.vehicle, dt);
			if (ep.vehicle.floodLevel >= 1) {
				ep.hp = 0;
				ep.respawnTimer = RESPAWN_TIME;
				aiHost.addScent(ep.vehicle.x, ep.vehicle.y);
			}
		}

		// -- Camera follow --
		if (mode.cameraFollow && pv) {
			const v = pv.vehicle;
			const followSpeed = 5;
			const altOffset = v.airborne ? 30 : 0;
			cam.worldX += (v.x - altOffset - cam.worldX) * followSpeed * rawDt;
			cam.worldY += (v.y - altOffset - cam.worldY) * followSpeed * rawDt;
		}

		// -- Update perspective camera for first/third-person modes --
		if (mode.cameraMode !== "isometric" && pv) {
			const v = pv.vehicle;
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
		const entityStates: EntityState[] = [];
		for (const [id, ep] of vehicles) {
			entityStates.push({
				id,
				vehicleType: ep.vehicle.vehicleType,
				faction: ep.faction,
				x: ep.vehicle.x,
				y: ep.vehicle.y,
				heading: ep.vehicle.heading,
				speed: ep.vehicle.speed,
				drift: ep.vehicle.drift,
				hp: ep.hp,
				angularVelocity: ep.vehicle.angularVelocity,
				floodLevel: ep.vehicle.floodLevel,
				listAngle: ep.vehicle.listAngle,
			});
		}

		// -- Update Three.js renderers --
		const lightingTime = timeOfDay.followRealTime
			? new Date()
			: atStraitHour(new Date(), timeOfDay.hour);
		threeScene.environment.setTime(lightingTime);
		timeOfDay.clock = formatStraitTime(lightingTime);
		timeOfDay.sunElevation = Math.round(
			straitSolarPosition(lightingTime).elevation,
		);
		// In perspective modes, use the ortho zoom that shows the followed
		// vehicle at the same size, so pixel-sized effects and IFF rings match.
		let effectZoom = cam.zoom;
		if (mode.cameraMode !== "isometric" && pv) {
			const distance = pv.vehicle.size * perspSettings.tpDistance;
			const halfFov = (perspCamera.fov * Math.PI) / 360;
			effectZoom =
				cam.screenWidth / (Math.sqrt(6) * 2 * distance * Math.tan(halfFov));
		}
		threeVehicles.update(
			entityStates,
			activeId === -1 ? null : activeId,
			pv?.vehicle.vehicleType ?? "",
			FACTION_COLORS,
			effectZoom,
		);
		ciwsController.update(
			entityStates,
			(id) => threeVehicles.getCiwsTurret(id),
			dt,
			effectZoom,
		);
		threeEffects.update(entityStates, dt, effectZoom);

		// -- Collision debug wireframes --
		let vertexCount = 0;
		if (simSettings.showCollisionPolygons) {
			for (const ep of vehicles.values()) {
				if (ep.hp <= 0) continue;
				const verts = COLLISION_POLYGONS[ep.vehicle.vehicleType];
				if (!verts) continue;
				const cos = Math.cos(ep.vehicle.heading);
				const sin = Math.sin(ep.vehicle.heading);
				const sz = ep.vehicle.size;
				const elev = ep.vehicle.airborne
					? getElevation(ep.vehicle.x, ep.vehicle.y) + 30.5
					: getElevation(ep.vehicle.x, ep.vehicle.y) + 0.5;
				for (let k = 0; k < verts.length; k++) {
					if (vertexCount + 2 > MAX_COLLISION_VERTS) break;
					const [lx0, ly0] = verts[k];
					const [lx1, ly1] = verts[(k + 1) % verts.length];
					const wx0 = ep.vehicle.x + (lx0 * cos - ly0 * sin) * sz;
					const wy0 = ep.vehicle.y + (lx0 * sin + ly0 * cos) * sz;
					const wx1 = ep.vehicle.x + (lx1 * cos - ly1 * sin) * sz;
					const wy1 = ep.vehicle.y + (lx1 * sin + ly1 * cos) * sz;
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
			threeScene.renderPerspective();
		}

		// -- HUD --
		aiErrorDisplay.lastError = aiErrors.at(-1) ?? "";
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		const camLabel =
			mode.cameraMode !== "isometric"
				? `[${mode.cameraMode.toUpperCase()}]`
				: mode.freeCamera
					? "[FREE CAM]"
					: "[FOLLOW]";
		const spawnHint = spawnControls.spawnAtCursor
			? `  CLICK MAP = spawn ${TYPE_LABELS[spawnControls.type]}`
			: "";
		const pausedStr = simSettings.paused ? "  PAUSED" : "";
		coordEl.textContent = `Cursor: (${Math.round(world.x)}, ${Math.round(world.y)})  Elev: ${getElevation(world.x, world.y).toFixed(0)}  Zoom: ${cam.zoom.toFixed(3)}  ${camLabel}  Time: ${simSettings.timeScale.toFixed(1)}x${pausedStr}${spawnHint}`;
		if (pv) {
			const v = pv.vehicle;
			const hpStr =
				pv.hp <= 0 ? `DEAD (${pv.respawnTimer.toFixed(1)}s)` : `HP: ${pv.hp}`;
			const eqSpd = equilibriumSpeed(v);
			const floodStr =
				v.floodLevel > 0
					? `  Flood: ${(v.floodLevel * 100).toFixed(0)}%  List: ${((v.listAngle * 180) / Math.PI).toFixed(1)}°`
					: "";
			const controlHint = isShipVehicle(v)
				? "arrows steer/throttle, P autopilot"
				: "WASD";
			const aiStr =
				pv.aiEnabled && pv.bot
					? `  AI:${BEHAVIOR_BY_TYPE[v.vehicleType]}${pv.bot.target !== 0 ? ` tgt:${pv.bot.target}` : ""}${v.vehicleType === "speedboat" ? ` stam:${pv.bot.stamina.toFixed(2)}` : ""}`
					: "";
			boatEl.textContent = `${pv.label} [${pv.faction}]: ${hpStr}  Speed: ${v.speed.toFixed(1)} kn (max ${eqSpd.toFixed(0)})  Heading: ${((v.heading * 180) / Math.PI).toFixed(0)}°${floodStr}${aiStr}  (${vehicles.size} vehicles, [ ] cycle, ${controlHint})`;
		} else {
			boatEl.textContent = `No vehicles — spawn one from the Spawn panel (${vehicles.size} vehicles)`;
		}

		// -- Throttle bar --
		const showThrottle = pv ? isShipVehicle(pv.vehicle) : false;
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
		const showAp = pv ? isTankerVehicle(pv.vehicle) : false;
		apBadge.style.display = showAp ? "block" : "none";
		if (showAp) {
			apBadge.style.backgroundColor = autopilotOn ? "#00aa44" : "#555555";
			apBadge.style.color = autopilotOn ? "#ffffff" : "#999999";
		}
	}

	requestAnimationFrame(frame);

	console.log(
		"Hormuz playground — WASD drive, arrows steer/throttle (ships), P autopilot (tanker), click select vehicle, [ ] cycle, T teleport to cursor, Del remove, Space pause, Tab free camera, V camera mode, scroll zoom",
	);
}

void init();
