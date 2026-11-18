// Staged scenes for the screenshots. Each one resets the world and then plays it — really
// plays it, with autopilots walking the sidewalks and driving the streets — until the
// scene the shot needs has honestly happened: the theft is witnessed, the stars are
// earned crime by crime, the bust fills because Rio stayed put. Nothing is posed by
// writing state directly, beyond the time of day each scene is set at.
import { CITY_W, CITY_H, PITCH, STEP } from './config.js';
import { roadX, roadY } from './city.js';
import { angleDiff, clamp } from './world.js';
import { SCREEN_BUSTED, SCREEN_PLAY, SCREEN_TITLE } from './render.js';

const ZERO = { mx: 0, my: 0, run: false, interact: false, fire: false, aimX: 0, aimY: 0 };

function walkCtrl(s, tx, ty) {
  const p = s.player;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 6) return { ...ZERO };
  return { mx: dx / d, my: dy / d, run: d > 120, interact: false, fire: false, aimX: tx, aimY: ty };
}

function snap(v, max) {
  return clamp(Math.round(v / PITCH) * PITCH, 0, max);
}

/** A walking route that stays on the streets: junction to junction, then the last steps. */
function makeRoute(s, tx, ty) {
  const ax = snap(s.player.x, CITY_W);
  const ay = snap(s.player.y, CITY_H);
  const bx = snap(tx, CITY_W);
  const by = snap(ty, CITY_H);
  return [[ax, ay], [bx, ay], [bx, by], [tx, ty]];
}

function walkRoute(s, route, idx) {
  const p = s.player;
  while (idx.i < route.length - 1 && Math.hypot(route[idx.i][0] - p.x, route[idx.i][1] - p.y) < 30) idx.i += 1;
  return walkCtrl(s, route[idx.i][0], route[idx.i][1]);
}

/**
 * Follow a street route toward a possibly-moving target (a car traffic has nudged, a
 * comet, a bait sedan). The route is rebuilt whenever the target has drifted from
 * where the route was aimed — a stale route ends at a building face, not at the car.
 * The holder is { route, i, tx, ty } and doubles as walkRoute's index.
 */
function followRoute(s, holder, tx, ty) {
  if (!holder.route || Math.hypot(holder.tx - tx, holder.ty - ty) > 40) {
    holder.route = makeRoute(s, tx, ty);
    holder.i = 0;
    holder.tx = tx;
    holder.ty = ty;
  }
  return walkRoute(s, holder.route, holder);
}

/** The driving autopilot: road waypoints, an unstick reverse, and a dodge for traffic. */
function driveCtrl(s, wx, wy, scratch, cap = 0) {
  const car = s.player.car;
  if (!car) return { ...ZERO };
  const dx = wx - car.x;
  const dy = wy - car.y;
  const d = Math.hypot(dx, dy);
  const diff = angleDiff(Math.atan2(dy, dx), car.angle);
  let steer = clamp(diff * 1.7, -1, 1);
  let my = 1;
  if (Math.abs(diff) > 1.15) my = 0.45;
  if (Math.abs(diff) > 2.5 && d < 150) {
    my = -0.75;
    steer = -Math.sign(diff) || 1;
  }
  if (Math.abs(car.speed) < 10 && my > 0) {
    scratch.stuck += STEP;
    if (scratch.stuck > 0.7) {
      scratch.rev = 0.55;
      scratch.stuck = 0;
    }
  } else scratch.stuck = 0;
  if (scratch.rev > 0) {
    scratch.rev -= STEP;
    my = -0.8;
    steer = -steer;
  }
  if (cap && Math.abs(car.speed) > cap) my = Math.min(my, 0);
  const px = car.x + Math.cos(car.angle) * 74;
  const py = car.y + Math.sin(car.angle) * 74;
  for (const o of s.cars) {
    if (o === car || o.kind === 'police') continue;
    if (Math.hypot(px - o.x, py - o.y) < 42) {
      const cross = Math.cos(car.angle) * (o.y - car.y) - Math.sin(car.angle) * (o.x - car.x);
      steer = clamp(steer + (cross > 0 ? -0.85 : 0.85), -1, 1);
      break;
    }
  }
  return {
    mx: steer, my, run: false, interact: false, fire: false,
    aimX: car.x + Math.cos(car.angle) * 100, aimY: car.y + Math.sin(car.angle) * 100,
  };
}

/**
 * Place a special car on the avenue within sight of a witness — a crime needs an
 * audience. The witness is picked close to Rio's landing spot, so they are still
 * nearby when he arrives a few seconds later instead of wandering off.
 */
function placeByWitness(world, type, tag) {
  const s = world.state;
  const carX = roadX(13) - 37;
  let ped = null;
  let best = Infinity;
  for (const p of s.peds) {
    const d = Math.hypot(p.x - carX, p.y - roadY(5));
    if (d < best) {
      best = d;
      ped = p;
    }
  }
  const y = clamp(ped ? ped.y : roadY(5), roadY(4), roadY(6));
  return world.spawnSpecialCar(type, tag, carX, y, -Math.PI / 2);
}

/**
 * If a theft went unwitnessed, make some noise — honestly: stroll up to the nearest
 * pedestrian first (they only run once the shooting starts), then fire into the air
 * away from them until the first star lands. Then get back in the car.
 */
/** Step out of the car, if Rio is sitting in it. */
function exitCar(world) {
  const s = world.state;
  for (let i = 0; i < Math.round(0.5 / STEP) && s.player.car; i += 1) {
    world.step(STEP, { ...ZERO, interact: true });
  }
}

function nearestPedTo(s, x, y) {
  let bp = null;
  let bd = Infinity;
  for (const p of s.peds) {
    if (p.mode === 'down' || p.mode === 'passenger') continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      bp = p;
    }
  }
  return { ped: bp, d: bd };
}

/**
 * Fire the pistol until done(state) holds — aimed away from the nearest witness, so
 * the shots themselves hurt no one; only the noise (gunfire heat) is wanted. If the
 * bust meter climbs past halfway the noise stops: a busted Rio shoots nothing.
 */
function fireUntil(world, done) {
  const s = world.state;
  for (let i = 0; i < Math.round(2.5 / STEP) && !done(s) && !s.over; i += 1) {
    if (s.bust > 0.55) break;
    const { ped } = nearestPedTo(s, s.player.x, s.player.y);
    const aimA = ped ? Math.atan2(s.player.y - ped.y, s.player.x - ped.x) : 0;
    world.step(STEP, {
      ...ZERO, fire: true,
      aimX: s.player.x + Math.cos(aimA) * 400, aimY: s.player.y + Math.sin(aimA) * 400,
    });
  }
}

/** Get back into the car — by the streets, since a straight line home crosses buildings. */
function reenterCar(world, car) {
  const s = world.state;
  const holder = { route: null, i: 0, tx: 0, ty: 0 };
  for (let i = 0; i < Math.round(6 / STEP) && !s.player.car && !s.over; i += 1) {
    const d = Math.hypot(car.x - s.player.x, car.y - s.player.y);
    const ctrl = d < car.len / 2 + 24 ? { ...ZERO, interact: true } : followRoute(s, holder, car.x, car.y);
    world.step(STEP, ctrl);
  }
}

/**
 * An unwitnessed theft still needs its star: step out, walk within earshot of a
 * pedestrian, fire into the air until the gunfire is reported, and get back in.
 */
function provoke(world, car) {
  const s = world.state;
  exitCar(world);
  for (let i = 0; i < Math.round(3.5 / STEP) && !s.over; i += 1) {
    const { ped, d } = nearestPedTo(s, s.player.x, s.player.y);
    if (!ped || d < 150) break;
    world.step(STEP, walkCtrl(s, ped.x, ped.y));
  }
  fireUntil(world, (st) => st.stars > 0);
  reenterCar(world, car);
}

function stageStart(world) {
  const s = world.state;
  s.clock = 17.65; // golden hour over the bay
  const steps = Math.round(5.5 / STEP);
  for (let i = 0; i < steps; i += 1) world.step(STEP, { ...ZERO }, true);
  return { screen: SCREEN_TITLE };
}

function stagePlay(world, missions) {
  const s = world.state;
  s.clock = 11.2;
  const scratch = { stuck: 0, rev: 0, r: 0 };
  const holder = { route: null, i: 0, tx: 0, ty: 0 };
  let phase = 'begin';
  let inCarAt = -1;
  const cap = Math.round(48 / STEP);
  for (let i = 0; i < cap; i += 1) {
    let ctrl = { ...ZERO };
    const comet = s.cars.find((c) => c.special === 'comet');
    if (phase === 'begin') {
      if (comet && s.objective) phase = 'walk';
    } else if (phase === 'walk' && comet) {
      const d = Math.hypot(comet.x - s.player.x, comet.y - s.player.y);
      if (d < comet.len / 2 + 24 && !s.player.car) ctrl = { ...ZERO, interact: true };
      else ctrl = followRoute(s, holder, comet.x, comet.y);
      if (s.player.car) {
        phase = 'drive';
        inCarAt = i;
      }
    } else if (phase === 'drive' && s.player.car) {
      const bay = s.city.specials.respray.bay;
      const bx = bay.x + bay.w / 2;
      const by = bay.y + bay.h / 2;
      const rt = [[roadX(9), roadY(5)], [roadX(7), roadY(5)], [roadX(7), roadY(8)], [bx, roadY(8)], [bx, by]];
      const [wx, wy] = rt[Math.min(scratch.r, rt.length - 1)];
      if (Math.hypot(wx - s.player.car.x, wy - s.player.car.y) < 70 && scratch.r < rt.length - 1) scratch.r += 1;
      ctrl = driveCtrl(s, wx, wy, scratch);
      // The frame: mid-city, mission marker up, Faro's message still on the phone.
      if (i - inCarAt > Math.round(2.4 / STEP) && Math.abs(s.player.car.speed) > 90) break;
    }
    world.step(STEP, ctrl);
    missions.update(world, STEP);
    if (s.over) break;
  }
  return { screen: SCREEN_PLAY };
}

function stageChase(world) {
  // Two attempts: if the getaway gets wrecked in the trading of paint, start over on the
  // next turn of the seeded stream and run the sequence again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) world.reset();
    const screen = runChase(world);
    if (screen) return screen;
  }
  return { screen: SCREEN_PLAY };
}

function runChase(world) {
  const s = world.state;
  s.clock = 15.2;
  // The getaway is a Comet S again: the sequence below only asks it to survive ONE
  // capped ram — the third star comes from gunfire, not from a second impact.
  const car = placeByWitness(world, 'sport', 'getaway');
  const scratch = { stuck: 0, rev: 0, w: 0 };
  const holder = { route: null, i: 0, tx: 0, ty: 0 };
  let phase = 'walk';
  let phaseT = 0;
  const cap = Math.round(100 / STEP);
  for (let i = 0; i < cap; i += 1) {
    let ctrl = { ...ZERO };
    phaseT += STEP;
    // The money frame, whenever it honestly happens after the third star lands: Rio at
    // speed, one interceptor on him and a second closing fast.
    if (s.stars === 3 && s.player.car) {
      const dists = s.cars
        .filter((c) => c.kind === 'police' && !c.leaveMode)
        .map((c) => Math.hypot(c.x - s.player.car.x, c.y - s.player.car.y))
        .sort((a, b) => a - b);
      if (dists.length >= 2 && dists[0] < 430 && dists[1] < 720 && Math.abs(s.player.car.speed) > 45) {
        return { screen: SCREEN_PLAY };
      }
      // Written off with the law on top of him is still the chase's climax — take it
      // over a lesser frame, but only when an interceptor is right there.
      if (s.player.car.wrecked && dists.length >= 1 && dists[0] < 340) return { screen: SCREEN_PLAY };
    }
    if (s.player.car && s.player.car.wrecked) return null; // this attempt is a write-off
    if (phase !== 'walk' && !s.player.car && !s.over) phase = 'walk'; // never drive on foot
    if (phase === 'walk') {
      const d = Math.hypot(car.x - s.player.x, car.y - s.player.y);
      if (d < car.len / 2 + 24 && !s.player.car) ctrl = { ...ZERO, interact: true };
      else ctrl = followRoute(s, holder, car.x, car.y);
      if (s.player.car) {
        if (s.stars === 0) provoke(world, car); // an unwitnessed theft still needs its star
        ctrl = { ...ZERO }; // provoke already played its steps; don't act on a stale press
        phase = 'lure';
        phaseT = 0;
      }
    } else if (phase === 'lure') {
      // Cruise the avenue slowly and let the first unit come to Rio.
      ctrl = driveCtrl(s, roadX(13), roadY(9), scratch, 130);
      const cop = s.cars.find((c) => c.kind === 'police' && !c.leaveMode);
      if (cop && Math.hypot(cop.x - s.player.car.x, cop.y - s.player.car.y) < 170) {
        phase = 'ram';
        phaseT = 0;
      }
      if (phaseT > 25) return null;
    } else if (phase === 'ram') {
      // Trade paint with the interceptor ONCE: +135, witnessed by definition. The
      // closing speed is capped — the point is the crime, not writing the car off.
      const cop = s.cars.find((c) => c.kind === 'police' && !c.leaveMode);
      if (cop) {
        ctrl = driveCtrl(s, cop.x + Math.cos(cop.angle) * cop.speed * 0.3, cop.y + Math.sin(cop.angle) * cop.speed * 0.3, scratch, 215);
      }
      if (s.heat >= 240 || phaseT > 7) {
        phase = 'clear';
        phaseT = 0;
      }
    } else if (phase === 'clear') {
      // Open a gap on the spinning interceptor, then step out and make noise: one
      // gunfire report (+55) on top of the theft and the ram is exactly three stars
      // (110 + 135 + 55 = 300), earned without a second impact.
      ctrl = driveCtrl(s, roadX(13), roadY(9), scratch, 300);
      let nd = Infinity;
      for (const c of s.cars) {
        if (c.kind !== 'police' || c.leaveMode) continue;
        nd = Math.min(nd, Math.hypot(c.x - s.player.car.x, c.y - s.player.car.y));
      }
      if (s.stars === 3) {
        // The ram clipped something extra and the third star is already up — never
        // stop at all. (Re-entering the car would also re-report the theft: +110 and
        // a fourth star nobody ordered.)
        phase = 'flee';
        phaseT = 0;
      } else if ((nd > 165 && phaseT > 0.7) || phaseT > 3) {
        exitCar(world);
        fireUntil(world, (st) => st.stars >= 3);
        reenterCar(world, car);
        ctrl = { ...ZERO }; // the shootout already played its steps
        phase = 'flee';
        phaseT = 0;
      }
    } else if (phase === 'flee') {
      const wp = [[roadX(13), roadY(9)], [roadX(10), roadY(9)], [roadX(10), roadY(6)], [roadX(13), roadY(6)]];
      const [wx, wy] = wp[scratch.w % wp.length];
      if (Math.hypot(wx - s.player.car.x, wy - s.player.car.y) < 90) scratch.w += 1;
      ctrl = driveCtrl(s, wx, wy, scratch);
      if (phaseT > 45) return { screen: SCREEN_PLAY }; // fall back to the current frame
    }
    world.step(STEP, ctrl);
    if (s.over) return null;
  }
  return s.player.car && s.player.car.wrecked ? null : { screen: SCREEN_PLAY };
}

function stageEnd(world) {
  const s = world.state;
  s.clock = 18.3; // dusk
  const car = placeByWitness(world, 'sedan', 'bait');
  const holder = { route: null, i: 0, tx: 0, ty: 0 };
  let stole = false;
  const cap = Math.round(45 / STEP);
  for (let i = 0; i < cap; i += 1) {
    let ctrl = { ...ZERO };
    if (!stole) {
      const d = Math.hypot(car.x - s.player.x, car.y - s.player.y);
      if (d < car.len / 2 + 24 && !s.player.car) ctrl = { ...ZERO, interact: true };
      else ctrl = followRoute(s, holder, car.x, car.y);
      if (s.player.car) {
        if (s.stars === 0) provoke(world, car);
        ctrl = { ...ZERO };
        stole = true;
      }
    }
    world.step(STEP, ctrl);
    if (s.over === 'busted') return { screen: SCREEN_BUSTED };
    if (s.over) break;
  }
  return { screen: s.over === 'busted' ? SCREEN_BUSTED : SCREEN_PLAY };
}

/**
 * Play the named scene out in the world and report the screen to draw.
 * The world is reset first; the missions manager is only needed for 'play'.
 */
export function stageShot(name, world, missions) {
  world.reset();
  if (name === 'play') return stagePlay(world, missions);
  if (name === 'chase') return stageChase(world);
  if (name === 'end') return stageEnd(world);
  return stageStart(world);
}
