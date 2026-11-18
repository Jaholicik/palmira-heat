// The simulation of Palmira Heat: Rio on foot and behind the wheel, traffic that follows the
// road network, pedestrians on the sidewalks, the wanted system and the police who answer it,
// gunplay, pickups, taxi fares, the respray garage, particles and the day/night clock. No
// drawing and no browser in here: step() advances one fixed step from an input struct and
// returns what happened as bit flags, so the caller (the live loop, or the screenshot staging)
// reacts without the world knowing about screens or sound. Every random decision comes from
// the seeded RNG handed to createWorld — the same seed always grows the same city and the
// same day.
import {
  CAR, CLOCK, ECONOMY, GUN, OFFICER, PEDS, PLAYER, RADIO_STATIONS, STEP, TAXI, TRAFFIC, WANTED,
} from './config.js';
import {
  BEACH_ROAD_X, LANE, SAND_X, WATER_X, WORLD_H, WORLD_W,
  buildCity, circleHitsSolid, districtAt, resolveCircle, roadX, roadY,
} from './city.js';
import { GRID, PITCH } from './config.js';
import { createStory } from './missions.js';

export const EV_SHOT = 1;
export const EV_OSHOT = 2;
export const EV_HURT = 4;
export const EV_PICKUP = 8;
export const EV_CRIME = 16;
export const EV_BUSTED = 32;
export const EV_WASTED = 64;
export const EV_JINGLE = 128;
export const EV_ENTER = 256;
export const EV_CASH = 512;
export const EV_SIREN = 1024;

const TAU = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
function angleWrap(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
function angleTurn(current, target, maxStep) {
  const d = angleWrap(target - current);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export function createWorld(random) {
  const city = buildCity(random);
  let events = 0;

  const player = {
    x: city.start.x, y: city.start.y, angle: -Math.PI / 2,
    health: PLAYER.health, armor: 0, car: null, fireCd: 0, grace: 0, walkCycle: 0,
  };
  const state = {
    city, player,
    cars: [], peds: [], particles: [], tracers: [], skids: [], pickups: [],
    cash: ECONOMY.startCash,
    wanted: { heat: 0, stars: 0, bust: 0, seen: false, unseenTime: 0, holdTimer: 0 },
    clock: { hour: CLOCK.startHour, day: 1 },
    banner: { title: '', sub: '', t: 0 },
    district: districtAt(player.x, player.y),
    shake: 0, shakeX: 0, shakeY: 0,
    time: 0,
    over: null,
    taxi: { phase: 'none', ped: null, dest: null, dist: 0, dirty: false, hailTimer: 6 },
    stats: { stolen: 0, pedsDown: 0, shots: 0, missions: 0, fares: 0, earned: 0, arrests: 0, deaths: 0 },
    resprayArmed: true,
    story: null,
  };

  // ---------------------------------------------------------------- particles & effects
  function spawnParticle(x, y, vx, vy, life, size, color, grav = 0, drag = 0) {
    if (state.particles.length > 420) state.particles.shift();
    state.particles.push({ x, y, vx, vy, life, maxLife: life, size, color, grav, drag });
  }
  function sparks(x, y, n = 8) {
    for (let i = 0; i < n; i += 1) {
      const a = random() * TAU;
      const sp = 60 + random() * 240;
      spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.25 + random() * 0.3, 2.2, random() < 0.5 ? '#ffd94d' : '#ff9a3d', 300, 2);
    }
  }
  function smoke(x, y, n = 3) {
    for (let i = 0; i < n; i += 1) {
      spawnParticle(x + (random() - 0.5) * 10, y + (random() - 0.5) * 10, (random() - 0.5) * 24, -30 - random() * 30, 0.8 + random() * 0.9, 7 + random() * 7, '#555a60', -40, 1);
    }
  }
  function sparkle(x, y) {
    for (let i = 0; i < 14; i += 1) {
      const a = random() * TAU;
      const sp = 30 + random() * 90;
      spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 40, 0.5 + random() * 0.4, 2.6, random() < 0.5 ? '#8fe388' : '#ffd94d', 120, 1);
    }
  }
  function tracer(x1, y1, x2, y2, color) {
    state.tracers.push({ x1, y1, x2, y2, life: 0.07, color });
    if (state.tracers.length > 40) state.tracers.shift();
  }

  // ---------------------------------------------------------------- banners & money
  function banner(title, sub = '') {
    state.banner.title = title;
    state.banner.sub = sub;
    state.banner.t = 3.6;
  }
  function pay(n) {
    state.cash += n;
    state.stats.earned += n;
    events |= EV_CASH;
  }

  // ---------------------------------------------------------------- cars
  let carSeq = 0;
  function makeCar(kind, x, y, angle, driver) {
    const car = {
      id: carSeq += 1, kind, x, y, angle, speed: 0,
      color: '#888', driver, health: kind === 'van' ? 260 : 120,
      dead: false, tag: '', armored: false, officer: null, skidTimer: 0,
      ii: 0, jj: 0, dx: 0, dy: -1, cruise: TRAFFIC.speed * (0.85 + random() * 0.3),
      honk: 0,
    };
    return car;
  }
  function lanePoint(ii, jj, dx, dy) {
    if (dy < 0) return { x: roadX(ii) + LANE, y: roadY(jj) };
    if (dy > 0) return { x: roadX(ii) - LANE, y: roadY(jj) };
    if (dx > 0) return { x: roadX(ii), y: roadY(jj) + LANE };
    return { x: roadX(ii), y: roadY(jj) - LANE };
  }
  /** Place a traffic car on a road somewhere sensible and give it a first target. */
  function spawnTrafficCar(nearX, nearY, far) {
    for (let tries = 0; tries < 12; tries += 1) {
      const vertical = random() < 0.55;
      const ii = Math.floor(random() * (GRID.cols + 1));
      const jj = Math.floor(random() * GRID.rows);
      let x; let y; let dx = 0; let dy = 0;
      if (vertical) {
        dy = jj === 0 ? 1 : jj === GRID.rows - 1 ? -1 : random() < 0.5 ? -1 : 1;
        const p = lanePoint(ii, jj, 0, dy);
        x = p.x; y = p.y + (random() - 0.5) * 120;
      } else {
        dx = ii === 0 ? 1 : ii === GRID.cols ? -1 : random() < 0.5 ? -1 : 1;
        const p = lanePoint(ii, jj, dx, 0);
        x = p.x + (random() - 0.5) * 120; y = p.y;
      }
      const d2 = dist2(x, y, nearX, nearY);
      if (far && d2 < 480 * 480) continue;
      if (!far && d2 > 1250 * 1250) continue;
      if (circleHitsSolid(city, x, y, CAR.radius)) continue;
      const kinds = ['sedan', 'sedan', 'sedan', 'sport', 'taxi', 'van', 'truck'];
      const kind = kinds[Math.floor(random() * kinds.length)];
      const car = makeCar(kind, x, y, Math.atan2(dy, dx), 'traffic');
      car.color = kind === 'taxi' ? '#f2c230' : ['#c0392b', '#2471a3', '#229954', '#b7950b', '#7d3c98', '#ba4a00', '#616a6b', '#aed6f1', '#f5b7b1', '#d5d8dc'][Math.floor(random() * 10)];
      car.ii = ii; car.jj = jj; car.dx = dx; car.dy = dy;
      const t = lanePoint(ii + dx, jj + dy, dx, dy);
      car.tx = t.x; car.ty = t.y;
      state.cars.push(car);
      return car;
    }
    return null;
  }
  function spawnParkedCars() {
    for (let n = 0; n < TRAFFIC.parked; n += 1) {
      const vertical = random() < 0.6;
      const i = Math.floor(random() * (GRID.cols + 1));
      const j = Math.floor(random() * GRID.rows);
      const along = (random() * 0.8 + 0.1) * PITCH;
      let x; let y; let angle;
      if (vertical) {
        x = roadX(i) + (random() < 0.5 ? -1 : 1) * (GRID.road / 2 - 11);
        y = j * PITCH + GRID.road + along * 0.8;
        angle = random() < 0.5 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        x = i * PITCH + GRID.road + along * 0.8;
        y = roadY(j) + (random() < 0.5 ? -1 : 1) * (GRID.road / 2 - 11);
        angle = random() < 0.5 ? 0 : Math.PI;
      }
      if (x > SAND_X - 24) continue; // the last horizontal slot would land on the beach
      if (circleHitsSolid(city, x, y, CAR.radius)) continue;
      let clash = false;
      for (const c of state.cars) if (dist2(x, y, c.x, c.y) < 70 * 70) { clash = true; break; }
      if (clash) continue;
      const kinds = ['sedan', 'sedan', 'sport', 'van'];
      const kind = kinds[Math.floor(random() * kinds.length)];
      const car = makeCar(kind, x, y, angle, 'parked');
      car.color = ['#c0392b', '#2471a3', '#229954', '#b7950b', '#7d3c98', '#ba4a00', '#616a6b', '#aed6f1', '#f5b7b1', '#d5d8dc', '#2e4053'][Math.floor(random() * 11)];
      state.cars.push(car);
    }
  }
  function spawnSpecialCar(x, y, angle, opts) {
    const car = makeCar(opts.kind, x, y, angle, 'parked');
    car.color = opts.color;
    car.tag = opts.tag || '';
    car.armored = !!opts.armored;
    if (opts.armored) car.health = 520;
    state.cars.push(car);
    return car;
  }
  function spawnPoliceCar() {
    // Enter from a road a good way off, close enough to matter, never on top of the player.
    for (let tries = 0; tries < 14; tries += 1) {
      const a = random() * TAU;
      const d = 560 + random() * 220;
      const x = clamp(player.x + Math.cos(a) * d, 40, WORLD_W - 40);
      const y = clamp(player.y + Math.sin(a) * d, 40, WORLD_H - 40);
      // Snap to the nearest road centre so they arrive driving, not through a wall.
      const ii = clamp(Math.round((x - GRID.road / 2) / PITCH), 0, GRID.cols);
      const jj = clamp(Math.round((y - GRID.road / 2) / PITCH), 0, GRID.rows - 1);
      const px = roadX(ii);
      const py = roadY(jj);
      if (circleHitsSolid(city, px, py, CAR.radius)) continue;
      const car = makeCar('police', px, py, Math.atan2(player.y - py, player.x - px), 'police');
      car.color = '#eef1f5';
      car.health = 200;
      state.cars.push(car);
      return car;
    }
    return null;
  }

  // ---------------------------------------------------------------- pedestrians
  function ringRect(i, j) {
    const inset = GRID.road + GRID.walk / 2;
    return { x: i * PITCH + inset, y: j * PITCH + inset, w: PITCH - inset * 2, h: PITCH - inset * 2 };
  }
  function ringPos(i, j, perim) {
    const r = ringRect(i, j);
    const w = r.w;
    const h = r.h;
    const total = 2 * (w + h);
    let p = ((perim % total) + total) % total;
    if (p < w) return { x: r.x + p, y: r.y };
    p -= w;
    if (p < h) return { x: r.x + w, y: r.y + p };
    p -= h;
    if (p < w) return { x: r.x + w - p, y: r.y + h };
    p -= w;
    return { x: r.x, y: r.y + h - p };
  }
  function makePed(x, y, kind) {
    return {
      x, y, angle: random() * TAU, kind,
      state: 'walk', perim: 0, bi: 0, bj: 0, dir: 1,
      speed: PEDS.walkSpeed * (0.7 + random() * 0.6),
      fleeT: 0, threatX: 0, threatY: 0, downT: 0, health: 100,
      shootCd: 1 + random(), car: null, shirt: ['#e07a5f', '#81b29a', '#f2cc8f', '#5b8e7d', '#d1788f', '#aed6f1', '#f5b7b1', '#d5d8dc'][Math.floor(random() * 8)],
      skin: ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'][Math.floor(random() * 5)],
      walkCycle: random() * TAU,
    };
  }
  function spawnPed() {
    const i = Math.floor(random() * GRID.cols);
    const j = Math.floor(random() * GRID.rows);
    const ped = makePed(0, 0, 'walker');
    ped.bi = i; ped.bj = j;
    const r = ringRect(i, j);
    ped.perim = random() * 2 * (r.w + r.h);
    ped.dir = random() < 0.5 ? 1 : -1;
    const p = ringPos(i, j, ped.perim);
    ped.x = p.x; ped.y = p.y;
    state.peds.push(ped);
    return ped;
  }
  function nearestRing(x, y) {
    const i = clamp(Math.floor(x / PITCH), 0, GRID.cols - 1);
    const j = clamp(Math.floor(y / PITCH), 0, GRID.rows - 1);
    const r = ringRect(i, j);
    // Find the closest perimeter distance by sampling the four sides coarsely.
    let best = 0;
    let bestD = Infinity;
    const total = 2 * (r.w + r.h);
    for (let p = 0; p < total; p += 8) {
      const q = ringPos(i, j, p);
      const d = dist2(x, y, q.x, q.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { i, j, perim: best };
  }

  // ---------------------------------------------------------------- pickups
  function addPickup(kind, x, y) {
    state.pickups.push({ kind, x, y, active: true, respawn: 0 });
  }
  addPickup('health', city.hospital.door.x, city.hospital.door.y + 26);
  addPickup('armor', city.police.door.x + 30, city.police.door.y + 26);
  addPickup('health', SAND_X + 120, roadY(5));
  addPickup('armor', city.docks.apron.x - 60, city.docks.apron.y - 30);
  addPickup('health', roadX(4), roadY(8));

  // ---------------------------------------------------------------- wanted & crime
  function anyWitness(x, y, r) {
    for (const p of state.peds) {
      if (p.state !== 'down' && dist2(x, y, p.x, p.y) < r * r) return true;
    }
    for (const c of state.cars) {
      if (c.driver === 'police' && dist2(x, y, c.x, c.y) < r * r) return true;
    }
    return false;
  }
  function reportCrime(kind, x, y) {
    const w = state.wanted;
    let heat = 0;
    let needsWitness = true;
    if (kind === 'theft') { heat = 105; needsWitness = true; }
    else if (kind === 'pedDown') { heat = 115; needsWitness = true; }
    else if (kind === 'gunfire') { heat = 60; needsWitness = true; }
    else if (kind === 'hitPolice') { heat = 140; needsWitness = false; }
    else if (kind === 'killOfficer') { heat = 230; needsWitness = false; }
    else if (kind === 'hitCar') { heat = 30; needsWitness = true; }
    else if (kind === 'mission') { heat = 0; needsWitness = false; }
    if (needsWitness && !anyWitness(x, y, 300)) {
      // Unseen crime still makes a little noise, never a full star on its own.
      heat = Math.min(heat, 18);
    }
    const before = w.stars;
    w.heat = clamp(w.heat + heat, 0, WANTED.perStar * WANTED.maxStars);
    w.holdTimer = WANTED.seenHold;
    w.stars = w.heat <= 0 ? 0 : Math.min(WANTED.maxStars, Math.ceil(w.heat / WANTED.perStar));
    if (w.stars > before) events |= EV_CRIME;
  }
  function setStars(n) {
    const w = state.wanted;
    w.heat = n * WANTED.perStar;
    w.stars = n;
    w.holdTimer = WANTED.seenHold;
  }
  function clearWanted() {
    state.wanted.heat = 0;
    state.wanted.stars = 0;
    state.wanted.bust = 0;
    state.wanted.unseenTime = 0;
  }

  // ---------------------------------------------------------------- damage
  function hurtPlayer(amount) {
    if (player.grace > 0 || state.over) return;
    let left = amount;
    if (player.armor > 0) {
      const absorbed = Math.min(player.armor, amount * 0.6);
      player.armor -= absorbed;
      left = amount - absorbed;
    }
    player.health -= left;
    events |= EV_HURT;
    state.shake = Math.min(state.shake + 1.6, 5);
    if (player.health <= 0 && !state.over) {
      player.health = 0;
      state.over = 'wasted';
      state.stats.deaths += 1;
      events |= EV_WASTED;
    }
  }

  // ---------------------------------------------------------------- respawns
  function exitCarTo(x, y) {
    if (player.car) {
      if (player.car.driver === 'player') player.car.driver = 'parked';
      player.car = null;
    }
    player.x = x;
    player.y = y;
    resolveCircle(city, player, PLAYER.radius);
  }
  function respawnBusted() {
    state.cash = Math.max(0, state.cash - ECONOMY.bustFine);
    state.stats.arrests += 1;
    clearWanted();
    // Officers walk away; their cars stay where they stopped.
    for (const p of state.peds) if (p.kind === 'officer') p.state = 'leave';
    exitCarTo(city.police.door.x, city.police.door.y);
    player.health = Math.max(player.health, 60);
    player.grace = PLAYER.grace;
    state.over = null;
    banner('RELEASED', `Fine $${ECONOMY.bustFine}. The PD keeps the car keys warm.`);
  }
  function respawnWasted() {
    state.cash = Math.max(0, state.cash - ECONOMY.wastedFee);
    clearWanted();
    exitCarTo(city.hospital.door.x, city.hospital.door.y);
    player.health = PLAYER.health;
    player.grace = PLAYER.grace;
    state.over = null;
    banner('DISCHARGED', `Hospital fee $${ECONOMY.wastedFee}. Try to keep the red stuff inside.`);
  }

  // ---------------------------------------------------------------- story bridge
  const storyApi = {
    state, city, random,
    spawnSpecialCar,
    setStars,
    addHeat: (n) => { state.wanted.heat = clamp(state.wanted.heat + n, 0, 500); },
    pay,
    banner,
    sparkle,
    jingle: () => { events |= EV_JINGLE; },
    pickupSound: () => { events |= EV_PICKUP; },
    autosave: () => { state.stats.missions = Math.max(state.stats.missions, state.story ? state.story.index : 0); },
  };
  const storyCtl = createStory(storyApi);

  function reset() {
    state.cars.length = 0;
    state.peds.length = 0;
    state.particles.length = 0;
    state.tracers.length = 0;
    state.skids.length = 0;
    player.x = city.start.x;
    player.y = city.start.y;
    player.angle = -Math.PI / 2;
    player.health = PLAYER.health;
    player.armor = 0;
    player.car = null;
    player.fireCd = 0;
    player.grace = 0;
    state.cash = ECONOMY.startCash;
    state.clock.hour = CLOCK.startHour;
    state.clock.day = 1;
    state.time = 0;
    state.over = null;
    clearWanted();
    state.taxi.phase = 'none';
    state.taxi.ped = null;
    state.taxi.dest = null;
    state.stats = { stolen: 0, pedsDown: 0, shots: 0, missions: 0, fares: 0, earned: 0, arrests: 0, deaths: 0 };
    for (const pk of state.pickups) { pk.active = true; pk.respawn = 0; }
    spawnParkedCars();
    for (let n = 0; n < TRAFFIC.count; n += 1) spawnTrafficCar(player.x, player.y, false);
    for (let n = 0; n < PEDS.count; n += 1) spawnPed();
    storyCtl.story.index = 0;
    storyCtl.story.active = false;
    storyCtl.story.complete = false;
  }

  // ---------------------------------------------------------------- car physics
  /** Move one car one step under throttle/steer; handles walls, water and other cars. */
  function driveCar(car, dt, throttle, steer) {
    const top = CAR.topSpeed[car.kind] || 420;
    const speedBefore = car.speed;
    if (throttle > 0) car.speed += CAR.accel * throttle * dt;
    else if (throttle < 0) car.speed += (car.speed > 4 ? -CAR.brake : -CAR.accel * 0.55) * -throttle * dt;
    car.speed -= car.speed * CAR.drag * dt;
    if (car.x >= SAND_X && car.x < WATER_X) car.speed -= car.speed * 1.4 * dt; // sand drags
    car.speed = clamp(car.speed, -CAR.reverse, top);
    if (Math.abs(car.speed) < 2 && throttle === 0) car.speed = 0;
    const turn = steer * CAR.steer * dt * clamp(car.speed / 150, -1, 1);
    car.angle += turn;
    // Purely visual state for the renderer: how far the front wheels are turned, and whether
    // the brake lights should burn. Both derive from the same inputs, so frames stay seeded.
    car.steerVis = (car.steerVis || 0) + (steer - (car.steerVis || 0)) * Math.min(1, dt * 9);
    car.brakeVis = throttle < -0.05 || speedBefore - car.speed > 2.2;
    const px = car.x;
    const py = car.y;
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    car.x = clamp(car.x, 24, WATER_X - 26);
    car.y = clamp(car.y, 24, WORLD_H - 24);
    // Walls: test the car's corners; on a hit, back out and bleed speed. The tested
    // footprint is deliberately narrower than the drawn body — the standard top-down
    // courtesy that lets a car squeeze past a parked car on a 56px street instead of
    // plugging the road forever.
    const hx = Math.cos(car.angle);
    const hy = Math.sin(car.angle);
    const sx = -hy;
    const sy = hx;
    const hl = CAR.length / 2 - 6;
    const hw = CAR.width / 2 - 9;
    let hit = false;
    for (const cx of [hl, -hl]) {
      for (const cy of [hw, -hw]) {
        if (circleHitsSolid(city, car.x + hx * cx + sx * cy, car.y + hy * cx + sy * cy, 4)) hit = true;
      }
    }
    if (hit) {
      const impact = Math.abs(car.speed);
      car.x = px;
      car.y = py;
      if (impact > 130) {
        sparks(car.x + hx * hl, car.y + hy * hl, 10);
        car.health -= (impact - 120) / 9;
        state.shake = Math.min(state.shake + impact / 90, 6);
        if (car.driver === 'player') hurtPlayer(Math.max(0, (impact - 240) / 14));
      }
      car.speed = -car.speed * 0.22;
      if (car.health <= 0 && !car.dead) {
        car.dead = true;
        smoke(car.x, car.y, 10);
      }
    }
    // Skid marks when the tyres are working hard — and only when the car actually travelled,
    // so a car grinding a wall cannot paint a stack of marks in one spot.
    car.skidTimer -= dt;
    const slipping = Math.abs(turn) > 0.028 && Math.abs(car.speed) > 160 || throttle < 0 && car.speed > 300;
    if (slipping && car.skidTimer <= 0 && dist2(car.x, car.y, car.skidX ?? -9999, car.skidY ?? -9999) > 12 * 12) {
      car.skidTimer = 0.03;
      car.skidX = car.x;
      car.skidY = car.y;
      state.skids.push({
        x1: car.x - hx * hl + sx * hw, y1: car.y - hy * hl + sy * hw,
        x2: car.x - hx * hl - sx * hw, y2: car.y - hy * hl - sy * hw, life: 7,
      });
      if (state.skids.length > 500) state.skids.shift();
    }
  }

  function collideCars(dt) {
    const cars = state.cars;
    for (let a = 0; a < cars.length; a += 1) {
      const A = cars[a];
      for (let b = a + 1; b < cars.length; b += 1) {
        const B = cars[b];
        const rr = CAR.radius * 1.7;
        if (Math.abs(A.x - B.x) > rr || Math.abs(A.y - B.y) > rr) continue;
        const d2 = dist2(A.x, A.y, B.x, B.y);
        if (d2 > rr * rr || d2 < 0.01) continue;
        const d = Math.sqrt(d2);
        const nx = (B.x - A.x) / d;
        const ny = (B.y - A.y) / d;
        // Near-parallel pairs (two cars passing in adjacent lanes, 28px apart on a 44px
        // contact circle) get a gentler shove: they are brushing past, not colliding, and a
        // full-strength push shoves both into the buildings over a whole passing length.
        const dot = Math.cos(A.angle) * Math.cos(B.angle) + Math.sin(A.angle) * Math.sin(B.angle);
        const push = (rr - d) / 2 * (Math.abs(dot) > 0.6 ? 0.35 : 1);
        const aStatic = A.driver === 'parked';
        const bStatic = B.driver === 'parked';
        if (!aStatic) { A.x -= nx * push; A.y -= ny * push; }
        if (!bStatic) { B.x += nx * push; B.y += ny * push; }
        // Damage is charged on the closing speed along the contact normal — the real
        // velocity vectors, so two cars cruising abreast are not "crashing" — and only once
        // per impact: a pair that stays in contact while grinding past each other takes the
        // hit a single time, not once per step until both are wrecked.
        const avx = Math.cos(A.angle) * A.speed;
        const avy = Math.sin(A.angle) * A.speed;
        const bvx = Math.cos(B.angle) * B.speed;
        const bvy = Math.sin(B.angle) * B.speed;
        const closing = (avx - bvx) * nx + (avy - bvy) * ny;
        if (closing > 60 && state.time - (A.lastHit || -9) > 0.6 && state.time - (B.lastHit || -9) > 0.6) {
          A.lastHit = state.time;
          B.lastHit = state.time;
          const swap = (A.speed + B.speed) / 2;
          if (!aStatic) A.speed = swap * 0.7;
          if (!bStatic) B.speed = swap * 0.7;
          sparks((A.x + B.x) / 2, (A.y + B.y) / 2, closing > 200 ? 12 : 5);
          A.health -= closing / 10;
          B.health -= closing / 10;
          if (A.health <= 0) A.dead = true;
          if (B.health <= 0) B.dead = true;
          const playerInvolved = A.driver === 'player' || B.driver === 'player';
          if (playerInvolved && closing > 150) {
            hurtPlayer((closing - 150) / 16);
            const other = A.driver === 'player' ? B : A;
            if (other.driver === 'police') reportCrime('hitPolice', player.x, player.y);
            else reportCrime('hitCar', player.x, player.y);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- traffic AI
  function trafficDrive(car, dt) {
    if (car.dead) { car.speed = 0; return; }
    // Obstacle scan ahead: any car or the player on foot in the next stretch of lane.
    let obstacle = Infinity;
    let obstacleSpeed = 999;
    const hx = Math.cos(car.angle);
    const hy = Math.sin(car.angle);
    for (const other of state.cars) {
      if (other === car) continue;
      const rx = other.x - car.x;
      const ry = other.y - car.y;
      const ahead = rx * hx + ry * hy;
      const side = Math.abs(rx * -hy + ry * hx);
      if (ahead > 0 && ahead < obstacle && side < 30) { obstacle = ahead; obstacleSpeed = Math.abs(other.speed); }
    }
    if (!player.car) {
      const rx = player.x - car.x;
      const ry = player.y - car.y;
      const ahead = rx * hx + ry * hy;
      const side = Math.abs(rx * -hy + ry * hx);
      if (ahead > 0 && ahead < obstacle && side < 26) { obstacle = ahead; obstacleSpeed = 999; }
    }
    // Blocked by a car that is itself standing (a parked car in the lane, a dead queue)?
    // Creep around it through the other lane — the scan still sets the pace, so the creep
    // pauses for oncoming traffic instead of meeting it head-on.
    if (obstacle < 62 && obstacleSpeed < 15) car.creepT = (car.creepT || 0) + dt;
    else car.creepT = 0;
    if (car.creepT > 1.1) { car.overtake = 1.3; car.creepT = 0; }
    // Nose-to-nose with another stopped car for a while? Back out and re-approach, like the
    // police do — otherwise two cars meeting in a lane deadlock the street forever.
    if (car.unstick > 0) {
      car.unstick -= dt;
      driveCar(car, dt, -1, car.unstickSteer || 1);
      return;
    }
    if (Math.abs(car.speed) < 10 && obstacle < 52) {
      car.stuckT = (car.stuckT || 0) + dt;
      if (car.stuckT > 1.4) {
        car.stuckT = 0;
        car.unstick = 0.5;
        car.unstickSteer = random() < 0.5 ? -1 : 1;
      }
    } else {
      car.stuckT = 0;
    }
    let target = car.cruise;
    if (obstacle < 74) target = 0;
    else if (obstacle < 130) target = car.cruise * 0.45;
    if (car.overtake > 0 && target > car.cruise * 0.5) target = car.cruise * 0.5;
    const throttle = car.speed < target ? 0.75 : -0.4;
    let tp = { x: car.tx, y: car.ty };
    if (car.overtake > 0) {
      car.overtake -= dt;
      if (car.dy !== 0) tp = { x: car.x - Math.sign(car.x - roadX(car.ii)) * 30, y: car.y + car.dy * 130 };
      else tp = { x: car.x + car.dx * 130, y: car.y - Math.sign(car.y - roadY(car.jj)) * 30 };
    }
    const want = Math.atan2(tp.y - car.y, tp.x - car.x);
    const steer = clamp(angleWrap(want - car.angle) * 2.2, -1, 1);
    driveCar(car, dt, throttle, steer);
    if (dist2(car.x, car.y, tp.x, tp.y) < 42 * 42) {
      // At the intersection: pick the next leg (mostly straight on).
      const options = [];
      const dirs = [[0, -1], [0, 1], [1, 0], [-1, 0]];
      for (const [dx, dy] of dirs) {
        if (dx === -car.dx && dy === -car.dy && random() > 0.06) continue; // no U-turns
        const ni = car.ii + car.dx + dx;
        const nj = car.jj + car.dy + dy;
        if (ni < 0 || ni > GRID.cols || nj < 0 || nj >= GRID.rows) continue;
        options.push({ dx, dy, straight: dx === car.dx && dy === car.dy });
      }
      if (options.length === 0) {
        car.dx = -car.dx; car.dy = -car.dy;
      } else {
        const straight = options.find((o) => o.straight);
        const pick = straight && random() < 0.62 ? straight : options[Math.floor(random() * options.length)];
        car.ii += car.dx;
        car.jj += car.dy;
        car.dx = pick.dx;
        car.dy = pick.dy;
      }
      const t = lanePoint(car.ii + car.dx, car.jj + car.dy, car.dx, car.dy);
      car.tx = t.x;
      car.ty = t.y;
    }
  }

  // ---------------------------------------------------------------- police AI
  function policeDrive(car, dt) {
    if (car.dead) { car.speed = 0; return; }
    const w = state.wanted;
    const seesPlayer = w.seen;
    const tx = seesPlayer ? player.x : (w.lastX ?? player.x);
    const ty = seesPlayer ? player.y : (w.lastY ?? player.y);
    const d = Math.sqrt(dist2(car.x, car.y, tx, ty));
    // Officers bail out to make the arrest when close to a player on foot.
    if (!player.car && d < 120 && w.stars >= 1 && !car.officer) {
      const off = makePed(car.x + 20, car.y + 10, 'officer');
      off.car = car;
      off.state = 'approach';
      car.officer = off;
      car.driver = 'policeParked';
      state.peds.push(off);
      car.speed = 0;
      return;
    }
    if (car.driver === 'policeParked') { car.speed = 0; return; }
    // Wedged on a wall or a wreck? Back out and try the angle again.
    if (car.unstick > 0) {
      car.unstick -= dt;
      driveCar(car, dt, -1, car.unstickSteer || 1);
      return;
    }
    if (Math.abs(car.speed) < 14 && d > 90) {
      car.stuckT = (car.stuckT || 0) + dt;
      if (car.stuckT > 0.7) {
        car.stuckT = 0;
        car.unstick = 0.55;
        car.unstickSteer = random() < 0.5 ? -1 : 1;
      }
    } else {
      car.stuckT = 0;
    }
    let target = 1;
    if (d < 60) target = 0.25;
    const want = Math.atan2(ty - car.y, tx - car.x);
    const steer = clamp(angleWrap(want - car.angle) * 2.4, -1, 1);
    driveCar(car, dt, target, steer);
    if (d < 700 && random() < dt * 0.5) events |= EV_SIREN;
  }

  function officerUpdate(ped, dt) {
    const car = ped.car;
    if (car && car.driver === 'player') {
      // His car was stolen from under him: he gives up and walks off.
      if (car.officer === ped) car.officer = null;
      ped.car = null;
      ped.state = 'leave';
    }
    if (ped.state === 'leave') {
      ped.x += Math.cos(ped.angle) * 40 * dt;
      ped.downT += dt;
      return ped.downT < 3; // keep while leaving, then drop
    }
    if (player.car && car) {
      // The player drove off: get back in and give chase.
      if (dist2(ped.x, ped.y, car.x, car.y) < 30 * 30) {
        car.driver = 'police';
        car.officer = null;
        return false;
      }
      ped.angle = Math.atan2(car.y - ped.y, car.x - ped.x);
      ped.x += Math.cos(ped.angle) * OFFICER.speed * dt;
      ped.y += Math.sin(ped.angle) * OFFICER.speed * dt;
      return true;
    }
    const d = Math.sqrt(dist2(ped.x, ped.y, player.x, player.y));
    const want = Math.atan2(player.y - ped.y, player.x - ped.x);
    ped.angle = want;
    if (d > 150) {
      ped.x += Math.cos(want) * OFFICER.speed * dt;
      ped.y += Math.sin(want) * OFFICER.speed * dt;
    } else if (d < 90) {
      ped.x -= Math.cos(want) * OFFICER.speed * 0.5 * dt;
      ped.y -= Math.sin(want) * OFFICER.speed * 0.5 * dt;
    }
    resolveCircle(city, ped, 10);
    ped.shootCd -= dt;
    if (state.wanted.stars >= 3 && ped.shootCd <= 0 && d < OFFICER.range && !state.over) {
      ped.shootCd = OFFICER.cooldown * (0.8 + random() * 0.5);
      tracer(ped.x, ped.y - 6, player.x + (random() - 0.5) * 30, player.y + (random() - 0.5) * 30, '#ffd0a0');
      events |= EV_OSHOT;
      const moving = player.car ? Math.abs(player.car.speed) > 200 : false;
      const hitChance = clamp(0.72 - d / 700 - (moving ? 0.18 : 0), 0.12, 0.8);
      if (random() < hitChance) hurtPlayer(OFFICER.damage);
    }
    return true;
  }

  // ---------------------------------------------------------------- pedestrians
  function pedUpdate(ped, dt) {
    if (ped.kind === 'officer') return officerUpdate(ped, dt);
    if (ped.state === 'down') {
      ped.downT -= dt;
      return ped.downT > 0;
    }
    if (ped.state === 'passenger') return true; // hidden inside the taxi
    if (ped.state === 'toCar') {
      const car = player.car;
      if (!car) { ped.state = 'walk'; return true; }
      const d = Math.sqrt(dist2(ped.x, ped.y, car.x, car.y));
      ped.angle = Math.atan2(car.y - ped.y, car.x - ped.x);
      ped.x += Math.cos(ped.angle) * 150 * dt;
      ped.y += Math.sin(ped.angle) * 150 * dt;
      if (d < 26) {
        ped.state = 'passenger';
        state.taxi.phase = 'dropoff';
        const dest = taxiDestination();
        state.taxi.dest = dest;
        banner('TAXI FARE', 'Drive your passenger to the gold marker.');
      }
      return true;
    }
    if (ped.state === 'flee') {
      ped.fleeT -= dt;
      const away = Math.atan2(ped.y - ped.threatY, ped.x - ped.threatX);
      ped.angle = away;
      ped.x += Math.cos(away) * PEDS.fleeSpeed * dt;
      ped.y += Math.sin(away) * PEDS.fleeSpeed * dt;
      ped.x = clamp(ped.x, 16, WATER_X - 8);
      ped.y = clamp(ped.y, 16, WORLD_H - 16);
      resolveCircle(city, ped, 9);
      if (ped.fleeT <= 0) {
        const ring = nearestRing(ped.x, ped.y);
        ped.bi = ring.i; ped.bj = ring.j; ped.perim = ring.perim;
        ped.state = 'walk';
      }
      return true;
    }
    // Strolling the sidewalk ring of one block.
    ped.perim += ped.dir * ped.speed * dt;
    const p = ringPos(ped.bi, ped.bj, ped.perim);
    ped.angle = Math.atan2(p.y - ped.y, p.x - ped.x);
    ped.x = p.x;
    ped.y = p.y;
    ped.walkCycle += dt * 7;
    // A nearby fast car or a gunshot spooks them.
    return true;
  }

  function scarePeds(x, y, r) {
    for (const p of state.peds) {
      if (p.kind !== 'walker' || p.state !== 'walk') continue;
      if (dist2(x, y, p.x, p.y) < r * r) {
        p.state = 'flee';
        p.fleeT = 1.6 + random() * 1.4;
        p.threatX = x;
        p.threatY = y;
      }
    }
  }

  // ---------------------------------------------------------------- taxi
  function taxiDestination() {
    for (let tries = 0; tries < 10; tries += 1) {
      const ii = Math.floor(random() * (GRID.cols + 1));
      const jj = Math.floor(random() * GRID.rows);
      const x = roadX(ii);
      const y = roadY(jj);
      const d = Math.sqrt(dist2(x, y, player.x, player.y));
      if (d > 650 && d < 2100) return { x, y };
    }
    return { x: roadX(2), y: roadY(2) };
  }
  function taxiUpdate(dt) {
    const t = state.taxi;
    t.hailTimer -= dt;
    if (t.phase === 'none' && t.hailTimer <= 0) {
      t.hailTimer = 9 + random() * 8;
      // A walker near the player raises a hand and becomes the fare.
      let bestPed = null;
      let bestD = 420 * 420;
      for (const p of state.peds) {
        if (p.kind !== 'walker' || p.state !== 'walk') continue;
        const d = dist2(p.x, p.y, player.x, player.y);
        if (d < bestD) { bestD = d; bestPed = p; }
      }
      if (bestPed) {
        bestPed.state = 'hail';
        t.ped = bestPed;
        t.phase = 'pickup';
      }
    }
    if (t.phase === 'pickup' && t.ped) {
      const ped = t.ped;
      if (ped.state !== 'hail') { t.phase = 'none'; t.ped = null; return; }
      if (player.car && Math.abs(player.car.speed) < 12 && dist2(ped.x, ped.y, player.x, player.y) < 52 * 52) {
        ped.state = 'toCar';
        t.dist = 0;
        t.dirty = false;
      }
    }
    if (t.phase === 'dropoff' && t.dest) {
      if (!player.car) {
        // Fare abandoned: the passenger climbs out wherever that was.
        if (t.ped) {
          t.ped.state = 'walk';
          const ring = nearestRing(t.ped.x, t.ped.y);
          t.ped.bi = ring.i; t.ped.bj = ring.j; t.ped.perim = ring.perim;
          t.ped.x = player.x + 24; t.ped.y = player.y;
        }
        t.phase = 'none'; t.ped = null; t.dest = null;
        banner('FARE LOST', 'The passenger bailed. No tip, obviously.');
        return;
      }
      t.dist += Math.abs(player.car.speed) * dt;
      if (dist2(player.x, player.y, t.dest.x, t.dest.y) < 62 * 62 && Math.abs(player.car.speed) < 30) {
        const fare = Math.round(TAXI.baseFare + t.dist * TAXI.perPixel * (t.dirty ? 1 : 1 + TAXI.speedBonus * 0.4));
        pay(fare);
        sparkle(player.x, player.y);
        banner('FARE PAID', `+$${fare}${t.dirty ? '' : ' — clean and quick, bonus in'}`);
        state.stats.fares += 1;
        if (t.ped) {
          t.ped.state = 'walk';
          t.ped.x = player.x + 26;
          t.ped.y = player.y + 10;
          const ring = nearestRing(t.ped.x, t.ped.y);
          t.ped.bi = ring.i; t.ped.bj = ring.j; t.ped.perim = ring.perim;
        }
        t.phase = 'none'; t.ped = null; t.dest = null;
        t.hailTimer = 12;
      }
    }
  }

  // ---------------------------------------------------------------- player
  function enterExitCar() {
    if (player.car) {
      const car = player.car;
      car.driver = car.kind === 'police' ? 'policeParked' : 'parked';
      if (car.officer) car.driver = 'policeParked';
      player.car = null;
      player.x = car.x + Math.cos(car.angle + Math.PI / 2) * 30;
      player.y = car.y + Math.sin(car.angle + Math.PI / 2) * 30;
      resolveCircle(city, player, PLAYER.radius);
      events |= EV_ENTER;
      return;
    }
    let bestCar = null;
    let bestD = 52 * 52;
    for (const car of state.cars) {
      if (car.dead) continue;
      const d = dist2(player.x, player.y, car.x, car.y);
      if (d < bestD) { bestD = d; bestCar = car; }
    }
    if (!bestCar) return;
    if (bestCar.officer) {
      // Stealing a patrol car from under its officer: he is left standing.
      bestCar.officer.state = 'leave';
      bestCar.officer.car = null;
      bestCar.officer = null;
    }
    const wasTraffic = bestCar.driver === 'traffic';
    bestCar.driver = 'player';
    bestCar.speed = wasTraffic ? bestCar.speed * 0.4 : bestCar.speed;
    player.car = bestCar;
    player.x = bestCar.x;
    player.y = bestCar.y;
    state.stats.stolen += 1;
    // The radio comes on with the ignition: the HUD shows the station for a few seconds.
    state.radio = RADIO_STATIONS[Math.floor(random() * RADIO_STATIONS.length)];
    state.radioUntil = state.time + 3.6;
    events |= EV_ENTER;
    reportCrime('theft', player.x, player.y);
    scarePeds(player.x, player.y, 90);
  }

  function playerShoot(input) {
    player.fireCd -= STEP;
    if (!input.fire || player.car || player.fireCd > 0 || state.over) return;
    player.fireCd = GUN.cooldown;
    state.stats.shots += 1;
    events |= EV_SHOT;
    state.shake = Math.min(state.shake + 1.4, 4);
    const a = input.aimAngle + (random() - 0.5) * 2 * GUN.spread;
    const mx = player.x + Math.cos(a) * 16;
    const my = player.y + Math.sin(a) * 16;
    spawnParticle(mx, my, Math.cos(a) * 60, Math.sin(a) * 60, 0.06, 5, '#ffe9a0');
    // Hitscan in small steps: first officer, ped or car along the ray wins.
    let hitX = player.x + Math.cos(a) * GUN.range;
    let hitY = player.y + Math.sin(a) * GUN.range;
    for (let d = 14; d < GUN.range; d += 7) {
      const x = player.x + Math.cos(a) * d;
      const y = player.y + Math.sin(a) * d;
      if (circleHitsSolid(city, x, y, 3)) { hitX = x; hitY = y; break; }
      let done = false;
      for (const p of state.peds) {
        if (p.state === 'down' || p.state === 'passenger') continue;
        if (dist2(x, y, p.x, p.y) < 12 * 12) {
          hitX = x; hitY = y; done = true;
          if (p.kind === 'officer') {
            p.health -= GUN.damage;
            sparks(x, y, 4);
            if (p.health <= 0) {
              p.state = 'down';
              p.downT = 6;
              if (p.car) { p.car.officer = null; }
              reportCrime('killOfficer', player.x, player.y);
            }
          } else {
            p.state = 'down';
            p.downT = 5;
            state.stats.pedsDown += 1;
            reportCrime('pedDown', player.x, player.y);
          }
          break;
        }
      }
      if (done) break;
      for (const car of state.cars) {
        if (dist2(x, y, car.x, car.y) < CAR.radius * CAR.radius) {
          hitX = x; hitY = y; done = true;
          car.health -= GUN.damage / 3;
          sparks(x, y, 5);
          if (car.health <= 0 && !car.dead) { car.dead = true; smoke(car.x, car.y, 8); }
          break;
        }
      }
      if (done) break;
    }
    tracer(mx, my, hitX, hitY, '#ffe9a0');
    reportCrime('gunfire', player.x, player.y);
    scarePeds(player.x, player.y, 300);
  }

  function playerUpdate(dt, input) {
    if (player.grace > 0) player.grace -= dt;
    if (input.enterPressed) enterExitCar();
    if (player.car) {
      const car = player.car;
      if (car.dead) {
        car.speed = 0;
      } else {
        driveCar(car, dt, input.throttle, input.steer);
        if (Math.abs(car.speed) > 320) scarePeds(car.x, car.y, 110);
      }
      player.x = car.x;
      player.y = car.y;
      player.angle = car.angle;
      // Running a pedestrian down.
      for (const p of state.peds) {
        if (p.kind !== 'walker' || p.state === 'down' || p.state === 'passenger' || p.state === 'hail' || p.state === 'toCar') continue;
        if (dist2(p.x, p.y, car.x, car.y) < (CAR.radius + 8) * (CAR.radius + 8)) {
          if (Math.abs(car.speed) > 95) {
            p.state = 'down';
            p.downT = 5;
            state.stats.pedsDown += 1;
            reportCrime('pedDown', p.x, p.y);
            sparks(p.x, p.y, 3);
            car.speed *= 0.92;
          } else {
            p.state = 'flee';
            p.fleeT = 1.2;
            p.threatX = car.x;
            p.threatY = car.y;
          }
        }
      }
      // Respray: drive in unseen with the fee in your pocket and the heat washes off.
      const bay = city.respray.bay;
      const inBay = player.x > bay.x && player.x < bay.x + bay.w && player.y > bay.y && player.y < bay.y + bay.h;
      if (inBay && state.resprayArmed && state.wanted.stars > 0 && !state.wanted.seen && state.cash >= ECONOMY.resprayFee) {
        state.cash -= ECONOMY.resprayFee;
        clearWanted();
        player.car.color = ['#c0392b', '#2471a3', '#229954', '#7d3c98', '#616a6b', '#d5d8dc'][Math.floor(random() * 6)];
        state.resprayArmed = false;
        banner('RESPRAYED', `-$${ECONOMY.resprayFee}. New paint, no heat.`);
        sparkle(player.x, player.y);
      }
      if (!inBay) state.resprayArmed = true;
    } else {
      const mx = input.mx;
      const my = input.my;
      const mag = Math.hypot(mx, my);
      if (mag > 0.01) {
        const speed = input.run ? PLAYER.runSpeed : PLAYER.walkSpeed;
        const nx = (mx / Math.max(1, mag)) * speed;
        const ny = (my / Math.max(1, mag)) * speed;
        player.x += nx * dt;
        player.y += ny * dt;
        player.angle = Math.atan2(ny, nx);
        player.walkCycle += dt * (input.run ? 11 : 8);
      }
      player.x = clamp(player.x, 14, WATER_X - 12);
      player.y = clamp(player.y, 14, WORLD_H - 14);
      resolveCircle(city, player, PLAYER.radius);
      // Traffic can hurt a pedestrian player.
      for (const car of state.cars) {
        if (car.driver === 'parked' || car.driver === 'player' || car.dead) continue;
        if (Math.abs(car.speed) > 130 && dist2(player.x, player.y, car.x, car.y) < (CAR.radius + 6) * (CAR.radius + 6)) {
          hurtPlayer(16);
          player.x += Math.cos(car.angle) * 22;
          player.y += Math.sin(car.angle) * 22;
          resolveCircle(city, player, PLAYER.radius);
        }
      }
    }
    playerShoot(input);
  }

  // ---------------------------------------------------------------- wanted upkeep
  function wantedUpdate(dt) {
    const w = state.wanted;
    // Who can see the player right now?
    let seen = false;
    for (const c of state.cars) {
      if ((c.driver === 'police' || c.driver === 'policeParked') && dist2(c.x, c.y, player.x, player.y) < 620 * 620) seen = true;
    }
    for (const p of state.peds) {
      if (p.kind === 'officer' && p.state !== 'down' && dist2(p.x, p.y, player.x, player.y) < 480 * 480) seen = true;
    }
    w.seen = seen;
    if (seen) {
      w.lastX = player.x;
      w.lastY = player.y;
      w.unseenTime = 0;
    } else {
      w.unseenTime += dt;
    }
    if (w.holdTimer > 0) w.holdTimer -= dt;
    if (!seen && w.holdTimer <= 0 && w.heat > 0) {
      w.heat = Math.max(0, w.heat - WANTED.decayPerSecond * dt * (w.unseenTime > 6 ? 2.2 : 1));
      w.stars = w.heat <= 0 ? 0 : Math.min(WANTED.maxStars, Math.ceil(w.heat / WANTED.perStar));
    }
    // Field the right number of police cars.
    const want = WANTED.policeCars[w.stars] || 0;
    let have = 0;
    for (const c of state.cars) if (c.driver === 'police' || c.driver === 'policeParked') have += 1;
    if (have < want) spawnPoliceCar();
    if (w.stars === 0) {
      // No heat: police give up and leave the world.
      for (let i = state.cars.length - 1; i >= 0; i -= 1) {
        const c = state.cars[i];
        if (c.driver === 'police' || c.driver === 'policeParked') state.cars.splice(i, 1);
      }
      for (let i = state.peds.length - 1; i >= 0; i -= 1) {
        if (state.peds[i].kind === 'officer') state.peds.splice(i, 1);
      }
    }
    // The bust meter: close police + a slow player = handcuffs.
    const speed = player.car ? Math.abs(player.car.speed) : 0;
    let near = false;
    if (w.stars > 0) {
      for (const c of state.cars) {
        if ((c.driver === 'police' || c.driver === 'policeParked') && dist2(c.x, c.y, player.x, player.y) < WANTED.bustRadius * WANTED.bustRadius) near = true;
      }
      for (const p of state.peds) {
        if (p.kind === 'officer' && p.state !== 'down' && dist2(p.x, p.y, player.x, player.y) < WANTED.bustRadius * WANTED.bustRadius) near = true;
      }
    }
    if (near && speed < 42 && !state.over) {
      w.bust += dt / WANTED.bustFillSeconds;
      if (w.bust >= 1) {
        w.bust = 0;
        state.over = 'busted';
        events |= EV_BUSTED;
      }
    } else {
      w.bust = Math.max(0, w.bust - dt * 1.4);
    }
  }

  // ---------------------------------------------------------------- pickups upkeep
  function pickupsUpdate(dt) {
    for (const pk of state.pickups) {
      if (!pk.active) {
        pk.respawn -= dt;
        if (pk.respawn <= 0) pk.active = true;
        continue;
      }
      if (dist2(pk.x, pk.y, player.x, player.y) < 30 * 30) {
        if (pk.kind === 'health' && player.health < PLAYER.health) {
          player.health = Math.min(PLAYER.health, player.health + 50);
        } else if (pk.kind === 'armor' && player.armor < PLAYER.armor) {
          player.armor = PLAYER.armor;
        } else {
          continue;
        }
        pk.active = false;
        pk.respawn = 24;
        sparkle(pk.x, pk.y);
        events |= EV_PICKUP;
        banner(pk.kind === 'health' ? 'PATCHED UP' : 'ARMOUR ON', pk.kind === 'health' ? '+50 health' : 'Armour at full');
      }
    }
  }

  // ---------------------------------------------------------------- population upkeep
  function populationUpdate(dt) {
    // Traffic far away is recycled near the player; the city never empties or clogs.
    let traffic = 0;
    for (let i = state.cars.length - 1; i >= 0; i -= 1) {
      const c = state.cars[i];
      if (c.driver !== 'traffic') continue;
      traffic += 1;
      if (dist2(c.x, c.y, player.x, player.y) > 1350 * 1350) {
        state.cars.splice(i, 1);
        traffic -= 1;
      }
    }
    if (traffic < TRAFFIC.count && random() < dt * 2) spawnTrafficCar(player.x, player.y, true);
    let walkers = 0;
    for (const p of state.peds) if (p.kind === 'walker') walkers += 1;
    if (walkers < PEDS.count && random() < dt * 2) {
      const ped = spawnPed();
      // Keep fresh spawns out of the player's face.
      if (dist2(ped.x, ped.y, player.x, player.y) < 200 * 200) {
        ped.bi = (ped.bi + 5) % GRID.cols;
        const p2 = ringPos(ped.bi, ped.bj, ped.perim);
        ped.x = p2.x; ped.y = p2.y;
      }
    }
    // Wrecked civilian cars are towed away after a while.
    for (let i = state.cars.length - 1; i >= 0; i -= 1) {
      const c = state.cars[i];
      if (c.dead && c.driver !== 'player' && c.tag !== 'mission' && dist2(c.x, c.y, player.x, player.y) > 900 * 900) {
        state.cars.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- the step
  function step(dt, input) {
    events = 0;
    if (state.over) return events;
    state.time += dt;
    // The clock: one game hour every CLOCK.secondsPerHour seconds.
    state.clock.hour += dt / CLOCK.secondsPerHour;
    if (state.clock.hour >= 24) {
      state.clock.hour -= 24;
      state.clock.day += 1;
    }
    if (state.banner.t > 0) state.banner.t -= dt;
    if (state.shake > 0) {
      state.shake = Math.max(0, state.shake - dt * 9);
      state.shakeX = (random() - 0.5) * 2 * state.shake;
      state.shakeY = (random() - 0.5) * 2 * state.shake;
    } else {
      state.shakeX = 0;
      state.shakeY = 0;
    }

    playerUpdate(dt, input);
    for (const car of state.cars) {
      if (car.driver === 'traffic') trafficDrive(car, dt);
      else if (car.driver === 'police') policeDrive(car, dt);
    }
    collideCars(dt);
    for (let i = state.peds.length - 1; i >= 0; i -= 1) {
      if (!pedUpdate(state.peds[i], dt)) state.peds.splice(i, 1);
    }
    wantedUpdate(dt);
    storyCtl.update(dt);
    taxiUpdate(dt);
    pickupsUpdate(dt);
    populationUpdate(dt);

    // Smoke from wrecks, and all particles forward.
    for (const car of state.cars) {
      if (car.dead && random() < dt * 6) smoke(car.x, car.y, 1);
    }
    for (let i = state.particles.length - 1; i >= 0; i -= 1) {
      const p = state.particles[i];
      p.life -= dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      if (p.drag) { p.vx -= p.vx * p.drag * dt; p.vy -= p.vy * p.drag * dt; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = state.tracers.length - 1; i >= 0; i -= 1) {
      state.tracers[i].life -= dt;
      if (state.tracers[i].life <= 0) state.tracers.splice(i, 1);
    }
    for (let i = state.skids.length - 1; i >= 0; i -= 1) {
      state.skids[i].life -= dt;
      if (state.skids[i].life <= 0) state.skids.splice(i, 1);
    }
    state.district = districtAt(player.x, player.y);
    return events;
  }

  // ---------------------------------------------------------------- save data
  function serialize() {
    return {
      cash: state.cash,
      storyIndex: storyCtl.story.index,
      storyComplete: storyCtl.story.complete,
      x: Math.round(player.x),
      y: Math.round(player.y),
      stats: { ...state.stats },
      day: state.clock.day,
      hour: Math.round(state.clock.hour * 100) / 100,
    };
  }
  function restore(data) {
    reset();
    state.cash = data.cash | 0;
    storyCtl.story.index = clamp(data.storyIndex | 0, 0, 5);
    storyCtl.story.complete = !!data.storyComplete;
    if (Number.isFinite(data.x) && Number.isFinite(data.y)) {
      player.x = clamp(data.x, 20, WORLD_W - 20);
      player.y = clamp(data.y, 20, WORLD_H - 20);
      resolveCircle(city, player, PLAYER.radius);
    }
    if (data.stats) Object.assign(state.stats, data.stats);
    if (data.day) state.clock.day = data.day;
    if (data.hour) state.clock.hour = data.hour;
  }

  reset();
  return {
    state, step, reset, respawnBusted, respawnWasted, serialize, restore, spawnSpecialCar,
    startMission: (i) => storyCtl.start(i),
    story: storyCtl.story,
    MISSIONS: storyCtl.MISSIONS,
  };
}
