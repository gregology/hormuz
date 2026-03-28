/** Map color palette */
export const COLORS = {
	deepWater: 0x0a1628,
	water: 0x1a3a5c,
	shallowWater: 0x1e4868, // 10-30m depth
	veryShallowWater: 0x24587a, // <10m depth
	deepChannel: 0x142e48, // >30m deep-water route
	land: 0xc2a366,
	landBorder: 0x8b7340,
	island: 0xd4b87a,
	islandBorder: 0x9e854d,
	shoal: 0x2e6888,
	shoalBorder: 0x3a7898,
	rock: 0x3d2b1f,
	laneInbound: 0x44aa44,
	laneOutbound: 0xaa4444,
	laneCenter: 0x888888,
	deepWaterRoute: 0x3388bb,
	spawnIran: 0x27ae60,
	spawnUS: 0x2980b9,
	spawnTanker: 0xf39c12,
	grid: 0x1a2a3a,
	// Terrain hillshade
	hillShadow: 0x000000,
	hillHighlight: 0xffffff,
} as const;
