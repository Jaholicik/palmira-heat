// Palmira, built once from the seed: a 13 x 10 grid of blocks between asphalt roads, with
// the sand and the bay down the east edge. Everything the simulation and the renderer need
// to know about the static world — buildings, trees, lamps, docks, the special buildings —
// is decided here, deterministically, so every visit and every staged scene is identical.
import {
  BEACH_W, BLOCK, BUSINESSES, CITY_H, CITY_W, COLS, PITCH, ROAD_W, ROWS, SIDEWALK, WATER_W,
} from './config.js';

/** The centreline x of vertical road i (0..COLS), and y of horizontal road j (0..ROWS). */
export function roadX(i) { return i * PITCH; }
export function roadY(j) { return j * PITCH; }

/** The interior rect of block (i, j): sidewalk edge to sidewalk edge. */
export function blockRect(i, j) {
  return { x: i * PITCH + ROAD_W / 2, y: j * PITCH + ROAD_W / 2, w: BLOCK, h: BLOCK };
}

export function isRoad(x, y) {
  if (x < 0 || y < 0 || x > CITY_W || y > CITY_H) return false;
  const mx = x % PITCH;
  const my = y % PITCH;
  return mx < ROAD_W / 2 || mx > PITCH - ROAD_W / 2 || my < ROAD_W / 2 || my > PITCH - ROAD_W / 2;
}

export function isWater(x) { return x > CITY_W + BEACH_W; }
export function isSand(x) { return x > CITY_W && x <= CITY_W + BEACH_W; }

/** Which named district a point falls in (the HUD reads this under the clock). */
export function districtAt(x, y) {
  const nx = x / CITY_W;
  const ny = y / CITY_H;
  if (x > CITY_W) return 'Azure Beach';
  if (nx > 0.86) return ny < 0.52 ? 'Azure Beach' : 'Dockside';
  if (nx > 0.62) return 'Neon Mile';
  if (nx > 0.42) return ny < 0.55 ? 'Downtown' : 'Palm Grove';
  if (nx > 0.22) return ny < 0.45 ? 'Coral Heights' : ny < 0.75 ? 'University District' : 'The Flats';
  return ny < 0.5 ? 'Old Port' : 'Cayo Verde';
}

const FACADES = [
  '#c9b8a3', '#b7c3c9', '#d9c9b0', '#a8b8a0', '#c4a29a', '#9fb4c7', '#d6d0c2', '#bfae8e',
  '#a3a8b8', '#cbb7d9', '#e0cf9f', '#94a8a8', '#c98f6a', '#8fa3bf', '#d9a0a8', '#b5c49a',
];
const ROOFS = ['#6b5a4a', '#5d6468', '#77685a', '#4f5a60', '#6e5f52', '#585f66'];
const AWNINGS = ['#c23b2e', '#2e6fc2', '#3fae6a', '#e0a51f', '#7a4fc0', '#2fb3a8', '#d96a92'];
const NEONS = ['#ff5d8f', '#38e1ff', '#ffd23e', '#7dff6a', '#ff8a3e', '#c07dff', '#3effc8'];

export function buildCity(random) {
  const buildings = [];
  const trees = [];
  const lamps = [];
  const props = []; // {kind, x, y, w, h, color, solid}
  const parks = [];
  const parkingSpots = []; // {x, y, angle} — where parked cars sit
  let businessIndex = Math.floor(random() * BUSINESSES.length);

  const specialBlocks = new Map();
  specialBlocks.set('2,2', 'pd');
  specialBlocks.set('10,1', 'hospital');
  specialBlocks.set('6,7', 'respray');
  specialBlocks.set('7,3', 'bank');

  function addBuilding(x, y, w, h, opts = {}) {
    const height = opts.height ?? (10 + random() * 26);
    const b = {
      x, y, w, h,
      height,
      facade: opts.facade ?? FACADES[Math.floor(random() * FACADES.length)],
      roof: opts.roof ?? ROOFS[Math.floor(random() * ROOFS.length)],
      seed: Math.floor(random() * 1e9),
      shop: null,
      special: opts.special ?? null,
      sign: opts.sign ?? null,
      roofProps: [],
    };
    if (opts.shop) {
      businessIndex = (businessIndex + 1 + Math.floor(random() * 3)) % BUSINESSES.length;
      b.shop = {
        name: BUSINESSES[businessIndex],
        awning: AWNINGS[Math.floor(random() * AWNINGS.length)],
        neon: NEONS[Math.floor(random() * NEONS.length)],
      };
    }
    const propRoll = random();
    if (propRoll < 0.34) {
      const n = 1 + Math.floor(random() * 3);
      for (let k = 0; k < n; k += 1) {
        b.roofProps.push({ kind: 'ac', dx: 8 + random() * Math.max(8, w - 34), dy: 8 + random() * Math.max(8, h - 30), w: 15 + random() * 10, h: 12 + random() * 8 });
      }
    } else if (propRoll < 0.46 && w > 60 && h > 60) {
      b.roofProps.push({ kind: 'tower', dx: w / 2 - 9, dy: h / 2 - 9, w: 18, h: 18 });
    }
    buildings.push(b);
    return b;
  }

  function addTree(x, y, scale = 1) {
    trees.push({ x, y, phase: random() * Math.PI * 2, size: (0.85 + random() * 0.4) * scale });
  }

  function addSpecial(kind, i, j) {
    const r = blockRect(i, j);
    const inner = { x: r.x + SIDEWALK, y: r.y + SIDEWALK, w: r.w - SIDEWALK * 2, h: r.h - SIDEWALK * 2 };
    if (kind === 'pd') {
      const b = addBuilding(inner.x + 18, inner.y + 8, inner.w - 36, 96, { height: 20, special: 'pd', sign: 'PALMIRA PD', facade: '#aebfd2', roof: '#4c5a68' });
      return { kind, block: r, building: b, door: { x: r.x + r.w / 2, y: r.y + r.h - 4 } };
    }
    if (kind === 'hospital') {
      const b = addBuilding(inner.x + 14, inner.y + 8, inner.w - 28, 104, { height: 30, special: 'hospital', sign: 'ST. AZURE HOSPITAL', facade: '#e8ecec', roof: '#7a8894' });
      return { kind, block: r, building: b, door: { x: r.x + r.w / 2, y: r.y + r.h - 4 } };
    }
    if (kind === 'bank') {
      const b = addBuilding(inner.x + 22, inner.y + 10, inner.w - 44, 92, { height: 24, special: 'bank', sign: 'PALMA BANK', facade: '#c9bfa5', roof: '#5d5648' });
      return { kind, block: r, building: b, door: { x: r.x + r.w / 2, y: r.y + r.h - 4 } };
    }
    // Respray: the building sits at the back of the block; the drive-in bay is the open
    // apron in front of it, so a car can roll in off the street.
    const b = addBuilding(inner.x + 10, inner.y + 6, inner.w - 20, 62, { height: 13, special: 'respray', sign: 'SHINE & GO RESPRAY', facade: '#d8cf9f', roof: '#6a6250' });
    const bay = { x: r.x + r.w / 2 - 56, y: r.y + r.h - 96, w: 112, h: 82 };
    return { kind, block: r, building: b, bay, door: { x: r.x + r.w / 2, y: r.y + r.h - 4 } };
  }

  const specials = {};
  for (const [key, kind] of specialBlocks) {
    const [i, j] = key.split(',').map(Number);
    specials[kind] = addSpecial(kind, i, j);
  }
  // Pier 9: a working pier on the Dockside shore, and the apron point missions deliver to.
  const pierY = roadY(8);
  specials.pier = {
    kind: 'pier',
    rect: { x: CITY_W + BEACH_W - 14, y: pierY - 46, w: 210, h: 92 },
    point: { x: CITY_W + 66, y: pierY },
  };

  // Decide the flavour of every ordinary block: buildings, a park, or a parking lot.
  const parkBlocks = new Set();
  const lotBlocks = new Set();
  for (let i = 0; i < COLS; i += 1) {
    for (let j = 0; j < ROWS; j += 1) {
      const key = `${i},${j}`;
      if (specialBlocks.has(key)) continue;
      if (i >= 11 && j >= 6) continue; // Dockside: warehouses and yards, handled below
      const roll = random();
      if (roll < 0.07) parkBlocks.add(key);
      else if (roll < 0.16) lotBlocks.add(key);
    }
  }

  for (let i = 0; i < COLS; i += 1) {
    for (let j = 0; j < ROWS; j += 1) {
      const key = `${i},${j}`;
      if (specialBlocks.has(key)) continue;
      const r = blockRect(i, j);
      const inner = { x: r.x + SIDEWALK, y: r.y + SIDEWALK, w: r.w - SIDEWALK * 2, h: r.h - SIDEWALK * 2 };
      if (i >= 11 && j >= 6) {
        // Dockside warehouses: one long low shed per block, containers stacked in the yard.
        addBuilding(inner.x + 6, inner.y + 10, inner.w - 12, 74, { height: 11, facade: '#9aa3a8', roof: '#565e63', sign: j === 6 ? 'PUERTO PALMIRA FREIGHT' : null });
        const stacks = 2 + Math.floor(random() * 3);
        for (let s = 0; s < stacks; s += 1) {
          props.push({
            kind: 'container', solid: true,
            x: inner.x + 8 + random() * (inner.w - 76), y: inner.y + 104 + random() * (inner.h - 128),
            w: 62, h: 24, color: FACADES[Math.floor(random() * FACADES.length)],
          });
        }
        for (let s = 0; s < 3; s += 1) {
          props.push({ kind: 'crate', solid: true, x: inner.x + random() * (inner.w - 20), y: inner.y + random() * (inner.h - 20), w: 17, h: 17, color: '#a8834f' });
        }
        continue;
      }
      if (parkBlocks.has(key)) {
        parks.push({ x: r.x, y: r.y, w: r.w, h: r.h });
        const n = 5 + Math.floor(random() * 5);
        for (let t = 0; t < n; t += 1) addTree(r.x + 26 + random() * (r.w - 52), r.y + 26 + random() * (r.h - 52), 1.1);
        for (let bn = 0; bn < 3; bn += 1) props.push({ kind: 'bench', solid: false, x: r.x + 30 + random() * (r.w - 70), y: r.y + 30 + random() * (r.h - 60), w: 22, h: 8, color: '#7a5a3a' });
        continue;
      }
      if (lotBlocks.has(key)) {
        // A parking lot: rows of marked bays along both long edges.
        for (let s = 0; s < 5; s += 1) {
          parkingSpots.push({ x: inner.x + 26 + s * 34, y: inner.y + 22, angle: Math.PI / 2 });
          parkingSpots.push({ x: inner.x + 26 + s * 34, y: inner.y + inner.h - 22, angle: -Math.PI / 2 });
        }
        continue;
      }
      // Ordinary block: one, two or four buildings, denser and taller toward Downtown.
      const centrality = 1 - Math.min(1, Math.hypot(i - 6.5, j - 4.5) / 8);
      const baseH = 12 + centrality * 26;
      const layout = random();
      if (layout < 0.42) {
        addBuilding(inner.x + 6, inner.y + 6, inner.w - 12, inner.h - 12, { height: baseH + random() * 14, shop: random() < 0.6 });
      } else if (layout < 0.74) {
        const vertical = random() < 0.5;
        if (vertical) {
          addBuilding(inner.x + 4, inner.y + 6, (inner.w - 16) / 2, inner.h - 12, { height: baseH + random() * 12, shop: random() < 0.5 });
          addBuilding(inner.x + inner.w / 2 + 4, inner.y + 6, (inner.w - 16) / 2, inner.h - 12, { height: baseH + random() * 12, shop: random() < 0.5 });
        } else {
          addBuilding(inner.x + 6, inner.y + 4, inner.w - 12, (inner.h - 16) / 2, { height: baseH + random() * 12, shop: random() < 0.5 });
          addBuilding(inner.x + 6, inner.y + inner.h / 2 + 4, inner.w - 12, (inner.h - 16) / 2, { height: baseH + random() * 12, shop: random() < 0.5 });
        }
      } else {
        const qw = (inner.w - 18) / 2;
        const qh = (inner.h - 18) / 2;
        for (let a = 0; a < 2; a += 1) {
          for (let bIdx = 0; bIdx < 2; bIdx += 1) {
            addBuilding(inner.x + 4 + a * (qw + 10), inner.y + 4 + bIdx * (qh + 10), qw, qh, { height: baseH * 0.7 + random() * 10, shop: random() < 0.4 });
          }
        }
      }
      // A palm or two on the pavement corners.
      if (random() < 0.6) addTree(r.x + 10, r.y + 10);
      if (random() < 0.6) addTree(r.x + r.w - 10, r.y + r.h - 10);
    }
  }

  // Curbside parking on a few quiet streets: spots hugging the block edges.
  for (let k = 0; k < 60; k += 1) {
    const i = Math.floor(random() * COLS);
    const j = Math.floor(random() * ROWS);
    const r = blockRect(i, j);
    const side = Math.floor(random() * 4);
    if (side === 0) parkingSpots.push({ x: r.x + 30 + random() * (r.w - 60), y: r.y - 20, angle: 0 });
    else if (side === 1) parkingSpots.push({ x: r.x + 30 + random() * (r.w - 60), y: r.y + r.h + 20, angle: 0 });
    else if (side === 2) parkingSpots.push({ x: r.x - 20, y: r.y + 30 + random() * (r.h - 60), angle: Math.PI / 2 });
    else parkingSpots.push({ x: r.x + r.w + 20, y: r.y + 30 + random() * (r.h - 60), angle: Math.PI / 2 });
  }

  // Street lamps at intersections (one corner each, seeded), palms along the beachfront.
  for (let i = 0; i <= COLS; i += 1) {
    for (let j = 0; j <= ROWS; j += 1) {
      if (random() < 0.72) lamps.push({ x: roadX(i) + ROAD_W / 2 + 5, y: roadY(j) + ROAD_W / 2 + 5 });
    }
  }
  for (let y = 60; y < CITY_H - 40; y += 120 + random() * 90) {
    addTree(CITY_W + 26 + random() * 30, y, 1.15);
    if (random() < 0.6) addTree(CITY_W + BEACH_W - 30 - random() * 24, y + 40, 1.05);
  }
  // Moored boats off the pier and along the bay (drawn bobbing; positions fixed here).
  const boats = [];
  for (let bIdx = 0; bIdx < 5; bIdx += 1) {
    boats.push({
      x: CITY_W + BEACH_W + 60 + random() * (WATER_W - 130),
      y: 200 + random() * (CITY_H - 400),
      angle: (random() - 0.5) * 0.7,
      phase: random() * Math.PI * 2,
      color: FACADES[Math.floor(random() * FACADES.length)],
      len: 44 + random() * 26,
    });
  }

  return { buildings, trees, lamps, props, parks, parkingSpots, specials, boats };
}
