// Every tuning number and colour for Palmira Heat in one place. The world is a top-down city
// measured in pixels; the renderer draws a camera window of it, so no rule below depends on the
// screen size. All distances are world pixels, all times are seconds of simulation.

/** The simulation's fixed step, in seconds: 60 updates a second whatever the display's rate. */
export const STEP = 1 / 60;

/** The city grid: COLS x ROWS blocks, each BLOCK of building ground wrapped by roads. */
export const GRID = {
  cols: 13,
  rows: 10,
  /** Building ground inside one block (the square between the sidewalks). */
  block: 196,
  /** Sidewalk width around each block. */
  walk: 18,
  /** Road width between two sidewalks. */
  road: 56,
};
/** Distance between neighbouring road centrelines. */
export const PITCH = GRID.block + GRID.walk * 2 + GRID.road;
/** Sand strip east of the last road, then the sea. */
export const BEACH = { sand: 210, water: 900 };
export const CITY_W = GRID.cols * PITCH + GRID.road + BEACH.sand + BEACH.water;
export const CITY_H = GRID.rows * PITCH;

export const PLAYER = {
  radius: 11,
  walkSpeed: 138,
  runSpeed: 238,
  health: 100,
  armor: 100,
  /** Seconds a fresh spawn is protected from harm, so a respawn is never an instant re-kill. */
  grace: 1.2,
};

export const CAR = {
  width: 46,
  length: 92,
  /** Collision radius used against circles (peds, props, other cars). */
  radius: 26,
  accel: 340,
  brake: 620,
  reverse: 150,
  drag: 0.55,
  /** Top speeds by class, px/s. */
  topSpeed: { sedan: 430, sport: 560, taxi: 430, van: 360, police: 520, truck: 330 },
  steer: 2.35,
};

export const TRAFFIC = {
  count: 19,
  speed: 215,
  /** Parked cars sprinkled along the streets at world build. */
  parked: 46,
};

export const PEDS = { count: 54, walkSpeed: 62, fleeSpeed: 168 };

/** Original Palmira radio stations, announced on the HUD whenever Rio gets into a car. */
export const RADIO_STATIONS = [
  'RADIO ONDA 98.1',
  'PALMIRA FM 103.7',
  'RADIO FARO — SALSA Y SOL',
  'CLUB NEPTUNE FM',
  'ONDA TROPICAL 88.3',
  'AZURE WAVE RADIO',
];

export const WANTED = {
  /** Heat points per star; heat decays when unseen. */
  perStar: 100,
  maxStars: 5,
  decayPerSecond: 7,
  /** Grace after a crime before decay may resume, seconds. */
  seenHold: 4,
  /** Police cars the city fields at each star level (index = stars). */
  policeCars: [0, 1, 2, 3, 4, 6],
  bustFillSeconds: 2.6,
  bustRadius: 96,
};

export const GUN = {
  damage: 34,
  range: 430,
  cooldown: 0.21,
  spread: 0.035,
};

export const OFFICER = {
  health: 100,
  damage: 7,
  cooldown: 0.85,
  range: 330,
  speed: 148,
};

export const CLOCK = {
  /** One game hour lasts this many real seconds; a full day is 12 minutes. */
  secondsPerHour: 30,
  startHour: 10.25,
};

export const ECONOMY = {
  startCash: 120,
  bustFine: 250,
  wastedFee: 300,
  resprayFee: 400,
};

export const TAXI = {
  baseFare: 25,
  perPixel: 0.045,
  /** Bonus fraction for a fast, clean run. */
  speedBonus: 0.5,
};

export const SAVE_KEY = 'palmira-heat.save.v1';

export const PALETTE = {
  road: '#33373d',
  roadEdge: '#2b2f34',
  lane: '#c8b25a',
  crosswalk: '#d8d8d2',
  sidewalk: '#9aa0a3',
  curb: '#7d8387',
  grass: '#4d7c46',
  sand: '#e3cd96',
  waterDeep: '#14506e',
  water: '#1d6f96',
  waterFoam: '#bfe6ef',
  roofShadow: '#00000055',
  nightOverlay: '#0a1030',
  text: '#f4f1e8',
  muted: '#b9bec9',
  accent: '#ffb347',
  danger: '#ff5347',
  good: '#7dd069',
  cash: '#8fe388',
  star: '#ffd94d',
  starOff: '#4a4f58',
  panel: '#14181fdd',
  panelEdge: '#ffb347',
  health: '#e8483f',
  armor: '#4d9de0',
  marker: '#ffd94d',
  policeBlip: '#5aa2ff',
  playerBlip: '#ffffff',
};

/** Building paint jobs, picked by the seeded RNG at city build. */
export const BUILDING_COLORS = [
  '#c96f4a', '#d9a05b', '#b8524f', '#7f9fb5', '#5f7f95', '#a3b18a', '#e0c084', '#8d6e9f',
  '#4f7d7a', '#d1788f', '#68707d', '#b08968', '#5b8e7d', '#e07a5f', '#81b29a', '#f2cc8f',
];

export const CAR_COLORS = ['#c0392b', '#2471a3', '#229954', '#b7950b', '#7d3c98', '#ba4a00', '#616a6b', '#aed6f1', '#f5b7b1', '#f9e79f', '#d5d8dc', '#2e4053'];

export const DISTRICTS = [
  'Old Port', 'Marina Bay', 'Downtown Palmira', 'Coral Flats', 'Azure Shore',
  'Palm Heights', 'The Cannery', 'Harbour View', 'Solana District', 'Costa Verde',
];

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
