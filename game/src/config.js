// Palmira Heat — every tuning number, name and colour in one place. The world is a big
// pixel map the camera roams over; no rule below depends on the size of the screen.

/** The simulation's fixed step, in seconds: 60 updates a second whatever the display's rate. */
export const STEP = 1 / 60;

// ---------------------------------------------------------------------------
// City geometry. A grid of blocks separated by roads; the bay lies to the east.
// ---------------------------------------------------------------------------

export const ROAD_W = 96; // width of a road, curb to curb
export const BLOCK = 216; // a city block's interior, sidewalk edge to sidewalk edge
export const PITCH = ROAD_W + BLOCK; // distance between neighbouring road centrelines
export const COLS = 13; // blocks across (west -> east)
export const ROWS = 10; // blocks down (north -> south)

export const CITY_W = COLS * PITCH + ROAD_W;
export const CITY_H = ROWS * PITCH + ROAD_W;
export const BEACH_W = 150; // sand strip between the last avenue and the water
export const WATER_W = 430; // the bay, to the world's east edge
export const WORLD_W = CITY_W + BEACH_W + WATER_W;
export const WORLD_H = CITY_H;

export const SIDEWALK = 14; // pavement ring inside each block
export const LANE = ROAD_W / 4; // lane-centre offset from a road's centreline

// ---------------------------------------------------------------------------
// Rio, on foot.
// ---------------------------------------------------------------------------

export const PLAYER = {
  radius: 13,
  walk: 152,
  run: 252,
  health: 100,
  armor: 100,
  fireInterval: 0.16,
  bulletDamage: 34,
  reach: 30, // how close he must be to a car door to get in
};

// ---------------------------------------------------------------------------
// Cars. Speeds are pixels per second; `top` is the car's own ceiling.
// ---------------------------------------------------------------------------

export const CAR_TYPES = {
  sedan: { len: 76, wid: 37, top: 318, accel: 225, grip: 3.4, name: 'Marina Sedan' },
  coupe: { len: 74, wid: 36, top: 356, accel: 265, grip: 3.7, name: 'Cayo Coupe' },
  sport: { len: 78, wid: 38, top: 428, accel: 330, grip: 4.1, name: 'Comet S' },
  taxi: { len: 76, wid: 37, top: 322, accel: 232, grip: 3.4, name: 'Palm Cab' },
  pickup: { len: 82, wid: 40, top: 296, accel: 208, grip: 3.0, name: 'Verde Pickup' },
  van: { len: 88, wid: 42, top: 272, accel: 178, grip: 2.7, name: 'Cargo Van' },
  armored: { len: 90, wid: 43, top: 252, accel: 168, grip: 2.6, name: 'Bastion Armored Van' },
  police: { len: 78, wid: 38, top: 392, accel: 305, grip: 3.9, name: 'PD Interceptor' },
};

/** Paint jobs for civilian cars (body colour, roof colour). */
export const CAR_PAINTS = [
  ['#c23b2e', '#8e271e'], ['#2e6fc2', '#1d4a85'], ['#e8e4da', '#b9b4a6'], ['#23262b', '#101216'],
  ['#e0a51f', '#a97812'], ['#3fae6a', '#27784a'], ['#7a4fc0', '#54337f'], ['#c2662e', '#8a431c'],
  ['#2fb3a8', '#1f7d76'], ['#d96a92', '#a34468'], ['#8a929c', '#5d646d'], ['#5b7fa6', '#3c5876'],
  ['#a83232', '#6f1f1f'], ['#31572c', '#1e381b'], ['#e6e6fa', '#b9b9d6'], ['#40372f', '#241e19'],
];

export const TRAFFIC_COUNT = 20;
export const PARKED_COUNT = 46;
export const PED_COUNT = 52;

// ---------------------------------------------------------------------------
// The law. Heat is a 0..560 score; the stars are bands across it.
// ---------------------------------------------------------------------------

export const HEAT = {
  cap: 560,
  bands: [60, 150, 260, 380, 500], // heat at which stars 1..5 light up
  theft: 110,
  pedDown: 120,
  gunfire: 55,
  hitCar: 26,
  hitPolice: 135,
  officerDown: 225,
  unwitnessed: 8, // a crime nobody saw still smells a little
  witnessRadius: 250,
  decayDelay: 6, // seconds out of sight before heat starts to cool
  decayRate: 15, // heat per second while cooling
  gunfireThrottle: 0.5, // seconds between gunfire heat charges
};

/** How many patrol cars the city fields at each wanted level (index = stars). */
export const POLICE_UNITS = [0, 1, 2, 3, 4, 6];
export const OFFICER = { health: 70, speed: 168, damage: 6, fireInterval: 0.85, range: 265 };

export const BUST = { seconds: 1.7, radiusCar: 58, radiusFoot: 34, drain: 0.9 };
export const BUST_FINE = 250;
export const WASTED_FEE = 300;
export const RESPRAY_FEE = 400;

// ---------------------------------------------------------------------------
// Time. One full day lasts DAY_SECONDS of play; the clock starts mid-morning.
// ---------------------------------------------------------------------------

export const DAY_SECONDS = 480;
export const START_HOUR = 10.2;

// ---------------------------------------------------------------------------
// Names — every one of them invented for Palmira.
// ---------------------------------------------------------------------------

export const DISTRICTS = [
  'Old Port', 'Coral Heights', 'Downtown', 'Neon Mile', 'Cayo Verde',
  'The Flats', 'Palm Grove', 'University District', 'Dockside', 'Azure Beach',
];

export const BUSINESSES = [
  'Café Sol', 'Club Neptune', 'Faro Records', 'Tacos Marino', 'Azure Hotel', 'Palma Bank',
  'Noodle Bay', 'Gym Titán', 'La Sirena Bar', 'Onda Electronics', 'Flamingo Diner', 'Casa Verde',
  'Neptune Arcade', 'Sol Pharmacy', 'Marina Books', 'Taller Ruiz', 'Hotel Brisa', 'Café Duende',
  'Palmira Ink', 'Bar El Faro', 'Mercado Azul', 'Studio 9', 'Heladería Lola', 'Club Coral',
];

export const RADIO_STATIONS = [
  'Radio Onda 98.1', 'Palmira FM 103.7', 'Radio Faro', 'Club Neptune FM', 'Onda Tropical 88.3', 'Azure Wave Radio',
];

export const SAVE_KEY = 'palmira-heat.save.v2';
export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// ---------------------------------------------------------------------------
// Palette: the fixed colours the renderer grades by the time of day.
// ---------------------------------------------------------------------------

export const PALETTE = {
  asphalt: '#33373d',
  asphaltDark: '#2b2f34',
  curb: '#9aa0a3',
  sidewalk: '#8f9296',
  sidewalkLine: '#7e8184',
  blockBase: '#6f7a68',
  sand: '#dec491',
  sandWet: '#c9ab72',
  water: '#1d6f8e',
  waterDeep: '#14506e',
  grass: '#5d8a4e',
  trunk: '#7a5a3a',
  frond: '#3e7d3a',
  hudText: '#f2f0e9',
  hudMuted: '#b9bdc4',
  gold: '#f2c94c',
  danger: '#e5534b',
  policeBlue: '#3f7de0',
  policeRed: '#e0483e',
};
