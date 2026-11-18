// The city of Palmira, built once from the seeded RNG: a 13 x 10 grid of blocks wrapped by
// roads, a beachfront avenue and the sea along the east edge, named districts, and the special
// places the story uses (police station, hospital, respray garage, the docks). Everything the
// simulation and the renderer need to know about the static world lives here: building and prop
// lists with their collision shapes, the road network's geometry, and where things spawn.
// No drawing and no browser in this file.
import { BEACH, BUILDING_COLORS, GRID, PITCH } from './config.js';

/** Lane offset from a road centreline; traffic keeps right. */
export const LANE = 14;

/** World bounds: the grid, the beachfront road, the sand and the sea. */
export const WORLD_W = GRID.cols * PITCH + GRID.road + BEACH.sand + BEACH.water;
export const WORLD_H = GRID.rows * PITCH;

/** Centreline of vertical road i (0..cols, the last is the beachfront avenue). */
export function roadX(i) {
  return i * PITCH + GRID.road / 2;
}
/** Centreline of horizontal road j (0..rows-1). */
export function roadY(j) {
  return j * PITCH + GRID.road / 2;
}
/** The ground square of block (i, j): where its buildings stand. */
export function blockRect(i, j) {
  return {
    x: i * PITCH + GRID.road + GRID.walk,
    y: j * PITCH + GRID.road + GRID.walk,
    w: GRID.block,
    h: GRID.block,
  };
}
export const BEACH_ROAD_X = GRID.cols * PITCH + GRID.road / 2;
export const SAND_X = GRID.cols * PITCH + GRID.road;
export const WATER_X = SAND_X + BEACH.sand;

/** Which district a point is in, by region of the grid (the HUD names it as you roam). */
export function districtAt(x, y) {
  if (x >= WATER_X) return 'Palmira Bay';
  if (x >= SAND_X) return 'Azure Shore';
  const col = Math.min(GRID.cols - 1, Math.max(0, Math.floor(x / PITCH)));
  const row = Math.min(GRID.rows - 1, Math.max(0, Math.floor(y / PITCH)));
  if (col >= 11 && row >= 8) return 'The Docks';
  const west = col <= 3;
  const east = col >= 9;
  if (row <= 2) return west ? 'Old Port' : east ? 'Palm Heights' : 'Marina Bay';
  if (row <= 6) return west ? 'The Cannery' : east ? 'Harbour View' : 'Downtown Palmira';
  return west ? 'Costa Verde' : east ? 'Solana District' : 'Coral Flats';
}

export function isWater(x) {
  return x >= WATER_X;
}
export function isSand(x) {
  return x >= SAND_X && x < WATER_X;
}

/** True when a point sits on a road (either direction) — traffic and spawns use it. */
export function onRoad(x, y) {
  const mx = ((x % PITCH) + PITCH) % PITCH;
  const my = ((y % PITCH) + PITCH) % PITCH;
  if (mx < GRID.road || my < GRID.road) return true;
  return x >= GRID.cols * PITCH && x < SAND_X; // the beachfront avenue
}

/**
 * Build the static city. `random` is the seeded RNG: the same seed grows the same city.
 * Returns buildings (with collision rects), props, palms, the special places and spawn points.
 */
export function buildCity(random) {
  const buildings = [];
  const solids = [];
  const palms = [];
  const props = [];
  const crates = [];

  function addBuilding(x, y, w, h, color, floors, kind) {
    const b = {
      x, y, w, h, color, floors, kind,
      seed: Math.floor(random() * 1e9),
      name: '',
    };
    buildings.push(b);
    solids.push(b);
    return b;
  }

  // Special blocks first, so the generic filler skips them.
  const special = new Set();
  const key = (i, j) => i + ',' + j;
  const POLICE = { i: 2, j: 1 };
  const HOSPITAL = { i: 10, j: 7 };
  const RESPRAY = { i: 6, j: 4 };
  const PARK = { i: 4, j: 6 };
  const DOCKS = [{ i: 11, j: 9 }, { i: 12, j: 9 }, { i: 12, j: 8 }];
  for (const s of [POLICE, HOSPITAL, RESPRAY, PARK, ...DOCKS]) special.add(key(s.i, s.j));

  // Police station: one broad building, a forecourt and the door the busted wake up at.
  const pb = blockRect(POLICE.i, POLICE.j);
  const police = addBuilding(pb.x + 18, pb.y + 30, 160, 92, '#5b7fa6', 4, 'police');
  police.name = 'PALMIRA PD';
  const policeDoor = { x: pb.x + 98, y: pb.y + 140 };

  // Hospital: white slab with a red cross (the renderer draws it), health pickup outside.
  const hb = blockRect(HOSPITAL.i, HOSPITAL.j);
  const hospital = addBuilding(hb.x + 22, hb.y + 26, 152, 104, '#e8e6df', 5, 'hospital');
  hospital.name = 'ST. COASTAL';
  const hospitalDoor = { x: hb.x + 98, y: hb.y + 148 };

  // Respray garage: a low shed with an open bay the player drives into to lose the heat.
  const rb = blockRect(RESPRAY.i, RESPRAY.j);
  const resprayBuilding = addBuilding(rb.x + 16, rb.y + 16, 164, 62, '#8a6d4f', 1, 'respray');
  resprayBuilding.name = 'SHINE & GO';
  const resprayBay = { x: rb.x + 52, y: rb.y + 92, w: 92, h: 88 };
  addBuilding(rb.x + 16, rb.y + 92, 28, 88, '#8a6d4f', 1, 'respraySide');
  addBuilding(rb.x + 152, rb.y + 92, 28, 88, '#8a6d4f', 1, 'respraySide');

  // The docks: warehouses, container crates and the delivery apron for the last job.
  const dockApron = { x: 0, y: 0 };
  for (const d of DOCKS) {
    const db = blockRect(d.i, d.j);
    if (d.j === 9 && d.i === 11) {
      dockApron.x = db.x + 98;
      dockApron.y = db.y + 150;
    }
    if (random() < 0.85) {
      const wh = addBuilding(db.x + 14, db.y + 14, 168, 80, '#7a6a58', 2, 'warehouse');
      wh.name = 'PIER 9 FREIGHT';
    }
    for (let c = 0; c < 5; c += 1) {
      // A mix of dock crates and full shipping containers (the renderer ridges the long ones).
      const container = random() < 0.45;
      const crate = {
        x: db.x + 12 + random() * (GRID.block - 52),
        y: db.y + 104 + random() * (GRID.block - 130),
        w: container ? 78 : 40, h: container ? 26 : 24, kind: 'crate',
        color: ['#a34a3a', '#3a6ea3', '#3f8a52', '#b07f35'][Math.floor(random() * 4)],
      };
      crates.push(crate);
      solids.push(crate);
    }
  }

  // The park: grass, palms and benches, no buildings.
  const parkRect = blockRect(PARK.i, PARK.j);

  // Generic blocks: a 2x2 of lots, most built on, some left as yards.
  for (let i = 0; i < GRID.cols; i += 1) {
    for (let j = 0; j < GRID.rows; j += 1) {
      if (special.has(key(i, j))) continue;
      const r = blockRect(i, j);
      const lot = GRID.block / 2;
      for (let a = 0; a < 2; a += 1) {
        for (let b = 0; b < 2; b += 1) {
          if (random() < 0.14) continue; // an empty yard or car park
          const margin = 9 + random() * 7;
          const w = lot - margin * 2;
          const h = lot - margin * 2;
          const floors = 2 + Math.floor(random() * random() * 8);
          const color = BUILDING_COLORS[Math.floor(random() * BUILDING_COLORS.length)];
          addBuilding(r.x + a * lot + margin, r.y + b * lot + margin, w, h, color, floors, 'block');
        }
      }
      // A palm or two on the block's corners.
      if (random() < 0.7) {
        palms.push({ x: r.x - 9, y: r.y - 9, s: 0.8 + random() * 0.5 });
        if (random() < 0.5) palms.push({ x: r.x + GRID.block + 9, y: r.y + GRID.block + 9, s: 0.8 + random() * 0.5 });
      }
    }
  }

  // Palms along the beach and the park, beach umbrellas on the sand.
  for (let y = 60; y < WORLD_H - 40; y += 90 + random() * 90) {
    palms.push({ x: SAND_X + 26 + random() * 30, y, s: 0.9 + random() * 0.6 });
    if (random() < 0.55) props.push({ kind: 'umbrella', x: SAND_X + 80 + random() * 90, y: y + 30, color: BUILDING_COLORS[Math.floor(random() * BUILDING_COLORS.length)] });
  }
  for (let n = 0; n < 9; n += 1) {
    palms.push({ x: parkRect.x + 20 + random() * (GRID.block - 40), y: parkRect.y + 20 + random() * (GRID.block - 40), s: 0.9 + random() * 0.5 });
  }
  for (let n = 0; n < 5; n += 1) {
    props.push({ kind: 'bench', x: parkRect.x + 24 + random() * (GRID.block - 48), y: parkRect.y + 24 + random() * (GRID.block - 48) });
  }
  // Streetlights at every other intersection (glow at night, no collision).
  for (let i = 0; i <= GRID.cols; i += 1) {
    for (let j = 0; j < GRID.rows; j += 1) {
      if ((i + j) % 2 === 0) props.push({ kind: 'lamp', x: roadX(i) + GRID.road / 2 - 4, y: roadY(j) + GRID.road / 2 - 4 });
    }
  }
  // Palm collision trunks are small circles; the renderer draws the fronds above cars.
  for (const p of palms) solids.push({ x: p.x - 4, y: p.y - 4, w: 8, h: 8, palm: p });

  return {
    buildings, solids, palms, props, crates, parkRect,
    police: { building: police, door: policeDoor, block: POLICE },
    hospital: { building: hospital, door: hospitalDoor, block: HOSPITAL },
    respray: { building: resprayBuilding, bay: resprayBay, block: RESPRAY },
    docks: { apron: dockApron },
    /** Where Rio starts a new game: the beachfront avenue by Marina Bay. */
    start: { x: BEACH_ROAD_X, y: roadY(2) + 40 },
  };
}

/** Is a circle (x, y, r) clear of every solid? Used by spawns. */
export function circleHitsSolid(city, x, y, r) {
  for (const s of city.solids) {
    const cx = Math.max(s.x, Math.min(x, s.x + s.w));
    const cy = Math.max(s.y, Math.min(y, s.y + s.h));
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy < r * r) return s;
  }
  return null;
}

/** Push a circle out of any solid it overlaps; returns true when it moved. */
export function resolveCircle(city, body, r) {
  let moved = false;
  for (const s of city.solids) {
    const cx = Math.max(s.x, Math.min(body.x, s.x + s.w));
    const cy = Math.max(s.y, Math.min(body.y, s.y + s.h));
    let dx = body.x - cx;
    let dy = body.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) continue;
    if (d2 < 0.0001) {
      // Centre inside the rect: push out along the smallest exit.
      const left = body.x - s.x;
      const right = s.x + s.w - body.x;
      const top = body.y - s.y;
      const bottom = s.y + s.h - body.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left) body.x = s.x - r;
      else if (m === right) body.x = s.x + s.w + r;
      else if (m === top) body.y = s.y - r;
      else body.y = s.y + s.h + r;
    } else {
      const d = Math.sqrt(d2);
      dx /= d;
      dy /= d;
      body.x = cx + dx * r;
      body.y = cy + dy * r;
    }
    moved = true;
  }
  return moved;
}
