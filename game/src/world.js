// The simulation: Palmira's rules and state, with no drawing and no browser in it. Rio on
// foot and behind the wheel, traffic with somewhere to be, pedestrians, the Palmira PD and
// its wanted system, gunfire, busts, taxi fares, pickups and the respray. step() advances
// one fixed step and returns what happened as bit flags, so the caller can react (screens,
// sound) without the world knowing about either. All randomness comes from the seeded
// stream handed in at creation, so a staged scene always plays out identically.
import {
  BEACH_W, BLOCK, BUST, BUST_FINE, CAR_PAINTS, CAR_TYPES, CITY_H, CITY_W, DAY_SECONDS, HEAT, LANE,
  OFFICER, PARKED_COUNT, PED_COUNT, PITCH, PLAYER, POLICE_UNITS, RADIO_STATIONS, RESPRAY_FEE,
  ROAD_W, START_HOUR, STEP, TRAFFIC_COUNT, WASTED_FEE, WORLD_H, WORLD_W,
} from './config.js';
import { buildCity, districtAt, roadX, roadY } from './city.js';

export const EVENT_BUSTED = 1;
export const EVENT_WASTED = 2;
export const EVENT_CASH = 4;
export const EVENT_SHOT = 8;
export const EVENT_OFFICER_SHOT = 16;
export const EVENT_ENTER_CAR = 32;
export const EVENT_CRIME = 64;
export const EVENT_PICKUP = 128;
export const EVENT_HIT = 256;

// Direction helpers: 0 north, 1 east, 2 south, 3 west.
const DIR_X = [0, 1, 0, -1];
const DIR_Y = [-1, 0, 1, 0];
const DIR_ANGLE = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Push a circle out of an axis-aligned rect; returns how deep it was inside (0 = no touch). */
function circleRectPush(px, py, r, rect, out) {
  const nx = clamp(px, rect.x, rect.x + rect.w);
  const ny = clamp(py, rect.y, rect.y + rect.h);
  const dx = px - nx;
  const dy = py - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return 0;
  if (d2 > 0.0001) {
    const d = Math.sqrt(d2);
    out.x = nx + (dx / d) * r;
    out.y = ny + (dy / d) * r;
    return r - d;
  }
  // Centre inside the rect: leave by the nearest face.
  const left = px - rect.x;
  const right = rect.x + rect.w - px;
  const top = py - rect.y;
  const bottom = rect.y + rect.h - py;
  const m = Math.min(left, right, top, bottom);
  if (m === left) out.x = rect.x - r, out.y = py;
  else if (m === right) out.x = rect.x + rect.w + r, out.y = py;
  else if (m === top) out.x = px, out.y = rect.y - r;
  else out.x = px, out.y = rect.y + rect.h + r;
  return m + r;
}

/** Earliest t in [0,1] where a segment meets a rect, or Infinity. For bullets and sight lines. */
function segmentRectT(x1, y1, x2, y2, rect) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x1 < rect.x || x1 > rect.x + rect.w) return Infinity;
  } else {
    let ta = (rect.x - x1) / dx;
    let tb = (rect.x + rect.w - x1) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y1 < rect.y || y1 > rect.y + rect.h) return Infinity;
  } else {
    let ta = (rect.y - y1) / dy;
    let tb = (rect.y + rect.h - y1) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

export function createWorld(random) {
  const city = buildCity(random);
  const state = {
    time: 0,
    clock: START_HOUR,
    city,
    player: null,
    cars: [],
    peds: [],
    officers: [],
    particles: [],
    skids: [],
    pickups: [],
    heat: 0,
    stars: 0,
    bust: 0,
    cash: 250,
    stats: { stolen: 0, fares: 0, earned: 0, busts: 0, wasteds: 0, shots: 0 },
    popups: [],
    banner: null,
    radio: null,
    objective: null,
    taxiObjective: null,
    taxi: { phase: 'idle', ped: null, dest: null, timer: 0, hailTimer: 4 },
    camera: { x: 0, y: 0, zoom: 1 },
    shake: 0,
    seenTimer: 99, // seconds since a police unit last had eyes on Rio
    gunfireTimer: 0,
    resprayCooldown: 0,
    inBay: false,
    policeSpawnTimer: 0,
    over: null, // 'busted' | 'wasted' once it happens
  };

  // Solid geometry, bucketed by block so collision queries stay cheap.
  const solids = [];
  for (const b of city.buildings) solids.push({ x: b.x, y: b.y, w: b.w, h: b.h });
  for (const p of city.props) if (p.solid) solids.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  const solidGrid = new Map();
  for (const s of solids) {
    const key = `${Math.floor(s.x / PITCH)},${Math.floor(s.y / PITCH)}`;
    if (!solidGrid.has(key)) solidGrid.set(key, []);
    solidGrid.get(key).push(s);
  }
  const pushOut = { x: 0, y: 0 };

  function collideCircle(px, py, r) {
    let hit = false;
    const bi = Math.floor(px / PITCH);
    const bj = Math.floor(py / PITCH);
    for (let i = bi - 1; i <= bi + 1; i += 1) {
      for (let j = bj - 1; j <= bj + 1; j += 1) {
        const cell = solidGrid.get(`${i},${j}`);
        if (!cell) continue;
        for (const s of cell) {
          if (px + r < s.x - 4 || px - r > s.x + s.w + 4 || py + r < s.y - 4 || py - r > s.y + s.h + 4) continue;
          if (circleRectPush(px, py, r, s, pushOut) > 0) {
            px = pushOut.x;
            py = pushOut.y;
            hit = true;
          }
        }
      }
    }
    for (const t of city.trees) {
      const dx = px - t.x;
      const dy = py - t.y;
      const rr = r + 5;
      if (dx * dx + dy * dy < rr * rr && dx * dx + dy * dy > 0.01) {
        const d = Math.sqrt(dx * dx + dy * dy);
        px = t.x + (dx / d) * rr;
        py = t.y + (dy / d) * rr;
        hit = true;
      }
    }
    return { x: px, y: py, hit };
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  let carId = 0;
  function makeCar(type, kind, x, y, angle) {
    const spec = CAR_TYPES[type];
    const paint = kind === 'police' ? ['#20242c', '#101216'] : kind === 'taxi' ? ['#f2b01e', '#c78d10'] : CAR_PAINTS[Math.floor(random() * CAR_PAINTS.length)];
    carId += 1;
    return {
      id: carId, type, kind, spec,
      x, y, angle, speed: 0, steerVis: 0, brakeVis: 0,
      slideX: 0, slideY: 0,
      len: spec.len, wid: spec.wid,
      color: paint[0], roof: paint[1],
      hp: type === 'armored' ? 420 : 160, maxHp: type === 'armored' ? 420 : 160,
      driver: 'none', special: null, stolenOnce: false, wrecked: false,
      // traffic brain
      axis: 'v', line: 0, dir: 2, cruise: 130 + random() * 55, turnTimer: 0, stuckTimer: 0, reverseTimer: 0,
      // police brain
      officerOut: false, leaveMode: false, sirenPhase: random() * 6,
    };
  }

  function laneCoord(car) {
    // The lane centre for the car's current road and heading (right-hand traffic).
    if (car.axis === 'v') return roadX(car.line) + (car.dir === 0 ? LANE : -LANE);
    return roadY(car.line) + (car.dir === 1 ? LANE : -LANE);
  }

  function placeOnRoad(car, nearX, nearY, minD, maxD) {
    for (let tries = 0; tries < 24; tries += 1) {
      const vertical = random() < 0.5;
      const line = Math.floor(random() * (vertical ? 14 : 11));
      const along = random() * (vertical ? CITY_H : CITY_W);
      const x = vertical ? roadX(line) : along;
      const y = vertical ? along : roadY(line);
      const d = dist(x, y, nearX, nearY);
      if (d < minD || d > maxD) continue;
      car.axis = vertical ? 'v' : 'h';
      car.line = line;
      car.dir = vertical ? (random() < 0.5 ? 0 : 2) : (random() < 0.5 ? 1 : 3);
      car.angle = DIR_ANGLE[car.dir];
      if (vertical) car.x = laneCoord(car), car.y = y;
      else car.x = x, car.y = laneCoord(car);
      return true;
    }
    return false;
  }

  function spawnTraffic() {
    const types = ['sedan', 'sedan', 'coupe', 'taxi', 'pickup', 'van', 'sedan', 'coupe'];
    const car = makeCar(types[Math.floor(random() * types.length)], 'traffic', 0, 0, 0);
    if (placeOnRoad(car, state.player ? state.player.x : 600, state.player ? state.player.y : 600, 260, 2600)) {
      car.driver = 'ai';
      car.speed = car.cruise * 0.7;
      state.cars.push(car);
    }
  }

  function spawnParked() {
    const spots = city.parkingSpots;
    if (!spots.length) return;
    const used = new Set(state.cars.filter((c) => c.kind === 'parked').map((c) => `${Math.round(c.x)},${Math.round(c.y)}`));
    for (let tries = 0; tries < 12; tries += 1) {
      const spot = spots[Math.floor(random() * spots.length)];
      const key = `${Math.round(spot.x)},${Math.round(spot.y)}`;
      if (used.has(key)) continue;
      const types = ['sedan', 'coupe', 'pickup', 'van', 'sedan', 'taxi'];
      const car = makeCar(types[Math.floor(random() * types.length)], 'parked', spot.x, spot.y, spot.angle);
      state.cars.push(car);
      return;
    }
  }

  function spawnPed(x, y) {
    const bi = clamp(Math.floor(x / PITCH), 0, 12);
    const bj = clamp(Math.floor(y / PITCH), 0, 9);
    state.peds.push({
      x, y, angle: random() * Math.PI * 2, speed: 0,
      blockI: bi, blockJ: bj, corner: Math.floor(random() * 4), dirSign: random() < 0.5 ? 1 : -1,
      mode: 'walk', modeTimer: 0, walkPhase: random() * 6, downTimer: 0,
      color: CAR_PAINTS[Math.floor(random() * CAR_PAINTS.length)][0],
      skin: ['#e8b98d', '#c68863', '#8d5a3b', '#f0c8a0', '#6e4530'][Math.floor(random() * 5)],
      threatX: 0, threatY: 0,
    });
  }

  function spawnPickups() {
    const pd = city.specials.pd.door;
    const hosp = city.specials.hospital.door;
    const pier = city.specials.pier.point;
    state.pickups = [
      { kind: 'health', x: hosp.x + 30, y: hosp.y + 16, active: true, timer: 0 },
      { kind: 'health', x: CITY_W + 70, y: roadY(4), active: true, timer: 0 },
      { kind: 'health', x: pier.x - 60, y: pier.y + 60, active: true, timer: 0 },
      { kind: 'armor', x: pd.x - 40, y: pd.y + 16, active: true, timer: 0 },
      { kind: 'armor', x: pier.x - 20, y: pier.y - 70, active: true, timer: 0 },
    ];
  }

  // -------------------------------------------------------------------------
  // Reset / respawn / save data
  // -------------------------------------------------------------------------

  function reset() {
    state.time = 0;
    state.clock = START_HOUR;
    state.cars = [];
    state.peds = [];
    state.officers = [];
    state.particles = [];
    state.skids = [];
    state.heat = 0;
    state.stars = 0;
    state.bust = 0;
    state.cash = 250;
    state.stats = { stolen: 0, fares: 0, earned: 0, busts: 0, wasteds: 0, shots: 0 };
    state.popups = [];
    state.banner = null;
    state.radio = null;
    state.objective = null;
    state.taxiObjective = null;
    state.taxi = { phase: 'idle', ped: null, dest: null, timer: 0, hailTimer: 4 };
    state.shake = 0;
    state.seenTimer = 99;
    state.gunfireTimer = 0;
    state.resprayCooldown = 0;
    state.inBay = false;
    state.policeSpawnTimer = 0;
    state.over = null;
    // Rio starts on the Azure Beach promenade, fresh off the boat, facing the city.
    state.player = {
      x: CITY_W + 46, y: roadY(5), angle: Math.PI, vx: 0, vy: 0, // on the sand, steps from the avenue
      health: PLAYER.health, armor: 0, car: null, fireTimer: 0, walkPhase: 0, muzzle: 0,
    };
    for (let k = 0; k < TRAFFIC_COUNT; k += 1) spawnTraffic();
    for (let k = 0; k < PARKED_COUNT; k += 1) spawnParked();
    for (let k = 0; k < PED_COUNT; k += 1) {
      const i = Math.floor(random() * 13);
      const j = Math.floor(random() * 10);
      spawnPed(i * PITCH + ROAD_W / 2 + 20 + random() * (BLOCK - 40), j * PITCH + ROAD_W / 2 + 14);
    }
    spawnPickups();
    state.camera.x = state.player.x;
    state.camera.y = state.player.y;
    state.camera.zoom = 1;
  }

  function respawn(kind) {
    const door = kind === 'busted' ? city.specials.pd.door : city.specials.hospital.door;
    const p = state.player;
    if (p.car) {
      p.car.driver = 'none';
      p.car.speed = 0;
      p.car = null;
    }
    p.x = door.x;
    p.y = door.y + 18;
    p.vx = 0;
    p.vy = 0;
    p.health = PLAYER.health;
    state.heat = 0;
    state.stars = 0;
    state.bust = 0;
    state.over = null;
    state.seenTimer = 99;
    // The patrols stand down.
    state.cars = state.cars.filter((c) => c.kind !== 'police');
    state.officers = [];
    state.taxi.phase = 'idle';
    state.taxi.ped = null;
    state.camera.x = p.x;
    state.camera.y = p.y;
  }

  function getSaveData() {
    const p = state.player;
    return {
      cash: state.cash, stats: { ...state.stats }, clock: state.clock,
      x: p.x, y: p.y, health: p.health, armor: p.armor,
    };
  }

  function loadSaveData(d) {
    state.cash = d.cash | 0;
    state.stats = { ...state.stats, ...d.stats };
    state.clock = d.clock ?? START_HOUR;
    const p = state.player;
    p.x = d.x;
    p.y = d.y;
    p.health = d.health ?? PLAYER.health;
    p.armor = d.armor ?? 0;
    state.camera.x = p.x;
    state.camera.y = p.y;
  }

  // -------------------------------------------------------------------------
  // Shared sim helpers (missions and shots reach these through the world API)
  // -------------------------------------------------------------------------

  function popup(from, text) {
    state.popups.push({ from, text, ttl: 5.5, max: 5.5 });
    if (state.popups.length > 3) state.popups.shift();
  }

  function banner(title, sub) {
    state.banner = { title, sub: sub ?? '', ttl: 3.4, max: 3.4 };
  }

  function spawnSpecialCar(type, tag, x, y, angle) {
    const car = makeCar(type, 'special', x, y, angle);
    car.special = tag;
    state.cars.push(car);
    return car;
  }

  function playerPos() {
    const p = state.player;
    return p.car ? { x: p.car.x, y: p.car.y } : { x: p.x, y: p.y };
  }

  // -------------------------------------------------------------------------
  // Heat and crime. Events raised outside step() (a mission forcing heat, say)
  // are parked in pendingEvents and drained by the next step's return value.
  // -------------------------------------------------------------------------

  let pendingEvents = 0;

  function starsFor(heat) {
    let s = 0;
    for (const band of HEAT.bands) if (heat >= band) s += 1;
    return s;
  }

  function witnessedBy(x, y) {
    const r2 = HEAT.witnessRadius * HEAT.witnessRadius;
    for (const ped of state.peds) {
      if (ped.mode === 'down') continue;
      const dx = ped.x - x;
      const dy = ped.y - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    for (const o of state.officers) {
      const dx = o.x - x;
      const dy = o.y - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    for (const car of state.cars) {
      if (car.kind !== 'police') continue;
      const dx = car.x - x;
      const dy = car.y - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  }

  function addHeat(amount, x, y, mustSee) {
    let applied = amount;
    if (mustSee && !witnessedBy(x, y)) applied = Math.min(amount, HEAT.unwitnessed);
    if (applied <= 0) return;
    state.heat = clamp(state.heat + applied, 0, HEAT.cap);
    state.stars = starsFor(state.heat);
    // A witnessed crime means the call just went in: the response window starts now, so
    // the heat cannot start fading until the units have had their chance to arrive.
    if (applied > HEAT.unwitnessed) state.seenTimer = 0;
    if (applied >= 30) pendingEvents |= EVENT_CRIME;
  }

  function setHeatAtLeast(v) {
    if (v > state.heat) {
      state.heat = clamp(v, 0, HEAT.cap);
      state.stars = starsFor(state.heat);
      state.seenTimer = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Particles and skid marks (pure decoration, but simulated so staged frames
  // show them exactly as live play does).
  // -------------------------------------------------------------------------

  function burst(x, y, n, colors, speed, life, size, grav = 0) {
    for (let k = 0; k < n; k += 1) {
      if (state.particles.length > 340) return;
      const a = random() * Math.PI * 2;
      const s = speed * (0.3 + random() * 0.7);
      state.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: life * (0.5 + random() * 0.8), max: life,
        size: size * (0.6 + random() * 0.8),
        color: colors[Math.floor(random() * colors.length)], grav,
      });
    }
  }

  function sparks(x, y, n = 8) { burst(x, y, n, ['#ffd23e', '#ff8a3e', '#fff3b0'], 190, 0.4, 2.4); }
  function smokePuff(x, y, n = 3) { burst(x, y, n, ['#9aa0a3', '#6e7478', '#c9ced2'], 42, 1.1, 5.5); }
  function sparkle(x, y) { burst(x, y, 10, ['#f2c94c', '#fff3b0', '#ffffff'], 80, 0.6, 2.2); }

  function addSkid(x, y, angle) {
    state.skids.push({ x, y, angle, age: 0 });
    if (state.skids.length > 520) state.skids.shift();
  }

  // -------------------------------------------------------------------------
  // Getting in and out of cars
  // -------------------------------------------------------------------------

  function tryEnterCar(ev) {
    const p = state.player;
    let best = null;
    let bestD = Infinity;
    for (const car of state.cars) {
      if (car.wrecked || car.driver === 'player') continue;
      const d = dist(p.x, p.y, car.x, car.y) - car.len / 2;
      if (d < PLAYER.reach + 8 && d < bestD) { best = car; bestD = d; }
    }
    if (!best) return ev;
    if (best.driver === 'ai') {
      // The driver is thrown out and runs for it.
      spawnPed(best.x + 14, best.y + 10);
      const ped = state.peds[state.peds.length - 1];
      ped.mode = 'flee';
      ped.modeTimer = 2.6;
      ped.threatX = p.x;
      ped.threatY = p.y;
      best.driver = 'none';
    }
    if (!best.stolenOnce) {
      best.stolenOnce = true;
      state.stats.stolen += 1;
      addHeat(HEAT.theft, best.x, best.y, true);
      if (best.kind === 'police') addHeat(60, best.x, best.y, false);
    }
    p.car = best;
    best.driver = 'player';
    best.leaveMode = false;
    p.x = best.x;
    p.y = best.y;
    state.radio = { name: RADIO_STATIONS[Math.floor(random() * RADIO_STATIONS.length)], ttl: 3.6 };
    return ev | EVENT_ENTER_CAR;
  }

  function exitCar() {
    const p = state.player;
    const car = p.car;
    if (!car) return;
    const side = car.angle + Math.PI / 2;
    p.x = car.x + Math.cos(side) * (car.wid / 2 + 17);
    p.y = car.y + Math.sin(side) * (car.wid / 2 + 17);
    const fixed = collideCircle(p.x, p.y, PLAYER.radius);
    p.x = fixed.x;
    p.y = fixed.y;
    p.vx = 0;
    p.vy = 0;
    car.driver = 'none';
    p.car = null;
  }

  // -------------------------------------------------------------------------
  // Rio
  // -------------------------------------------------------------------------

  function playerFoot(dt, ctrl, ev) {
    const p = state.player;
    const firing = ctrl.fire;
    const speedCap = (ctrl.run ? PLAYER.run : PLAYER.walk) * (firing ? 0.55 : 1);
    let tx = ctrl.mx;
    let ty = ctrl.my;
    const tl = Math.hypot(tx, ty);
    if (tl > 1) { tx /= tl; ty /= tl; }
    p.vx = lerp(p.vx, tx * speedCap, clamp(dt * 11, 0, 1));
    p.vy = lerp(p.vy, ty * speedCap, clamp(dt * 11, 0, 1));
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const fixed = collideCircle(p.x, p.y, PLAYER.radius);
    p.x = fixed.x;
    p.y = fixed.y;
    // The bay is ankle-deep at worst; the pier is as far east as feet can go.
    const pier = city.specials.pier.rect;
    const onPier = p.x > pier.x - 6 && p.x < pier.x + pier.w + 10 && p.y > pier.y - 6 && p.y < pier.y + pier.h + 6;
    const maxX = onPier ? pier.x + pier.w + 8 : CITY_W + BEACH_W + 24;
    p.x = clamp(p.x, 10, maxX);
    p.y = clamp(p.y, 10, WORLD_H - 10);
    const spd = Math.hypot(p.vx, p.vy);
    p.walkPhase += spd * dt * 0.062;
    if (firing) p.angle = Math.atan2(ctrl.aimY - p.y, ctrl.aimX - p.x);
    else if (spd > 12) p.angle = Math.atan2(p.vy, p.vx);
    if (ctrl.interact) ev = tryEnterCar(ev);
    return ev;
  }

  function playerDrive(dt, ctrl, ev) {
    const p = state.player;
    const car = p.car;
    const spec = car.spec;
    if (car.hp <= 0 && !car.wrecked) {
      car.wrecked = true;
      popup('WRECKED', 'She is dead, Rio. Get out and find other wheels.');
    }
    if (car.wrecked) {
      car.speed = lerp(car.speed, 0, clamp(dt * 3.4, 0, 1));
      car.x += Math.cos(car.angle) * car.speed * dt + car.slideX * dt;
      car.y += Math.sin(car.angle) * car.speed * dt + car.slideY * dt;
      car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
      car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
      if (random() < dt * 8) smokePuff(car.x, car.y, 2);
      p.x = car.x;
      p.y = car.y;
      if (ctrl.interact) exitCar();
      return ev;
    }
    const my = ctrl.my;
    if (my > 0) {
      car.speed += spec.accel * my * dt * (1 - (car.speed / spec.top) * 0.55);
      car.brakeVis = Math.max(0, car.brakeVis - dt * 5);
    } else if (my < 0) {
      if (car.speed > 12) {
        car.speed -= 440 * dt;
        car.brakeVis = 1;
      } else {
        car.speed -= spec.accel * 0.55 * dt;
        car.brakeVis = Math.max(0, car.brakeVis - dt * 5);
      }
    } else {
      car.brakeVis = Math.max(0, car.brakeVis - dt * 5);
    }
    car.speed -= car.speed * 0.32 * dt;
    if (my === 0 && Math.abs(car.speed) < 26) car.speed = lerp(car.speed, 0, clamp(dt * 3.2, 0, 1));
    const handbrake = ctrl.run && Math.abs(car.speed) > 90;
    if (handbrake) car.speed -= Math.sign(car.speed) * 240 * dt;
    car.speed = clamp(car.speed, -spec.top * 0.38, spec.top);
    const steer = ctrl.mx;
    car.steerVis = lerp(car.steerVis, steer * 0.52, clamp(dt * 10, 0, 1));
    const speedFactor = clamp(car.speed / 150, -1, 1) * (1 - 0.38 * Math.min(1, Math.abs(car.speed) / spec.top));
    car.angle += steer * spec.grip * speedFactor * dt;
    car.x += Math.cos(car.angle) * car.speed * dt + car.slideX * dt;
    car.y += Math.sin(car.angle) * car.speed * dt + car.slideY * dt;
    car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
    car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
    const slipping = (Math.abs(steer) > 0.55 && Math.abs(car.speed) > 215) || handbrake;
    if (slipping) {
      const back = car.len * 0.32;
      const sideOff = car.wid * 0.42;
      const ca = Math.cos(car.angle);
      const sa = Math.sin(car.angle);
      addSkid(car.x - ca * back - sa * sideOff, car.y - sa * back + ca * sideOff, car.angle);
      addSkid(car.x - ca * back + sa * sideOff, car.y - sa * back - ca * sideOff, car.angle);
      if (random() < 0.3) smokePuff(car.x - ca * back, car.y - sa * back, 1);
    }
    if (car.hp < 60 && random() < dt * 6) smokePuff(car.x + Math.cos(car.angle) * car.len * 0.3, car.y + Math.sin(car.angle) * car.len * 0.3, 1);
    p.x = car.x;
    p.y = car.y;
    p.angle = car.angle;
    if (ctrl.interact && Math.abs(car.speed) < 265) exitCar();
    return ev;
  }

  // -------------------------------------------------------------------------
  // Traffic: lane-following drivers with a simple, stubborn brain.
  // -------------------------------------------------------------------------

  function trafficDrive(car, dt) {
    if (car.wrecked) {
      car.speed = lerp(car.speed, 0, clamp(dt * 4, 0, 1));
      return;
    }
    car.turnTimer -= dt;
    // Where is the next intersection along the heading, and may we turn there?
    const along = car.axis === 'v' ? car.y : car.x;
    const sign = DIR_X[car.dir] + DIR_Y[car.dir]; // -1 or +1 along the axis
    const nextIdx = sign > 0 ? Math.floor(along / PITCH) + 1 : Math.ceil(along / PITCH) - 1;
    const distNext = Math.abs(nextIdx * PITCH - along);
    if (distNext < 76 && car.turnTimer <= 0) {
      const options = [car.dir]; // straight on
      const left = (car.dir + 3) % 4;
      const right = (car.dir + 1) % 4;
      // The intersection's own grid indices, and whether the grid continues each way.
      const atI = car.axis === 'v' ? car.line : nextIdx;
      const atJ = car.axis === 'v' ? nextIdx : car.line;
      const canGo = (d) => (d === 0 ? atJ > 0 : d === 2 ? atJ < 10 : d === 1 ? atI < 13 : atI > 0);
      if (canGo(left)) options.push(left);
      if (canGo(right)) options.push(right);
      const mustTurn = !canGo(car.dir);
      let choice = car.dir;
      if (mustTurn) choice = options.length > 1 ? options[1 + Math.floor(random() * (options.length - 1))] : car.dir;
      else if (random() < 0.34 && options.length > 1) choice = options[Math.floor(random() * options.length)];
      if (choice !== car.dir) {
        if (car.axis === 'v') { car.axis = 'h'; car.line = nextIdx; }
        else { car.axis = 'v'; car.line = nextIdx; }
        car.dir = choice;
      }
      car.turnTimer = 1.7;
    }
    // Guide point: down the lane, cross-axis snapped to the lane centre.
    let gx = car.x + DIR_X[car.dir] * 150;
    let gy = car.y + DIR_Y[car.dir] * 150;
    if (car.axis === 'v') gx = laneCoord(car);
    else gy = laneCoord(car);
    const desired = Math.atan2(gy - car.y, gx - car.x);
    const misalign = Math.abs(angleDiff(desired, car.angle));
    const turnRate = 2.3 - Math.min(1.15, Math.abs(car.speed) / 460);
    car.angle += clamp(angleDiff(desired, car.angle), -turnRate * dt, turnRate * dt);
    car.steerVis = lerp(car.steerVis, clamp(angleDiff(desired, car.angle) * 1.4, -0.5, 0.5), clamp(dt * 6, 0, 1));
    // Obstacle probe: anything solid in the path ahead slows or stops the car.
    let want = car.cruise * (misalign > 0.6 ? 0.45 : 1);
    const probeD = 36 + Math.abs(car.speed) * 0.52;
    const px = car.x + Math.cos(car.angle) * probeD;
    const py = car.y + Math.sin(car.angle) * probeD;
    for (const other of state.cars) {
      if (other === car) continue;
      const d = dist(px, py, other.x, other.y);
      if (d < 30) { want = 0; break; }
      if (d < 46) want = Math.min(want, car.cruise * 0.35);
    }
    if (want > 0) {
      for (const ped of state.peds) {
        if (ped.mode === 'down' || ped.mode === 'passenger') continue;
        if (dist(px, py, ped.x, ped.y) < 24) { want = Math.min(want, car.cruise * 0.25); break; }
      }
    }
    // Unstick: if the car wants to move but cannot, back out and try again.
    if (car.reverseTimer > 0) {
      car.reverseTimer -= dt;
      want = -72;
    } else if (want > 46 && Math.abs(car.speed) < 9) {
      car.stuckTimer += dt;
      if (car.stuckTimer > 1.15) {
        car.reverseTimer = 0.55;
        car.stuckTimer = 0;
      }
    } else car.stuckTimer = 0;
    const accel = want > car.speed ? 165 : 300;
    car.speed = lerp(car.speed, want, clamp((accel / Math.max(60, Math.abs(want - car.speed) + 60)) * dt * 3.4, 0, 1));
    if (want === 0 && Math.abs(car.speed) < 14) car.speed = lerp(car.speed, 0, clamp(dt * 6, 0, 1));
    car.brakeVis = want < car.speed - 12 ? 1 : Math.max(0, car.brakeVis - dt * 5);
    car.x += Math.cos(car.angle) * car.speed * dt + car.slideX * dt;
    car.y += Math.sin(car.angle) * car.speed * dt + car.slideY * dt;
    car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
    car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
  }

  // -------------------------------------------------------------------------
  // The Palmira PD: pursuit cars and the officers who climb out of them.
  // -------------------------------------------------------------------------

  function policeDrive(car, dt) {
    const p = state.player;
    const pp = playerPos();
    const d = dist(car.x, car.y, pp.x, pp.y);
    if (car.leaveMode) {
      trafficDrive(car, dt);
      return;
    }
    if (car.officerOut) {
      car.speed = lerp(car.speed, 0, clamp(dt * 6, 0, 1));
      car.x += car.slideX * dt;
      car.y += car.slideY * dt;
      car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
      car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
      return;
    }
    if (car.wrecked) { car.speed = 0; return; }
    const pvx = p.car ? Math.cos(p.car.angle) * p.car.speed : p.vx;
    const pvy = p.car ? Math.sin(p.car.angle) * p.car.speed : p.vy;
    let tx = pp.x + pvx * 0.28;
    let ty = pp.y + pvy * 0.28;
    // Far away, or with a building in the way, a unit drives the streets: a Manhattan
    // route across the junction grid, rebuilt whenever Rio changes junction. Close in
    // with a clear line of sight, it comes straight at him.
    let losBlocked = false;
    if (d > 130) {
      for (const b of state.city.buildings) {
        if (segmentRectT(car.x, car.y, pp.x, pp.y, b) < 1) { losBlocked = true; break; }
      }
    }
    if (d > 300 || losBlocked) {
      const maxI = Math.round((CITY_W - ROAD_W) / PITCH);
      const maxJ = Math.round((CITY_H - ROAD_W) / PITCH);
      const pjI = clamp(Math.round(pp.x / PITCH), 0, maxI);
      const pjJ = clamp(Math.round(pp.y / PITCH), 0, maxJ);
      if (!car.route || car.routeDestI !== pjI || car.routeDestJ !== pjJ) {
        const ci = clamp(Math.round(car.x / PITCH), 0, maxI);
        const cj = clamp(Math.round(car.y / PITCH), 0, maxJ);
        car.route = [{ x: ci * PITCH, y: cj * PITCH }];
        if (pjI !== ci) car.route.push({ x: pjI * PITCH, y: cj * PITCH });
        if (pjJ !== cj) car.route.push({ x: pjI * PITCH, y: pjJ * PITCH });
        car.routeI = 0;
        car.routeDestI = pjI;
        car.routeDestJ = pjJ;
        // A unit that is barely moving points itself at the first junction before it
        // sets off, instead of swinging a wide arc across the block on its first turn.
        if (Math.abs(car.speed) < 60) {
          car.angle = Math.atan2(car.route[0].y - car.y, car.route[0].x - car.x);
        }
      }
      while (car.routeI < car.route.length - 1
        && dist(car.x, car.y, car.route[car.routeI].x, car.route[car.routeI].y) < 72) car.routeI += 1;
      const wp = car.route[car.routeI];
      if (car.routeI >= car.route.length - 1 && dist(car.x, car.y, wp.x, wp.y) < 110) {
        tx = pp.x + pvx * 0.28;
        ty = pp.y + pvy * 0.28;
      } else {
        tx = wp.x;
        ty = wp.y;
      }
    } else {
      car.route = null;
    }
    let desired = Math.atan2(ty - car.y, tx - car.x);
    // Dodge: a parked or crawling car in the path bends the pursuit line around it —
    // without this a unit will nose into a parked car and grind there forever.
    let dodgeBlocker = null;
    {
      const probeD = 40 + Math.abs(car.speed) * 0.42;
      const ca = Math.cos(car.angle);
      const sa = Math.sin(car.angle);
      for (const [ox, oy] of [[probeD, -15], [probeD, 15], [probeD * 0.55, 0]]) {
        const wx = car.x + ca * ox - sa * oy;
        const wy = car.y + sa * ox + ca * oy;
        for (const other of state.cars) {
          if (other === car || other === p.car || other.kind === 'police') continue;
          for (const off of [-0.27, 0.27]) {
            const cx = other.x + Math.cos(other.angle) * other.len * off;
            const cy = other.y + Math.sin(other.angle) * other.len * off;
            if (dist(wx, wy, cx, cy) < 31) { dodgeBlocker = other; break; }
          }
          if (dodgeBlocker) break;
        }
        if (dodgeBlocker) break;
      }
      if (dodgeBlocker) {
        const perpX = -Math.sin(car.angle);
        const perpY = Math.cos(car.angle);
        const ax = dodgeBlocker.x + perpX * 56;
        const ay = dodgeBlocker.y + perpY * 56;
        const bx = dodgeBlocker.x - perpX * 56;
        const by = dodgeBlocker.y - perpY * 56;
        const da = (ax - tx) * (ax - tx) + (ay - ty) * (ay - ty);
        const db = (bx - tx) * (bx - tx) + (by - ty) * (by - ty);
        desired = Math.atan2((da < db ? ay : by) - car.y, (da < db ? ax : bx) - car.x);
      }
    }
    const turnRate = 3.0 - Math.min(1.2, Math.abs(car.speed) / 520);
    car.angle += clamp(angleDiff(desired, car.angle), -turnRate * dt, turnRate * dt);
    car.steerVis = lerp(car.steerVis, clamp(angleDiff(desired, car.angle) * 1.5, -0.5, 0.5), clamp(dt * 7, 0, 1));
    let want = car.spec.top * 0.95;
    if (d < 52) want = Math.min(want, Math.max(60, Math.abs(p.car ? p.car.speed : 0) * 0.92));
    // Slow for the turn: at full tilt the turning circle is wider than a junction, and a
    // unit that overshoots ends up facing a building instead of the street.
    const misalign = Math.abs(angleDiff(desired, car.angle));
    if (misalign > 0.55) want *= misalign > 1.4 ? 0.3 : misalign > 0.95 ? 0.45 : 0.65;
    if (car.route) want = Math.min(want, 235);
    if (dodgeBlocker) want *= 0.8;
    // Unstick: a unit pinned on a corner backs out and comes again, like traffic does.
    if (car.reverseTimer > 0) {
      car.reverseTimer -= dt;
      want = -135;
    } else if (Math.abs(car.speed) < 16 && d > 90) {
      car.stuckTimer += dt;
      if (car.stuckTimer > 0.9) {
        car.reverseTimer = 0.55;
        car.stuckTimer = 0;
      }
    } else car.stuckTimer = 0;
    car.speed = lerp(car.speed, want, clamp(dt * 2.6, 0, 1));
    car.brakeVis = want < car.speed - 14 ? 1 : Math.max(0, car.brakeVis - dt * 5);
    car.x += Math.cos(car.angle) * car.speed * dt + car.slideX * dt;
    car.y += Math.sin(car.angle) * car.speed * dt + car.slideY * dt;
    car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
    car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
    car.sirenPhase += dt * 7.5;
    // Bail out: close and Rio slow — at high heat or on foot he is a shooting risk, and a
    // stopped driver gets the officer at his window whatever the star count.
    const playerSpeed = p.car ? Math.abs(p.car.speed) : Math.hypot(p.vx, p.vy);
    if (d < 132 && playerSpeed < 62 && (state.stars >= 3 || !p.car || playerSpeed < 26)) {
      car.officerOut = true;
      car.speed = 0;
      state.officers.push({
        x: car.x + 16, y: car.y + 12, angle: car.angle, hp: OFFICER.health,
        car, fireTimer: 0.6 + random() * 0.5, walkPhase: random() * 6,
      });
    }
  }

  function officerUpdate(officer, dt, ev) {
    const p = state.player;
    const pp = playerPos();
    const d = dist(officer.x, officer.y, pp.x, pp.y);
    if (state.stars === 0) {
      // Stand-down: walk back to the unit and drive away.
      const cd = dist(officer.x, officer.y, officer.car.x, officer.car.y);
      if (cd < 20 || officer.car.wrecked) {
        officer.dead = true;
        officer.car.officerOut = false;
        officer.car.leaveMode = true;
        officer.car.axis = Math.abs(Math.sin(officer.car.angle)) > 0.7 ? 'v' : 'h';
        officer.car.line = clamp(Math.round((officer.car.axis === 'v' ? officer.car.x : officer.car.y) / PITCH), 0, officer.car.axis === 'v' ? 13 : 10);
        officer.car.dir = officer.car.axis === 'v' ? (Math.sin(officer.car.angle) > 0 ? 2 : 0) : (Math.cos(officer.car.angle) > 0 ? 1 : 3);
        return ev;
      }
      officer.angle = Math.atan2(officer.car.y - officer.y, officer.car.x - officer.x);
      officer.x += Math.cos(officer.angle) * OFFICER.speed * 0.8 * dt;
      officer.y += Math.sin(officer.angle) * OFFICER.speed * 0.8 * dt;
      officer.walkPhase += dt * 9;
      return ev;
    }
    if (d > 24) {
      officer.angle = Math.atan2(pp.y - officer.y, pp.x - officer.x);
      const sp = d > 300 ? OFFICER.speed * 1.25 : OFFICER.speed;
      officer.x += Math.cos(officer.angle) * sp * dt;
      officer.y += Math.sin(officer.angle) * sp * dt;
      const fixed = collideCircle(officer.x, officer.y, 11);
      officer.x = fixed.x;
      officer.y = fixed.y;
      officer.walkPhase += dt * 10;
    } else {
      officer.angle = Math.atan2(pp.y - officer.y, pp.x - officer.x);
    }
    // Gunfire at three stars and up, with a clear line.
    if (state.stars >= 3 && d < OFFICER.range && d > 30) {
      officer.fireTimer -= dt;
      if (officer.fireTimer <= 0) {
        let blocked = false;
        for (const b of state.city.buildings) {
          if (segmentRectT(officer.x, officer.y, pp.x, pp.y, b) < 1) { blocked = true; break; }
        }
        if (!blocked) {
          officer.fireTimer = OFFICER.fireInterval * (0.8 + random() * 0.5);
          const playerSpeed = p.car ? Math.abs(p.car.speed) : Math.hypot(p.vx, p.vy);
          let chance = clamp(0.62 - d / 620, 0.16, 0.58);
          if (playerSpeed > 150) chance *= 0.55;
          const hit = random() < chance;
          const ex = hit ? pp.x : pp.x + (random() - 0.5) * 130;
          const ey = hit ? pp.y : pp.y + (random() - 0.5) * 130;
          state.particles.push({ x: officer.x, y: officer.y, vx: (ex - officer.x) * 11, vy: (ey - officer.y) * 11, life: 0.09, max: 0.09, size: 2, color: '#ffd23e', grav: 0, tracer: true });
          ev |= EVENT_OFFICER_SHOT;
          if (hit) ev = damagePlayer(OFFICER.damage, ev);
        }
      }
    }
    return ev;
  }

  function damagePlayer(dmg, ev) {
    const p = state.player;
    if (state.over) return ev;
    const absorbed = Math.min(p.armor, dmg * 0.6);
    p.armor -= absorbed;
    p.health -= dmg - absorbed;
    state.shake = Math.min(9, state.shake + 2.4);
    burst(p.x, p.y, 4, ['#e5534b', '#c22e28'], 120, 0.35, 2.4);
    return ev | EVENT_HIT;
  }

  // -------------------------------------------------------------------------
  // Pedestrians: sidewalk rings, panic, and the taxi hail.
  // -------------------------------------------------------------------------

  function ringCorners(bi, bj) {
    const x = bi * PITCH + ROAD_W / 2;
    const y = bj * PITCH + ROAD_W / 2;
    const o = 9;
    return [
      { x: x + o, y: y + o }, { x: x + BLOCK - o, y: y + o },
      { x: x + BLOCK - o, y: y + BLOCK - o }, { x: x + o, y: y + BLOCK - o },
    ];
  }

  function movePed(ped, tx, ty, speed, dt) {
    const dx = tx - ped.x;
    const dy = ty - ped.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) return;
    ped.angle = Math.atan2(dy, dx);
    ped.x += (dx / d) * speed * dt;
    ped.y += (dy / d) * speed * dt;
    const fixed = collideCircle(ped.x, ped.y, 9);
    ped.x = fixed.x;
    ped.y = fixed.y;
    ped.x = clamp(ped.x, 8, CITY_W + 44);
    ped.y = clamp(ped.y, 8, WORLD_H - 8);
    ped.walkPhase += speed * dt * 0.085;
  }

  function respawnPed(ped) {
    for (let tries = 0; tries < 10; tries += 1) {
      const i = Math.floor(random() * 13);
      const j = Math.floor(random() * 10);
      const x = i * PITCH + ROAD_W / 2 + 20 + random() * (BLOCK - 40);
      const y = j * PITCH + ROAD_W / 2 + 14;
      if (dist(x, y, state.player.x, state.player.y) < 520) continue;
      ped.x = x;
      ped.y = y;
      ped.blockI = i;
      ped.blockJ = j;
      ped.mode = 'walk';
      ped.downTimer = 0;
      ped.cross = null;
      return;
    }
    ped.mode = 'walk';
    ped.downTimer = 0;
  }

  function pedUpdate(ped, dt) {
    if (ped.mode === 'down') {
      ped.downTimer -= dt;
      if (ped.downTimer <= 0) respawnPed(ped);
      return;
    }
    if (ped.mode === 'passenger') return;
    // Fast traffic makes anyone sensible dive out of the way.
    if (ped.mode === 'walk' || ped.mode === 'hail') {
      for (const car of state.cars) {
        if (Math.abs(car.speed) < 118) continue;
        if (dist(ped.x, ped.y, car.x, car.y) < 52) {
          ped.mode = 'flee';
          ped.modeTimer = 1.6;
          ped.threatX = car.x;
          ped.threatY = car.y;
          break;
        }
      }
    }
    if (ped.mode === 'flee') {
      ped.modeTimer -= dt;
      const dx = ped.x - ped.threatX;
      const dy = ped.y - ped.threatY;
      const d = Math.hypot(dx, dy) || 1;
      movePed(ped, ped.x + (dx / d) * 110, ped.y + (dy / d) * 110, 212, dt);
      if (ped.modeTimer <= 0) ped.mode = 'walk';
      return;
    }
    if (ped.mode === 'hail') return; // arm up, waiting — the taxi logic watches
    if (ped.mode === 'toCar') {
      const car = state.player.car;
      if (!car) { ped.mode = 'walk'; return; }
      movePed(ped, car.x, car.y, 196, dt);
      if (dist(ped.x, ped.y, car.x, car.y) < car.wid / 2 + 17) {
        ped.mode = 'passenger';
        const taxi = state.taxi;
        taxi.phase = 'ride';
        taxi.car = car;
        taxi.dest = pickTaxiDest();
        taxi.fareBase = dist(car.x, car.y, taxi.dest.x, taxi.dest.y);
        taxi.timer = 160;
        popup('FARE', `Take me to ${districtAt(taxi.dest.x, taxi.dest.y)} — and step on it.`);
      }
      return;
    }
    // Plain walking: around the block's pavement ring, sometimes across the street.
    if (ped.cross) {
      movePed(ped, ped.cross.x, ped.cross.y, 66, dt);
      if (dist(ped.x, ped.y, ped.cross.x, ped.cross.y) < 8) {
        ped.blockI = ped.cross.i;
        ped.blockJ = ped.cross.j;
        ped.corner = ped.cross.corner;
        ped.cross = null;
      }
      return;
    }
    const ring = ringCorners(ped.blockI, ped.blockJ);
    const target = ring[ped.corner];
    movePed(ped, target.x, target.y, 63, dt);
    if (dist(ped.x, ped.y, target.x, target.y) < 8) {
      ped.corner = (ped.corner + ped.dirSign + 4) % 4;
      if (random() < 0.15) {
        const di = random() < 0.5 ? (random() < 0.5 ? 1 : -1) : 0;
        const dj = di === 0 ? (random() < 0.5 ? 1 : -1) : 0;
        const ni = clamp(ped.blockI + di, 0, 12);
        const nj = clamp(ped.blockJ + dj, 0, 9);
        if (ni !== ped.blockI || nj !== ped.blockJ) {
          const nring = ringCorners(ni, nj);
          let bestC = 0;
          let bestD = Infinity;
          for (let c = 0; c < 4; c += 1) {
            const dd = dist(ped.x, ped.y, nring[c].x, nring[c].y);
            if (dd < bestD) { bestD = dd; bestC = c; }
          }
          ped.cross = { i: ni, j: nj, corner: bestC, x: nring[bestC].x, y: nring[bestC].y };
        }
      }
    }
  }

  function pickTaxiDest() {
    const pp = playerPos();
    for (let tries = 0; tries < 14; tries += 1) {
      const i = Math.floor(random() * 14);
      const j = Math.floor(random() * 11);
      const x = roadX(i) + (random() < 0.5 ? -34 : 34);
      const y = roadY(j);
      const d = dist(x, y, pp.x, pp.y);
      if (d > 620 && d < 1700) return { x, y };
    }
    return { x: roadX(3), y: roadY(3) };
  }

  // -------------------------------------------------------------------------
  // Gunfire, collisions and their consequences
  // -------------------------------------------------------------------------

  function segmentCircleT(x1, y1, x2, y2, cx, cy, r) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 0.01) return Infinity;
    let t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (d2 > r * r) return Infinity;
    return Math.max(0, t - Math.sqrt(r * r - d2) / Math.sqrt(len2));
  }

  function playerShoot(dt, ctrl, ev) {
    const p = state.player;
    p.fireTimer -= dt;
    if (p.muzzle > 0) p.muzzle = Math.max(0, p.muzzle - dt * 8);
    if (!ctrl.fire || p.car || state.over) return ev;
    if (p.fireTimer > 0) return ev;
    p.fireTimer = PLAYER.fireInterval;
    p.muzzle = 1;
    state.stats.shots += 1;
    ev |= EVENT_SHOT;
    state.shake = Math.min(6, state.shake + 0.6);
    const a = Math.atan2(ctrl.aimY - p.y, ctrl.aimX - p.x);
    const range = 430;
    const x2 = p.x + Math.cos(a) * range;
    const y2 = p.y + Math.sin(a) * range;
    let bestT = 1;
    let hitKind = 'none';
    let hitObj = null;
    for (const b of state.city.buildings) {
      const t = segmentRectT(p.x, p.y, x2, y2, b);
      if (t < bestT) { bestT = t; hitKind = 'wall'; hitObj = b; }
    }
    for (const o of state.officers) {
      const t = segmentCircleT(p.x, p.y, x2, y2, o.x, o.y, 11);
      if (t < bestT) { bestT = t; hitKind = 'officer'; hitObj = o; }
    }
    for (const ped of state.peds) {
      if (ped.mode === 'down' || ped.mode === 'passenger') continue;
      const t = segmentCircleT(p.x, p.y, x2, y2, ped.x, ped.y, 10);
      if (t < bestT) { bestT = t; hitKind = 'ped'; hitObj = ped; }
    }
    for (const car of state.cars) {
      for (const off of [-0.27, 0.27]) {
        const cx = car.x + Math.cos(car.angle) * car.len * off;
        const cy = car.y + Math.sin(car.angle) * car.len * off;
        const t = segmentCircleT(p.x, p.y, x2, y2, cx, cy, car.wid * 0.62);
        if (t < bestT) { bestT = t; hitKind = 'car'; hitObj = car; }
      }
    }
    const hx = p.x + Math.cos(a) * range * bestT;
    const hy = p.y + Math.sin(a) * range * bestT;
    state.particles.push({ x: p.x + Math.cos(a) * 16, y: p.y + Math.sin(a) * 16, vx: (hx - p.x) / 0.07, vy: (hy - p.y) / 0.07, life: 0.07, max: 0.07, size: 2, color: '#ffe9a3', grav: 0, tracer: true });
    if (hitKind === 'officer') {
      hitObj.hp -= PLAYER.bulletDamage;
      burst(hx, hy, 5, ['#e5534b', '#c22e28'], 130, 0.35, 2.4);
      if (hitObj.hp <= 0 && !hitObj.dead) {
        hitObj.dead = true;
        addHeat(HEAT.officerDown, hitObj.x, hitObj.y, false);
        popup('PALMIRA PD', 'Officer down. Every unit in the city is rolling now.');
      }
    } else if (hitKind === 'ped') {
      hitObj.mode = 'down';
      hitObj.downTimer = 7;
      addHeat(HEAT.pedDown, hitObj.x, hitObj.y, true);
    } else if (hitKind === 'car') {
      hitObj.hp -= PLAYER.bulletDamage * 0.5;
      sparks(hx, hy, 5);
      if (hitObj.kind === 'police') addHeat(48, hx, hy, true);
    } else if (hitKind === 'wall') {
      burst(hx, hy, 3, ['#c9ced2', '#9aa0a3'], 70, 0.3, 2);
    }
    // Noise carries: nearby crowds scatter, and the law hears it too.
    for (const ped of state.peds) {
      if (ped.mode === 'walk' && dist(ped.x, ped.y, p.x, p.y) < 215) {
        ped.mode = 'flee';
        ped.modeTimer = 2.2;
        ped.threatX = p.x;
        ped.threatY = p.y;
      }
    }
    if (state.gunfireTimer <= 0) {
      addHeat(HEAT.gunfire, p.x, p.y, true);
      state.gunfireTimer = HEAT.gunfireThrottle;
    }
    return ev;
  }

  function carVsWorld(car) {
    for (const off of [-0.27, 0.27]) {
      const cx = car.x + Math.cos(car.angle) * car.len * off;
      const cy = car.y + Math.sin(car.angle) * car.len * off;
      const fixed = collideCircle(cx, cy, car.wid * 0.60);
      if (fixed.hit) {
        car.x += fixed.x - cx;
        car.y += fixed.y - cy;
        if (Math.abs(car.speed) > 128 && state.time - (car.lastCrash ?? -9) > 0.25) {
          car.lastCrash = state.time;
          const dmg = (Math.abs(car.speed) - 118) * 0.10;
          car.hp -= dmg;
          sparks((cx + fixed.x) / 2, (cy + fixed.y) / 2, 7);
          if (car.driver === 'player') {
            state.shake = Math.min(9, state.shake + dmg * 0.10);
            pendingEvents |= EVENT_HIT;
          }
        }
        car.speed *= 0.42;
      }
    }
    const pier = city.specials.pier.rect;
    const onPier = car.y > pier.y - 4 && car.y < pier.y + pier.h + 4 && car.x > pier.x - 10;
    const maxX = onPier ? WORLD_W - 26 : CITY_W + BEACH_W - 8;
    if (car.x > maxX) { car.x = maxX; car.speed *= 0.5; }
    car.x = clamp(car.x, 22, WORLD_W - 22);
    car.y = clamp(car.y, 22, WORLD_H - 22);
  }

  function carVsCars(ev) {
    const cars = state.cars;
    for (let i = 0; i < cars.length; i += 1) {
      const a = cars[i];
      for (let j = i + 1; j < cars.length; j += 1) {
        const b = cars[j];
        const aMoving = a.speed !== 0 || a.slideX !== 0 || a.slideY !== 0 || a.driver === 'player';
        const bMoving = b.speed !== 0 || b.slideX !== 0 || b.slideY !== 0 || b.driver === 'player';
        if (!aMoving && !bMoving) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const rr = (a.len + b.len) * 0.40;
        const d2 = dx * dx + dy * dy;
        if (d2 > rr * rr || d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = rr - d;
        const aShare = a.kind === 'parked' ? 0.25 : 0.5;
        const bShare = b.kind === 'parked' ? 0.25 : 0.5;
        a.x -= nx * overlap * aShare;
        a.y -= ny * overlap * aShare;
        b.x += nx * overlap * bShare;
        b.y += ny * overlap * bShare;
        const avx = Math.cos(a.angle) * a.speed + a.slideX;
        const avy = Math.sin(a.angle) * a.speed + a.slideY;
        const bvx = Math.cos(b.angle) * b.speed + b.slideX;
        const bvy = Math.sin(b.angle) * b.speed + b.slideY;
        const rel = (avx - bvx) * nx + (avy - bvy) * ny;
        if (rel > 26) {
          const dmg = (rel - 26) * 0.115;
          // Crash damage is per-impact, not per-step: two cars grinding along each
          // other stay in contact for many steps, and without this gate a single ram
          // would melt both cars at sixty times the intended rate.
          let impacted = false;
          if (state.time - (a.lastDmgAt ?? -9) > 0.22) {
            a.hp -= dmg;
            a.lastDmgAt = state.time;
            impacted = true;
          }
          if (state.time - (b.lastDmgAt ?? -9) > 0.22) {
            b.hp -= dmg;
            b.lastDmgAt = state.time;
            impacted = true;
          }
          if (impacted) sparks((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(12, 4 + dmg * 0.4));
          a.slideX -= nx * rel * 0.22;
          a.slideY -= ny * rel * 0.22;
          b.slideX += nx * rel * 0.22;
          b.slideY += ny * rel * 0.22;
          const playerCar = state.player.car;
          if (playerCar && (a === playerCar || b === playerCar)) {
            const other = a === playerCar ? b : a;
            state.shake = Math.min(9, state.shake + dmg * 0.09);
            ev |= EVENT_HIT;
            if (rel > 62 && state.time - (other.lastHitCrime ?? -9) > 2.5) {
              other.lastHitCrime = state.time;
              if (other.kind === 'police') addHeat(HEAT.hitPolice, other.x, other.y, false);
              else addHeat(HEAT.hitCar, other.x, other.y, true);
            }
          }
        }
        if (a.driver !== 'player') a.speed *= 0.88;
        if (b.driver !== 'player') b.speed *= 0.88;
      }
    }
    return ev;
  }

  function pedVsCars() {
    for (const ped of state.peds) {
      if (ped.mode === 'down' || ped.mode === 'passenger') continue;
      for (const car of state.cars) {
        const spd = Math.abs(car.speed);
        if (spd < 48 && Math.abs(car.slideX) + Math.abs(car.slideY) < 30) continue;
        let hit = false;
        for (const off of [-0.27, 0.27]) {
          const cx = car.x + Math.cos(car.angle) * car.len * off;
          const cy = car.y + Math.sin(car.angle) * car.len * off;
          if (dist(ped.x, ped.y, cx, cy) < car.wid * 0.60 + 9) { hit = true; break; }
        }
        if (!hit) continue;
        if (spd > 62) {
          ped.mode = 'down';
          ped.downTimer = 7;
          car.speed *= 0.84;
          if (car.driver === 'player') {
            addHeat(HEAT.pedDown, ped.x, ped.y, true);
            state.shake = Math.min(8, state.shake + 2);
            pendingEvents |= EVENT_HIT;
          }
        } else if (ped.mode === 'walk') {
          ped.mode = 'flee';
          ped.modeTimer = 1.4;
          ped.threatX = car.x;
          ped.threatY = car.y;
        }
        break;
      }
    }
  }

  function playerVsCars(ev) {
    const p = state.player;
    if (p.car || state.over) return ev;
    for (const car of state.cars) {
      if (car.driver === 'player') continue;
      for (const off of [-0.27, 0.27]) {
        const cx = car.x + Math.cos(car.angle) * car.len * off;
        const cy = car.y + Math.sin(car.angle) * car.len * off;
        const d = dist(p.x, p.y, cx, cy);
        const rr = car.wid * 0.60 + PLAYER.radius;
        if (d >= rr) continue;
        const spd = Math.abs(car.speed);
        if (spd > 96) {
          ev = damagePlayer((spd - 88) * 0.085, ev);
          p.vx += Math.cos(car.angle) * 170;
          p.vy += Math.sin(car.angle) * 170;
          car.speed *= 0.8;
        } else {
          const push = rr - d;
          const nx = (p.x - cx) / (d || 1);
          const ny = (p.y - cy) / (d || 1);
          p.x += nx * push;
          p.y += ny * push;
        }
        return ev;
      }
    }
    return ev;
  }

  // -------------------------------------------------------------------------
  // The step itself
  // -------------------------------------------------------------------------

  function step(dt, ctrl, ambient = false) {
    let ev = pendingEvents;
    pendingEvents = 0;
    const p = state.player;
    state.time += dt;
    state.clock = (state.clock + dt * (24 / DAY_SECONDS)) % 24;
    state.gunfireTimer = Math.max(0, state.gunfireTimer - dt);
    state.resprayCooldown = Math.max(0, state.resprayCooldown - dt);
    for (const popupItem of state.popups) popupItem.ttl -= dt;
    state.popups = state.popups.filter((item) => item.ttl > 0);
    if (state.banner) {
      state.banner.ttl -= dt;
      if (state.banner.ttl <= 0) state.banner = null;
    }
    if (state.radio) {
      state.radio.ttl -= dt;
      if (state.radio.ttl <= 0) state.radio = null;
    }

    // Rio.
    if (!state.over && !ambient) {
      if (p.car) ev = playerDrive(dt, ctrl, ev);
      else ev = playerFoot(dt, ctrl, ev);
      ev = playerShoot(dt, ctrl, ev);
    }

    // Cars.
    for (const car of state.cars) {
      if (car.driver === 'player') continue;
      if (car.kind === 'police') policeDrive(car, dt);
      else if (car.driver === 'ai') trafficDrive(car, dt);
      else {
        car.x += car.slideX * dt;
        car.y += car.slideY * dt;
        car.slideX = lerp(car.slideX, 0, clamp(dt * 5, 0, 1));
        car.slideY = lerp(car.slideY, 0, clamp(dt * 5, 0, 1));
        car.speed = lerp(car.speed, 0, clamp(dt * 3, 0, 1));
      }
      if (car.hp <= 0 && !car.wrecked) {
        car.wrecked = true;
        if (car.driver === 'ai') {
          car.driver = 'none';
          spawnPed(car.x + 18, car.y + 8);
          const ped = state.peds[state.peds.length - 1];
          ped.mode = 'flee';
          ped.modeTimer = 2.4;
          ped.threatX = car.x - 30;
          ped.threatY = car.y;
        }
      }
    }
    for (const car of state.cars) carVsWorld(car);
    ev = carVsCars(ev);

    // Officers and pedestrians.
    for (const officer of state.officers) ev = officerUpdate(officer, dt, ev);
    state.officers = state.officers.filter((o) => !o.dead && (state.stars > 0 || state.cars.includes(o.car)));
    for (const ped of state.peds) pedUpdate(ped, dt);
    pedVsCars();
    ev = playerVsCars(ev);

    // Who is watching Rio, and does the heat cool?
    let seen = false;
    const pp = playerPos();
    for (const car of state.cars) {
      if (car.kind !== 'police' || car.leaveMode) continue;
      if (dist(car.x, car.y, pp.x, pp.y) < 440) { seen = true; break; }
    }
    if (!seen) {
      for (const o of state.officers) {
        if (dist(o.x, o.y, pp.x, pp.y) < 400) { seen = true; break; }
      }
    }
    if (seen) state.seenTimer = 0;
    else state.seenTimer += dt;
    if (state.seenTimer > HEAT.decayDelay && state.heat > 0) {
      state.heat = Math.max(0, state.heat - HEAT.decayRate * dt);
      state.stars = starsFor(state.heat);
    }

    // The patrol manager: field the right number of units, recycle the rest.
    const activePolice = state.cars.filter((c) => c.kind === 'police' && !c.leaveMode && !c.wrecked);
    if (state.stars === 0) {
      for (const c of activePolice) c.leaveMode = true;
    } else if (activePolice.length < POLICE_UNITS[state.stars]) {
      state.policeSpawnTimer -= dt;
      if (state.policeSpawnTimer <= 0) {
        state.policeSpawnTimer = 1.1;
        const unit = makeCar('police', 'police', 0, 0, 0);
        if (placeOnRoad(unit, pp.x, pp.y, 545, 790)) {
          unit.driver = 'ai';
          state.cars.push(unit);
        }
      }
    } else if (activePolice.length > POLICE_UNITS[state.stars]) {
      let far = null;
      let farD = -1;
      for (const c of activePolice) {
        const d = dist(c.x, c.y, pp.x, pp.y);
        if (d > farD) { farD = d; far = c; }
      }
      if (far) far.leaveMode = true;
    }
    state.cars = state.cars.filter((c) => !(c.kind === 'police' && ((c.leaveMode && dist(c.x, c.y, pp.x, pp.y) > 880) || (c.wrecked && dist(c.x, c.y, pp.x, pp.y) > 950))));
    // Keep the city's traffic density up around Rio; recycle what wandered off.
    let trafficCount = 0;
    for (const car of state.cars) {
      if (car.kind !== 'traffic') continue;
      trafficCount += 1;
      if (dist(car.x, car.y, pp.x, pp.y) > 3050) placeOnRoad(car, pp.x, pp.y, 1500, 2600);
    }
    if (trafficCount < TRAFFIC_COUNT && random() < dt * 0.7) spawnTraffic();

    // The bust meter: close, slow and watched is how Rio gets caught.
    if (!state.over && state.stars > 0) {
      const pSpeed = p.car ? Math.abs(p.car.speed) : Math.hypot(p.vx, p.vy);
      let threat = false;
      if (pSpeed < 46) {
        for (const o of state.officers) {
          if (dist(o.x, o.y, pp.x, pp.y) < BUST.radiusFoot + 8) { threat = true; break; }
        }
        if (!threat) {
          for (const car of state.cars) {
            if (car.kind !== 'police' || car.leaveMode || car.wrecked) continue;
            if (dist(car.x, car.y, pp.x, pp.y) < BUST.radiusCar) { threat = true; break; }
          }
        }
      }
      if (threat) state.bust = Math.min(1, state.bust + dt / BUST.seconds);
      else state.bust = Math.max(0, state.bust - dt * 0.5);
      if (state.bust >= 1) {
        state.over = 'busted';
        state.stats.busts += 1;
        ev |= EVENT_BUSTED;
      }
    } else if (state.stars === 0) state.bust = 0;

    // Pickups.
    for (const pk of state.pickups) {
      if (!pk.active) {
        pk.timer -= dt;
        if (pk.timer <= 0) pk.active = true;
        continue;
      }
      if (dist(pk.x, pk.y, pp.x, pp.y) < 25) {
        if (pk.kind === 'health' && p.health < PLAYER.health) {
          p.health = Math.min(PLAYER.health, p.health + 40);
        } else if (pk.kind === 'armor' && p.armor < PLAYER.armor) {
          p.armor = Math.min(PLAYER.armor, p.armor + 50);
        } else continue;
        pk.active = false;
        pk.timer = 45;
        sparkle(pk.x, pk.y);
        ev |= EVENT_PICKUP;
      }
    }

    // The respray: roll in unseen, roll out a stranger.
    const bay = city.specials.respray.bay;
    const inBayNow = !!p.car && p.car.x > bay.x && p.car.x < bay.x + bay.w && p.car.y > bay.y && p.car.y < bay.y + bay.h;
    if (inBayNow && !state.inBay && state.resprayCooldown <= 0 && state.heat > 0) {
      let copNear = false;
      for (const car of state.cars) {
        if (car.kind === 'police' && dist(car.x, car.y, p.car.x, p.car.y) < 330) { copNear = true; break; }
      }
      if (copNear) popup('SHINE & GO', 'Too hot, friend. Lose the blue lights first.');
      else if (state.cash >= RESPRAY_FEE) {
        state.cash -= RESPRAY_FEE;
        state.heat = 0;
        state.stars = 0;
        state.resprayCooldown = 6;
        popup('SHINE & GO', 'Fresh coat, new plates. You are nobody again.');
        ev |= EVENT_CASH;
      } else popup('SHINE & GO', `A respray runs $${RESPRAY_FEE}. You are short.`);
    }
    state.inBay = inBayNow;

    // Taxi work.
    const taxi = state.taxi;
    if (taxi.phase === 'idle' && !ambient) {
      taxi.hailTimer -= dt;
      if (taxi.hailTimer <= 0) {
        taxi.hailTimer = 8;
        let bestPed = null;
        let bestD = 660;
        for (const ped of state.peds) {
          if (ped.mode !== 'walk') continue;
          const d = dist(ped.x, ped.y, pp.x, pp.y);
          if (d < bestD) { bestD = d; bestPed = ped; }
        }
        if (bestPed) {
          bestPed.mode = 'hail';
          bestPed.hailTimer = 26;
          taxi.ped = bestPed;
          taxi.phase = 'pickup';
        }
      }
    } else if (taxi.phase === 'pickup') {
      const ped = taxi.ped;
      if (!ped || ped.mode === 'down') {
        taxi.phase = 'idle';
        taxi.ped = null;
        state.taxiObjective = null;
      } else {
        ped.hailTimer -= dt;
        state.taxiObjective = { text: 'Pick up the fare', x: ped.x, y: ped.y };
        if (ped.mode === 'hail' && ped.hailTimer <= 0) {
          ped.mode = 'walk';
          taxi.phase = 'idle';
          taxi.ped = null;
          state.taxiObjective = null;
        } else if (ped.mode === 'hail' && p.car && dist(p.car.x, p.car.y, ped.x, ped.y) < 54 && Math.abs(p.car.speed) < 32) {
          ped.mode = 'toCar';
        }
      }
    } else if (taxi.phase === 'ride') {
      taxi.timer -= dt;
      state.taxiObjective = { text: `Fare — ${districtAt(taxi.dest.x, taxi.dest.y)}`, x: taxi.dest.x, y: taxi.dest.y };
      const ped = taxi.ped;
      if (p.car !== taxi.car) {
        // Rio ditched the cab: the fare climbs out wherever that was.
        if (ped) {
          ped.mode = 'walk';
          ped.x = taxi.car.x + 20;
          ped.y = taxi.car.y + 14;
        }
        popup('FARE', 'The passenger bails out. No tip, no fare.');
        taxi.phase = 'idle';
        taxi.ped = null;
        state.taxiObjective = null;
      } else if (dist(p.car.x, p.car.y, taxi.dest.x, taxi.dest.y) < 48 && Math.abs(p.car.speed) < 42) {
        const fare = Math.round(45 + taxi.fareBase * 0.055 + Math.max(0, taxi.timer) * 0.35);
        state.cash += fare;
        state.stats.fares += 1;
        state.stats.earned += fare;
        popup('FARE', `+$${fare} — "Fast and clean. Five stars."`);
        ev |= EVENT_CASH;
        if (ped) {
          ped.mode = 'walk';
          ped.x = taxi.dest.x + 14;
          ped.y = taxi.dest.y + 10;
        }
        taxi.phase = 'idle';
        taxi.ped = null;
        state.taxiObjective = null;
      } else if (taxi.timer <= 0) {
        popup('FARE', 'Too slow — the fare walks away mad.');
        if (ped) {
          ped.mode = 'walk';
          ped.x = p.car.x + 20;
          ped.y = p.car.y + 14;
        }
        taxi.phase = 'idle';
        taxi.ped = null;
        state.taxiObjective = null;
      }
    }

    // WASTED.
    if (!state.over && p.health <= 0) {
      state.over = 'wasted';
      state.stats.wasteds += 1;
      ev |= EVENT_WASTED;
    }

    // Decoration updates.
    for (const pt of state.particles) {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy += (pt.grav ?? 0) * dt;
      pt.life -= dt;
    }
    state.particles = state.particles.filter((pt) => pt.life > 0);
    for (const skid of state.skids) skid.age += dt;
    state.skids = state.skids.filter((skid) => skid.age < 16);

    // Camera: follow Rio, lean into the speed, breathe out at pace.
    const cam = state.camera;
    let lookX = 0;
    let lookY = 0;
    if (p.car) {
      lookX = Math.cos(p.car.angle) * p.car.speed * 0.38;
      lookY = Math.sin(p.car.angle) * p.car.speed * 0.38;
    }
    cam.x = lerp(cam.x, pp.x + lookX, clamp(dt * 4.6, 0, 1));
    cam.y = lerp(cam.y, pp.y + lookY, clamp(dt * 4.6, 0, 1));
    const targetZoom = p.car ? 1 - 0.20 * Math.min(1, Math.abs(p.car.speed) / p.car.spec.top) : 1;
    cam.zoom = lerp(cam.zoom, targetZoom, clamp(dt * 2.6, 0, 1));
    if (state.shake > 0) state.shake = Math.max(0, state.shake - dt * 15);
    return ev;
  }

  reset();
  return {
    state, reset, respawn, getSaveData, loadSaveData,
    popup, banner, spawnSpecialCar, playerPos, exitCar,
    addHeat, setHeatAtLeast, step,
  };
}
