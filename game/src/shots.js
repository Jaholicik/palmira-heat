// The screenshot scenes behind ?shot=start|play|chase|end. Each one plays the real simulation
// forward from a fresh world, steered by simple autopilots: Rio walks the road grid to a car,
// steals it through the real enter-car mechanic, commits his crimes through the real firing
// and collision mechanics (that is what raises the stars the chase scene needs), and the end
// scene stands him next to the police until the real bust meter fills. Same seed, same frame.
import { GRID, PITCH, STEP } from './config.js';
import { BEACH_ROAD_X, LANE, circleHitsSolid, roadX, roadY } from './city.js';
import { SCREEN_BUSTED, SCREEN_PLAY, SCREEN_TITLE } from './render.js';

function blankInput() {
  return { mx: 0, my: 0, run: false, throttle: 0, steer: 0, enterPressed: false, fire: false, aimAngle: 0 };
}
function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/** Waypoints along the road grid from where Rio stands to a target: road first, then across. */
function route(state, tx, ty) {
  const p = state.player;
  const i0 = Math.min(GRID.cols, Math.max(0, Math.round((p.x - GRID.road / 2) / PITCH)));
  const j1 = Math.min(GRID.rows - 1, Math.max(0, Math.round((ty - GRID.road / 2) / PITCH)));
  // Drive in the proper lane, like the traffic does (right-hand side for the direction of
  // travel): the centre line meets every oncoming car head-on, the lane only meets peers.
  const dy = Math.sign(roadY(j1) - p.y) || Math.sign(ty - p.y) || 1;
  const dx = Math.sign(tx - roadX(i0)) || 1;
  const laneX = roadX(i0) + (dy > 0 ? -LANE : LANE);
  const laneY = roadY(j1) + (dx > 0 ? LANE : -LANE);
  const pts = [
    { x: laneX, y: p.y },
    { x: laneX, y: laneY },
    { x: tx, y: laneY },
    { x: tx, y: ty },
  ];
  return pts.filter((pt, i) => i === 0 || dist(pt.x, pt.y, pts[i - 1].x, pts[i - 1].y) > 24);
}

function footInput(state, tx, ty) {
  const input = blankInput();
  const p = state.player;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy) || 1;
  input.mx = dx / d;
  input.my = dy / d;
  input.run = true;
  return input;
}

function driveInput(state, tx, ty, cap = 250, detourBend = 0) {
  const input = blankInput();
  const car = state.player.car;
  if (!car) return input;
  // Look ahead before committing to the line: if a car sits in the corridor, or a wall face
  // closes one side, bend the aim point around the blockage — that is what keeps the
  // autopilot out of the nose-to-nose wedges a centre-line driver ends up in.
  const hx = Math.cos(car.angle);
  const hy = Math.sin(car.angle);
  let bend = detourBend;
  if (bend === 0) {
    for (const other of state.cars) {
      if (other === car || other.dead) continue;
      const rx = other.x - car.x;
      const ry = other.y - car.y;
      const ahead = rx * hx + ry * hy;
      const side = rx * -hy + ry * hx;
      if (ahead > 6 && ahead < 96 && Math.abs(side) < 20) {
        bend = side >= 0 ? -30 : 30;
        break;
      }
    }
  }
  if (bend === 0) {
    const px = car.x + hx * 58;
    const py = car.y + hy * 58;
    const blockedPlus = circleHitsSolid(state.city, px - hy * 16, py + hx * 16, 6);
    const blockedMinus = circleHitsSolid(state.city, px + hy * 16, py - hx * 16, 6);
    if (blockedPlus && !blockedMinus) bend = -52;
    else if (blockedMinus && !blockedPlus) bend = 52;
  }
  const aimX = tx - hy * bend;
  const aimY = ty + hx * bend;
  const want = Math.atan2(aimY - car.y, aimX - car.x);
  const diff = wrap(want - car.angle);
  input.steer = Math.max(-1, Math.min(1, diff * 1.9));
  input.throttle = Math.abs(diff) > 1.0 ? 0.3 : 1;
  // Traffic sense, in three parts. A car crossing or coming the other way inside the
  // corridor: YIELD — brake before the intersection box instead of stopping inside it and
  // collecting T-bones. A MOVING car ahead in the same direction: QUEUE — match its pace
  // instead of pushing into its bumper. A stopped car is neither: it is an obstacle, and
  // the bend above steers around it.
  for (const other of state.cars) {
    if (other === car || other.dead || other.driver === 'parked') continue;
    const rx = other.x - car.x;
    const ry = other.y - car.y;
    const ahead = rx * hx + ry * hy;
    const side = rx * -hy + ry * hx;
    if (ahead <= 0 || ahead >= 80 || Math.abs(side) >= 22) continue;
    const dot = Math.cos(other.angle) * hx + Math.sin(other.angle) * hy;
    if (dot <= 0.5) {
      if (ahead < 58) input.throttle = -0.6;
    } else if (Math.abs(other.speed) > 25) {
      if (car.speed > Math.abs(other.speed) + 12) input.throttle = -0.5;
      else if (input.throttle > 0.2) input.throttle = 0.2;
    }
  }
  // The autopilot drives at traffic speed unless told otherwise: full-throttle staging runs
  // wreck the car on building corners and fail the very mission being photographed.
  if (car.speed > cap) input.throttle = 0;
  else if (car.speed > cap * 0.8 && input.throttle > 0) input.throttle = 0.35;
  if (dist(car.x, car.y, tx, ty) < 30 && Math.abs(car.speed) > 60) input.throttle = -0.6;
  return input;
}

/** Walk Rio along the grid route to (tx, ty); stops early when `done(state)` says so. */
function walkTo(world, tx, ty, maxSteps, done) {
  const state = world.state;
  let pts = route(state, tx, ty);
  let steps = 0;
  while (steps < maxSteps) {
    if (done && done(state)) return true;
    if (state.player.car) return true;
    while (pts.length && dist(state.player.x, state.player.y, pts[0].x, pts[0].y) < 22) pts.shift();
    const target = pts.length ? pts[0] : { x: tx, y: ty };
    world.step(STEP, footInput(state, target.x, target.y));
    steps += 1;
    if (dist(state.player.x, state.player.y, tx, ty) < 26) return true;
  }
  return dist(state.player.x, state.player.y, tx, ty) < 40;
}

/**
 * Drive toward a moving target for up to maxSteps. The autopilot's recovery skill, for the
 * wedges the look-ahead could not prevent: when the car sits nose-to-nose with something
 * (throttle on, speed nil) for three quarters of a second, it backs STRAIGHT out along its
 * entry line — swinging the wheel in reverse is what jams a car diagonally into a wall —
 * then re-approaches with its aim bent away from whatever blocked it.
 * `breakFn(state)` may end the drive early.
 */
function driveSteps(world, targetFn, maxSteps, cap, breakFn) {
  const state = world.state;
  let steps = 0;
  let stuck = 0;
  let reversing = 0;
  let detourBend = 0;
  let detourSteps = 0;
  while (steps < maxSteps && state.player.car && !state.over) {
    const car = state.player.car;
    if (reversing > 0) {
      reversing -= 1;
      const input = blankInput();
      input.throttle = -1;
      input.steer = 0;
      world.step(STEP, input);
    } else {
      const t = targetFn(state);
      const input = driveInput(state, t.x, t.y, cap, detourSteps > 0 ? detourBend : 0);
      if (detourSteps > 0) detourSteps -= 1;
      world.step(STEP, input);
      if (Math.abs(car.speed) < 14 && input.throttle > 0) {
        stuck += 1;
        if (stuck > 45) {
          stuck = 0;
          reversing = 40;
          // Bend the next approach away from the blocker, if a car is the blocker.
          detourBend = 34;
          const hx = Math.cos(car.angle);
          const hy = Math.sin(car.angle);
          for (const other of state.cars) {
            if (other === car || other.dead) continue;
            if (dist(car.x, car.y, other.x, other.y) > 70) continue;
            const side = (other.x - car.x) * -hy + (other.y - car.y) * hx;
            detourBend = side >= 0 ? -34 : 34;
            break;
          }
          detourSteps = 130;
        }
      } else stuck = 0;
    }
    steps += 1;
    if (breakFn && breakFn(state)) break;
  }
  return steps;
}

/** Drive along the grid route to (tx, ty) for up to maxSteps; returns when close or out of time. */
function driveTo(world, tx, ty, maxSteps, arriveRadius = 56, cap = 250) {
  const state = world.state;
  let pts = route(state, tx, ty);
  let arrived = false;
  driveSteps(world, (s) => {
    while (pts.length > 1 && dist(s.player.x, s.player.y, pts[0].x, pts[0].y) < 64) pts.shift();
    return pts.length ? pts[0] : { x: tx, y: ty };
  }, maxSteps, cap, (s) => {
    arrived = dist(s.player.x, s.player.y, tx, ty) < arriveRadius;
    return arrived;
  });
  return arrived;
}

function nearestCar(state, parkedOnly, quickOnly = false) {
  let best = null;
  let bestD = Infinity;
  for (const car of state.cars) {
    if (car.dead || car.driver === 'police' || car.driver === 'policeParked') continue;
    if (parkedOnly && car.driver !== 'parked') continue;
    if (quickOnly && (car.kind === 'van' || car.kind === 'truck')) continue;
    const d = dist(state.player.x, state.player.y, car.x, car.y);
    if (d < bestD) { bestD = d; best = car; }
  }
  return best;
}

function pressEnter(world) {
  const input = blankInput();
  input.enterPressed = true;
  world.step(STEP, input);
}

/** Walk to the nearest parked car and steal it. Returns the car, or null. */
function stealNearestCar(world, quickOnly = false, walkBudget = 1500) {
  const state = world.state;
  const car = nearestCar(state, true, quickOnly) || nearestCar(state, false, quickOnly);
  if (!car) return null;
  walkTo(world, car.x, car.y, walkBudget, (s) => dist(s.player.x, s.player.y, car.x, car.y) < 30);
  if (dist(state.player.x, state.player.y, car.x, car.y) < 52 && !state.player.car) pressEnter(world);
  return state.player.car;
}

function stageStart(world) {
  world.reset();
  const state = world.state;
  state.clock.hour = 17.55; // golden hour over the beachfront
  // Ambient city only: traffic rolls, people stroll, Rio watches the avenue.
  for (let i = 0; i < 6 / STEP; i += 1) world.step(STEP, blankInput());
  return { screen: SCREEN_TITLE };
}

function stagePlay(world) {
  world.reset();
  const state = world.state;
  state.taxi.hailTimer = 99999; // no side fares competing with the story in the portrait
  world.startMission(0);
  const target = state.story.targetCar;
  // On foot to the Comet, through the real streets; steal it; drive the delivery leg.
  if (target) {
    walkTo(world, target.x, target.y, 1700, (s) => dist(s.player.x, s.player.y, target.x, target.y) < 30);
    if (!state.player.car && dist(state.player.x, state.player.y, target.x, target.y) < 52) pressEnter(world);
  }
  if (state.player.car) {
    const bay = state.city.respray.bay;
    // Drive the delivery route at traffic speed — but take the portrait mid-leg, once Rio
    // has real speed on the clock and the city is streaming past: that is the frame. If a
    // jam stops him first, the route simply runs its course and the portrait is the jam.
    let pts = route(state, bay.x + bay.w / 2, roadY(5));
    const startX = state.player.x;
    const startY = state.player.y;
    driveSteps(world, (s) => {
      while (pts.length > 1 && dist(s.player.x, s.player.y, pts[0].x, pts[0].y) < 64) pts.shift();
      return pts.length ? pts[0] : { x: bay.x + bay.w / 2, y: roadY(5) };
    }, 2400, 235, (s) => s.player.car
      && Math.abs(s.player.car.speed) > 70
      && dist(s.player.x, s.player.y, startX, startY) > 400);
  }
  return { screen: SCREEN_PLAY };
}

function stageChase(world) {
  world.reset();
  const state = world.state;
  state.taxi.hailTimer = 99999;
  state.clock.hour = 15.2;
  // The getaway car is staged on the beachfront avenue itself — a red sport coupe at the
  // east curb, facing south — so the whole scene plays out on one known, open road. Rio
  // walks down the avenue to it while the streets are calm, stands on its seaward side, and
  // makes his noise over the water: shots fired one at a time, heat checked after each
  // (+60 witnessed, +18 not), stopping past 100. The theft report (+105 witnessed) lands on
  // top and the total sits in the three-star band (201-300) just as the law starts to roll.
  const getaway = world.spawnSpecialCar(BEACH_ROAD_X + 17, roadY(3) + 30, Math.PI / 2, {
    kind: 'sport', color: '#c0392b', tag: 'getaway',
  });
  walkTo(world, getaway.x + 36, getaway.y, 1500, (s) => dist(s.player.x, s.player.y, getaway.x, getaway.y) < 44);
  let shots = 0;
  while (state.wanted.heat < 100 && shots < 30 && !state.over && state.wanted.bust < 0.35) {
    shots += 1;
    const input = blankInput();
    input.fire = true;
    input.aimAngle = 0;
    world.step(STEP, input);
    for (let i = 0; i < 19; i += 1) world.step(STEP, blankInput());
  }
  if (!state.player.car && dist(state.player.x, state.player.y, getaway.x, getaway.y) < 52) {
    pressEnter(world);
  }
  if (state.player.car) {
    // South down the avenue in the southbound lane, and take the portrait the moment the
    // law is properly on his tail: a half-second of close pursuit is the frame, before the
    // ramming beats the car to scrap.
    let dir = 1;
    let contact = 0;
    driveSteps(world, (s) => {
      if (s.player.y > 2560) dir = -1;
      if (s.player.y < 320) dir = 1;
      return { x: BEACH_ROAD_X + (dir > 0 ? -LANE : LANE), y: s.player.y + dir * 800 };
    }, 60 * 4, 330, (s) => {
      let best = Infinity;
      for (const c of s.cars) {
        if (c.driver !== 'police') continue;
        const d = dist(s.player.x, s.player.y, c.x, c.y);
        if (d < best) best = d;
      }
      if (best < 210) contact += 1; else contact = 0;
      return contact > 30 || (s.player.car && s.player.car.health < 55);
    });
  }
  return { screen: SCREEN_PLAY };
}

function stageEnd(world) {
  world.reset();
  const state = world.state;
  state.clock.hour = 12.1;
  const car = stealNearestCar(world);
  if (car) {
    pressEnter(world); // straight back out — nowhere to run, on foot
    // Walk toward the responding unit and stop close: the bust meter does the rest. While no
    // unit is in sight, a shot over the bay now and then keeps the heat from cooling off
    // (each report refreshes the wanted hold through the real crime mechanics).
    let guard = 0;
    while (!state.over && guard < 60 * 120) {
      guard += 1;
      let cop = null;
      let bestD = Infinity;
      for (const c of state.cars) {
        if (c.driver !== 'police' && c.driver !== 'policeParked') continue;
        const d = dist(state.player.x, state.player.y, c.x, c.y);
        if (d < bestD) { bestD = d; cop = c; }
      }
      for (const p of state.peds) {
        if (p.kind !== 'officer') continue;
        const d = dist(state.player.x, state.player.y, p.x, p.y);
        if (d < bestD) { bestD = d; cop = p; }
      }
      if (!cop) {
        if (guard % 45 === 0) {
          const input = blankInput();
          input.fire = true;
          input.aimAngle = 0;
          world.step(STEP, input);
        } else {
          world.step(STEP, blankInput());
        }
        continue;
      }
      if (bestD > 46) world.step(STEP, footInput(state, cop.x, cop.y));
      else world.step(STEP, blankInput());
    }
  }
  return { screen: state.over === 'busted' ? SCREEN_BUSTED : SCREEN_PLAY };
}

// The staging internals are exported for headless diagnostics and tuning.
export { blankInput, driveInput, driveSteps, driveTo, footInput, nearestCar, pressEnter, stealNearestCar, walkTo };

/**
 * Set `world` to the named scene (start, play, chase or end; any other name is start) and
 * return the screen to draw over it.
 */
export function stageShot(name, world) {
  if (name === 'play') return stagePlay(world);
  if (name === 'chase') return stageChase(world);
  if (name === 'end') return stageEnd(world);
  return stageStart(world);
}
