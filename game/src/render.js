// Drawing only: the world's state and the current screen in, pixels out. The camera follows
// Rio (with a little look-ahead toward his velocity and the shake the world hands us), the
// city is drawn in layers — sea, sand, roads, sidewalks, marks, cars, people, buildings with
// pseudo-3D roofs, palm fronds, particles — then the night falls as a tint with lamp glow and
// headlight cones on top, and finally the HUD, the minimap and whichever screen is up. Nothing
// here changes the world, and nothing here uses unseeded randomness: a staged frame renders
// the same every time.
import { CAR, FONT, GRID, PALETTE, PITCH, PLAYER } from './config.js';
import {
  BEACH_ROAD_X, SAND_X, WATER_X, WORLD_H, WORLD_W, blockRect, roadX, roadY,
} from './city.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_HELP = 'help';
export const SCREEN_BRIEF = 'brief';
export const SCREEN_BUSTED = 'busted';
export const SCREEN_WASTED = 'wasted';

/** 0 in full day, 1 in full night; dawn and dusk ramp between. */
export function nightFactor(hour) {
  if (hour < 4.5) return 1;
  if (hour < 7) return 1 - (hour - 4.5) / 2.5;
  if (hour < 17.5) return 0;
  if (hour < 20) return (hour - 17.5) / 2.5;
  return 1;
}

function hash2(a, b) {
  let h = (a ^ Math.imul(b + 1, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const shadeCache = new Map();
function shade(hex, f) {
  const key = hex + '|' + f;
  if (shadeCache.has(key)) return shadeCache.get(key);
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  const out = `rgb(${r},${g},${b})`;
  shadeCache.set(key, out);
  return out;
}

export function createRenderer(canvas) {
  const context = canvas.getContext('2d');
  const view = { w: 1280, h: 800, dpr: 1, scale: 1, vw: 1280, vh: 800 };
  const camera = { x: 0, y: 0 };
  let scaleCur = 1;
  let scaleInit = false;
  // A soft radial glow sprite, drawn additively for lamps and headlights at night.
  const glow = document.createElement('canvas');
  glow.width = 128;
  glow.height = 128;
  {
    const g = glow.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,214,140,0.85)');
    grad.addColorStop(1, 'rgba(255,214,140,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  const fonts = new Map();
  function text(value, x, y, size, color, align = 'left', weight = 600) {
    const key = size + '|' + weight;
    if (!fonts.has(key)) fonts.set(key, `${weight} ${size}px ${FONT}`);
    context.font = fonts.get(key);
    context.fillStyle = color;
    context.textAlign = align;
    context.textBaseline = 'alphabetic';
    context.fillText(value, x, y);
  }
  function rect(x, y, w, h, color) {
    context.fillStyle = color;
    context.fillRect(x, y, w, h);
  }

  function computeCamera(state) {
    const p = state.player;
    // The lens breathes out as Rio speeds up: more of the city ahead at full throttle, tight
    // and personal on foot. The first frame snaps; later frames ease toward the target.
    const target = p.car ? 1 - Math.min(0.2, Math.abs(p.car.speed) / 2600) : 1;
    if (!scaleInit) { scaleCur = target; scaleInit = true; } else scaleCur += (target - scaleCur) * 0.08;
    view.scale = scaleCur;
    view.vw = view.w / scaleCur;
    view.vh = view.h / scaleCur;
    const look = p.car ? 0.22 : 0.1;
    const lx = p.car ? Math.cos(p.car.angle) * p.car.speed * look : 0;
    const ly = p.car ? Math.sin(p.car.angle) * p.car.speed * look : 0;
    camera.x = Math.min(Math.max(p.x + lx - view.vw / 2, 0), Math.max(0, WORLD_W - view.vw));
    camera.y = Math.min(Math.max(p.y + ly - view.vh / 2, 0), Math.max(0, WORLD_H - view.vh));
    return camera;
  }

  // -------------------------------------------------------------- world layers
  /** Moored boats in the bay off the docks, bobbing on the same swell as the foam. */
  function drawBoats(state) {
    const t = state.time;
    const spots = [
      { x: WATER_X + 170, y: 2520, a: 0.12, color: '#e8e4da' },
      { x: WATER_X + 330, y: 2330, a: -0.08, color: '#c94f42' },
      { x: WATER_X + 110, y: 1980, a: 0.2, color: '#3a6ea3' },
      { x: WATER_X + 420, y: 2740, a: 0.05, color: '#e8e4da' },
    ];
    for (const b of spots) {
      if (b.x < camera.x - 120 || b.x > camera.x + view.vw + 120 || b.y < camera.y - 120 || b.y > camera.y + view.vh + 120) continue;
      const bob = Math.sin(t * 0.9 + b.x * 0.05) * 3;
      context.save();
      context.translate(b.x, b.y + bob);
      context.rotate(b.a + Math.sin(t * 0.6 + b.y) * 0.02);
      context.fillStyle = 'rgba(0,0,0,0.18)';
      context.beginPath();
      context.ellipse(3, 6, 40, 13, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = b.color;
      context.beginPath();
      context.roundRect(-38, -11, 76, 22, 9);
      context.fill();
      rect(-38, -3, 76, 5, 'rgba(20,40,60,0.35)');
      rect(-8, -8, 24, 15, '#f4f1e8');
      rect(-4, -5, 7, 8, '#9fc4d4');
      rect(5, -5, 7, 8, '#9fc4d4');
      context.restore();
    }
  }

  function drawGround(state) {
    const t = state.time;
    const x0 = camera.x - 40;
    const y0 = camera.y - 40;
    const x1 = camera.x + view.vw + 40;
    const y1 = camera.y + view.vh + 40;
    // Sea, with two slow foam drifts (a function of sim time, so stills are repeatable).
    rect(camera.x - 40, camera.y - 40, view.vw + 80, view.vh + 80, PALETTE.waterDeep);
    context.fillStyle = PALETTE.water;
    const stripe = 46;
    const off = (t * 9) % stripe;
    for (let y = Math.floor(y0 / stripe) * stripe - off; y < y1; y += stripe) {
      context.fillRect(Math.max(x0, WATER_X), y, x1 - Math.max(x0, WATER_X), 16);
    }
    // A breathing foam edge where the bay meets the sand, plus a wet-sand sheen band.
    rect(Math.max(x0, WATER_X - 18), y0, Math.max(0, Math.min(x1, WATER_X) - Math.max(x0, WATER_X - 18)), y1 - y0, 'rgba(30,40,50,0.10)');
    context.fillStyle = PALETTE.waterFoam;
    for (let y = Math.floor(y0 / 15) * 15; y < y1; y += 15) {
      const fx = WATER_X + 2 + Math.sin(t * 1.5 + y * 0.045) * 4;
      context.globalAlpha = 0.5 + 0.3 * Math.sin(t * 2 + y * 0.11);
      context.beginPath();
      context.arc(fx, y, 5.5, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    drawBoats(state);
    // Land and sand — the sand speckled like real grain, seeded by world position.
    rect(x0, y0, Math.max(0, Math.min(x1, SAND_X) - x0), y1 - y0, '#757a68');
    rect(Math.max(x0, SAND_X), y0, Math.max(0, Math.min(x1, WATER_X) - Math.max(x0, SAND_X)), y1 - y0, PALETTE.sand);
    context.fillStyle = 'rgba(120,96,58,0.35)';
    const sandX0 = Math.max(x0, SAND_X);
    for (let gx = Math.floor(sandX0 / 26) * 26; gx < Math.min(x1, WATER_X); gx += 26) {
      for (let gy = Math.floor(y0 / 26) * 26; gy < y1; gy += 26) {
        if (hash2(gx, gy) > 0.55) context.fillRect(gx + hash2(gy, gx) * 16, gy + hash2(gx, gy * 3) * 16, 2.4, 2.4);
      }
    }
    // Roads: verticals then horizontals, with centre dashes and crosswalks.
    context.fillStyle = PALETTE.road;
    for (let i = 0; i <= GRID.cols; i += 1) {
      const x = roadX(i) - GRID.road / 2;
      if (x + GRID.road < x0 || x > x1) continue;
      context.fillRect(x, Math.max(y0, 0), GRID.road, Math.min(y1, WORLD_H) - Math.max(y0, 0));
    }
    for (let j = 0; j < GRID.rows; j += 1) {
      const y = roadY(j) - GRID.road / 2;
      if (y + GRID.road < y0 || y > y1) continue;
      const rx = Math.max(x0, 0);
      const rw = Math.min(x1, SAND_X) - rx;
      if (rw > 0) context.fillRect(rx, y, rw, GRID.road);
    }
    context.fillStyle = PALETTE.lane;
    for (let i = 0; i <= GRID.cols; i += 1) {
      const x = roadX(i);
      if (x < x0 || x > x1) continue;
      for (let y = Math.floor(y0 / 44) * 44; y < y1; y += 44) context.fillRect(x - 1.5, y, 3, 22);
    }
    for (let j = 0; j < GRID.rows; j += 1) {
      const y = roadY(j);
      if (y < y0 || y > y1) continue;
      for (let x = Math.floor(x0 / 44) * 44; x < Math.min(x1, SAND_X); x += 44) context.fillRect(x, y - 1.5, 22, 3);
    }
    context.fillStyle = PALETTE.crosswalk;
    for (let i = 0; i <= GRID.cols; i += 1) {
      for (let j = 0; j < GRID.rows; j += 1) {
        const x = roadX(i);
        const y = roadY(j);
        if (x < x0 - 40 || x > x1 + 40 || y < y0 - 40 || y > y1 + 40) continue;
        // Zebra bands on all four approaches.
        for (let sLine = -2; sLine <= 2; sLine += 1) {
          context.fillRect(x + sLine * 10 - 2, y - 27, 4.6, 11);
          context.fillRect(x + sLine * 10 - 2, y + 16, 4.6, 11);
          context.fillRect(x - 27, y + sLine * 10 - 2, 11, 4.6);
          context.fillRect(x + 16, y + sLine * 10 - 2, 11, 4.6);
        }
        // Stop lines on the right-hand approach of each leg.
        context.fillStyle = 'rgba(240,240,235,0.8)';
        context.fillRect(x + 3, y - 33, 22, 4);
        context.fillRect(x - 25, y + 29, 22, 4);
        context.fillRect(x - 33, y - 25, 4, 22);
        context.fillRect(x + 29, y + 3, 4, 22);
        context.fillStyle = PALETTE.crosswalk;
      }
    }
    // Sidewalk aprons under every block, the park's grass, the respray bay floor.
    context.fillStyle = PALETTE.sidewalk;
    for (let i = 0; i < GRID.cols; i += 1) {
      for (let j = 0; j < GRID.rows; j += 1) {
        const r = blockRect(i, j);
        if (r.x - GRID.walk > x1 || r.x + r.w + GRID.walk < x0 || r.y - GRID.walk > y1 || r.y + r.h + GRID.walk < y0) continue;
        context.fillRect(r.x - GRID.walk, r.y - GRID.walk, r.w + GRID.walk * 2, r.h + GRID.walk * 2);
      }
    }
    const park = state.city.parkRect;
    rect(park.x, park.y, park.w, park.h, PALETTE.grass);
    const bay = state.city.respray.bay;
    rect(bay.x, bay.y, bay.w, bay.h, '#4c5157');
    context.strokeStyle = PALETTE.accent;
    context.lineWidth = 3;
    context.strokeRect(bay.x + 3, bay.y + 3, bay.w - 6, bay.h - 6);
    // The docks apron.
    context.fillStyle = '#6e6a5e';
    context.fillRect(state.city.docks.apron.x - 70, state.city.docks.apron.y - 46, 150, 100);
  }

  function drawSkids(state) {
    context.strokeStyle = 'rgba(18,18,20,0.5)';
    context.lineWidth = 5;
    context.beginPath();
    for (const s of state.skids) {
      context.moveTo(s.x1, s.y1);
      context.lineTo(s.x2, s.y2);
    }
    context.stroke();
  }

  function drawMarker(x, y, t, color) {
    const pulse = 1 + Math.sin(t * 4) * 0.12;
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, 26 * pulse, 0, Math.PI * 2);
    context.stroke();
    const grad = context.createLinearGradient(x, y - 190, x, y);
    grad.addColorStop(0, 'rgba(255,217,77,0)');
    grad.addColorStop(1, 'rgba(255,217,77,0.4)');
    context.fillStyle = grad;
    context.fillRect(x - 7, y - 190, 14, 190);
  }

  function drawPickups(state) {
    for (const pk of state.pickups) {
      if (!pk.active) continue;
      const bob = Math.sin(state.time * 3 + pk.x) * 3;
      context.fillStyle = 'rgba(0,0,0,0.25)';
      context.beginPath();
      context.ellipse(pk.x, pk.y + 10, 13, 5, 0, 0, Math.PI * 2);
      context.fill();
      if (pk.kind === 'health') {
        rect(pk.x - 10, pk.y - 10 + bob, 20, 20, '#f2f2ee');
        rect(pk.x - 3, pk.y - 7 + bob, 6, 14, '#e8483f');
        rect(pk.x - 7, pk.y - 3 + bob, 14, 6, '#e8483f');
      } else {
        context.fillStyle = '#4d9de0';
        context.beginPath();
        context.arc(pk.x, pk.y + bob, 10, 0, Math.PI * 2);
        context.fill();
        rect(pk.x - 6, pk.y - 2 + bob, 12, 8, '#2c6ea8');
      }
    }
  }

  function drawCar(car, state) {
    const nf = nightFactor(state.clock.hour);
    context.save();
    context.translate(car.x, car.y);
    // Headlight cones first, under the body.
    if (nf > 0.25 && !car.dead) {
      context.save();
      context.rotate(car.angle);
      context.globalCompositeOperation = 'lighter';
      context.globalAlpha = 0.16 * nf;
      const grad = context.createLinearGradient(40, 0, 190, 0);
      grad.addColorStop(0, '#ffe9b0');
      grad.addColorStop(1, 'rgba(255,233,176,0)');
      context.fillStyle = grad;
      context.beginPath();
      context.moveTo(40, -12);
      context.lineTo(190, -44);
      context.lineTo(190, 44);
      context.lineTo(40, 12);
      context.closePath();
      context.fill();
      context.restore();
    }
    context.rotate(car.angle);
    // Soft shadow, then wheels — the front pair visibly turned with the steering.
    context.fillStyle = 'rgba(0,0,0,0.3)';
    context.beginPath();
    context.roundRect(-CAR.length / 2 + 4, -CAR.width / 2 + 6, CAR.length, CAR.width, 10);
    context.fill();
    context.fillStyle = '#191b1e';
    for (const [wx, wy] of [[-30, -24], [30, -24], [-30, 18], [30, 18]]) {
      context.save();
      context.translate(wx + 8.5, wy + 3.5);
      if (wx > 0) context.rotate((car.steerVis || 0) * 0.45);
      context.fillRect(-8.5, -3.5, 17, 7);
      context.restore();
    }
    // Body: a lengthwise metallic gradient, lit along the spine, darker at the tail.
    const body = car.dead ? '#3a3d40' : car.color;
    if (car.dead) {
      context.fillStyle = body;
    } else {
      const grad = context.createLinearGradient(-CAR.length / 2, 0, CAR.length / 2, 0);
      grad.addColorStop(0, shade(car.color, 0.72));
      grad.addColorStop(0.45, shade(car.color, 1.14));
      grad.addColorStop(1, shade(car.color, 0.92));
      context.fillStyle = grad;
    }
    context.beginPath();
    context.roundRect(-CAR.length / 2, -CAR.width / 2, CAR.length, CAR.width, 9);
    context.fill();
    if (!car.dead) rect(-CAR.length / 2 + 10, -2, CAR.length - 20, 4, 'rgba(255,255,255,0.13)');
    if (car.kind === 'police') {
      rect(-14, -CAR.width / 2, 30, CAR.width, '#22262b');
      const flash = Math.floor(state.time * 2.4) % 2 === 0;
      rect(-8, -11, 16, 9, flash ? '#ff4040' : '#7a1d1d');
      rect(-8, 2, 16, 9, flash ? '#2c4d8f' : '#4d7dff');
    } else if (car.kind === 'taxi') {
      rect(-8, -CAR.width / 2, 14, CAR.width, '#22262b');
      rect(-4, -8, 8, 16, '#fff6d8');
    } else if (car.kind === 'van' || car.kind === 'truck') {
      rect(-CAR.length / 2 + 6, -CAR.width / 2 + 5, CAR.length - 34, CAR.width - 10, shade(body === '#3a3d40' ? body : car.color, 0.82));
      if (car.armored) {
        context.strokeStyle = '#ffd94d';
        context.lineWidth = 2.5;
        context.strokeRect(-CAR.length / 2 + 4, -CAR.width / 2 + 4, CAR.length - 8, CAR.width - 8);
      }
    } else {
      rect(-16, -CAR.width / 2 + 6, 34, CAR.width - 12, shade(car.color, 0.8));
    }
    // Windshield and rear glass.
    rect(16, -CAR.width / 2 + 6, 8, CAR.width - 12, '#b9d6de');
    rect(-24, -CAR.width / 2 + 6, 6, CAR.width - 12, '#8fb0ba');
    // Lights: headlights burn pale at dusk and night; brake lights flare when slowing.
    if (!car.dead) {
      if (nf > 0.2) {
        rect(CAR.length / 2 - 4, -CAR.width / 2 + 4, 4, 9, '#fff3c4');
        rect(CAR.length / 2 - 4, CAR.width / 2 - 13, 4, 9, '#fff3c4');
      }
      const brake = car.brakeVis;
      rect(-CAR.length / 2, -CAR.width / 2 + 4, 4, 9, brake ? '#ff2a1a' : '#8f1d14');
      rect(-CAR.length / 2, CAR.width / 2 - 13, 4, 9, brake ? '#ff2a1a' : '#8f1d14');
      if (brake && nf > 0.2) {
        context.save();
        context.globalCompositeOperation = 'lighter';
        context.globalAlpha = 0.3 * nf;
        context.drawImage(glow, -CAR.length / 2 - 16, -CAR.width / 2 - 8, 26, 26);
        context.drawImage(glow, -CAR.length / 2 - 16, CAR.width / 2 - 18, 26, 26);
        context.restore();
      }
    }
    if (car.dead) {
      context.fillStyle = 'rgba(20,20,20,0.35)';
      context.fillRect(-CAR.length / 2, -CAR.width / 2, CAR.length, CAR.width);
    }
    context.restore();
    // Damage smoke is particles (world-side); a health tick over a hurt player car.
    if (car.driver === 'player' && car.health < 45) {
      rect(car.x - 22, car.y - 40, 44, 5, '#222');
      rect(car.x - 22, car.y - 40, 44 * Math.max(0, car.health) / 120, 5, '#e8a33d');
    }
  }

  function drawPed(ped, state) {
    if (ped.state === 'passenger') return;
    context.save();
    context.translate(ped.x, ped.y);
    if (ped.state === 'down') {
      context.globalAlpha = Math.min(1, Math.max(0, ped.downT / 1.6));
      context.rotate(ped.angle + Math.PI / 2);
      context.fillStyle = ped.kind === 'officer' ? '#2c4d8f' : ped.shirt;
      context.beginPath();
      context.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = ped.skin;
      context.beginPath();
      context.arc(15, 0, 5.5, 0, Math.PI * 2);
      context.fill();
      context.restore();
      return;
    }
    context.fillStyle = 'rgba(0,0,0,0.25)';
    context.beginPath();
    context.ellipse(0, 4, 9, 4.5, 0, 0, Math.PI * 2);
    context.fill();
    const stride = Math.sin(ped.walkCycle || 0) * 3;
    const bob = -Math.abs(Math.sin(ped.walkCycle || 0)) * 1.3;
    context.strokeStyle = '#2e3138';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(-stride, 8);
    context.moveTo(0, 0);
    context.lineTo(stride, 8);
    context.stroke();
    context.fillStyle = ped.kind === 'officer' ? '#2c4d8f' : ped.shirt;
    context.beginPath();
    context.arc(0, bob, 9.5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = ped.skin;
    context.beginPath();
    context.arc(0, bob - 1, 5.6, 0, Math.PI * 2);
    context.fill();
    if (ped.kind === 'officer') {
      context.fillStyle = '#1d3357';
      context.beginPath();
      context.arc(0, -2, 5.8, 0, Math.PI * 2);
      context.fill();
      // The pistol, pointed the way he faces.
      context.strokeStyle = '#15161a';
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(Math.cos(ped.angle) * 6, Math.sin(ped.angle) * 6);
      context.lineTo(Math.cos(ped.angle) * 15, Math.sin(ped.angle) * 15);
      context.stroke();
    }
    context.restore();
    if (ped.state === 'hail') {
      const bob = Math.sin(state.time * 5) * 3;
      context.fillStyle = '#fff6d8';
      context.beginPath();
      context.arc(ped.x + 12, ped.y - 20 + bob, 9, 0, Math.PI * 2);
      context.fill();
      text('!', ped.x + 12, ped.y - 16 + bob, 13, '#b07f35', 'center', 800);
    }
  }

  function drawPlayer(state) {
    const p = state.player;
    if (p.car) return; // he is the car right now
    context.save();
    context.translate(p.x, p.y);
    context.fillStyle = 'rgba(0,0,0,0.28)';
    context.beginPath();
    context.ellipse(0, 4, 10, 5, 0, 0, Math.PI * 2);
    context.fill();
    const stride = Math.sin(p.walkCycle || 0) * 3.4;
    context.strokeStyle = '#22303a';
    context.lineWidth = 4.4;
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(-stride, 8);
    context.moveTo(0, 0);
    context.lineTo(stride, 8);
    context.stroke();
    // Rio: teal jacket, dark hair — the same silhouette in every frame.
    context.fillStyle = '#14b8a6';
    context.beginPath();
    context.arc(0, 0, 10.5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#f1c27d';
    context.beginPath();
    context.arc(0, -1, 6, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#20242a';
    context.beginPath();
    context.arc(0, -2.6, 5.6, Math.PI, Math.PI * 2);
    context.fill();
    context.restore();
    if (p.grace > 0) {
      context.strokeStyle = 'rgba(255,255,255,0.5)';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(p.x, p.y, 17 + Math.sin(state.time * 8) * 2, 0, Math.PI * 2);
      context.stroke();
    }
  }

  // Original Palmira storefronts — the signs that make a block read as a living street.
  const SHOP_NAMES = [
    'CAFÉ SOL', 'HOTEL AZURE', 'PALMIRA PAWN', 'TACOS MARINO', 'CLUB NEPTUNE', 'SURF & CO.',
    'BANCO PALMA', 'FARO RECORDS', 'PIER 9 DINER', 'SALSA CLUB', 'HELADOS LUNA', 'MOTO REX',
    'FLOR DE PALMA', 'BAR ONDA', 'JOYAS AZUL', 'CINE PALMIRA',
  ];
  const SHOP_COLORS = ['#ff5e7a', '#ffb347', '#4dd0e1', '#ffd94d', '#ff7ad9', '#7dd069'];

  function drawBuildings(state) {
    const x0 = camera.x - 90;
    const y0 = camera.y - 90;
    const x1 = camera.x + view.vw + 90;
    const y1 = camera.y + view.vh + 90;
    const nf = nightFactor(state.clock.hour);
    for (const b of state.city.buildings) {
      if (b.x + b.w < x0 || b.x > x1 || b.y + b.h < y0 || b.y > y1) continue;
      const off = 3 + b.floors * 1.7;
      // Shadow, then the wall block, then the roof shifted up-left: a cheap tower.
      rect(b.x + 7, b.y + 9, b.w, b.h, 'rgba(0,0,0,0.28)');
      rect(b.x, b.y, b.w, b.h, shade(b.color === '#3a3d40' ? b.color : b.color, 0.55));
      rect(b.x - off, b.y - off, b.w, b.h, b.color);
      rect(b.x - off, b.y - off, b.w, 5, shade(b.color, 1.12));
      // Roof furniture: a water tower on some roofs, an AC block on others, seeded per building.
      if (hash2(b.seed, 12) > 0.8) {
        const tx = b.x - off + 12 + hash2(b.seed, 9) * Math.max(4, b.w - 34);
        const ty = b.y - off + 12 + hash2(b.seed, 10) * Math.max(4, b.h - 34);
        context.fillStyle = 'rgba(0,0,0,0.2)';
        context.beginPath();
        context.ellipse(tx + 2, ty + 3, 11, 8, 0, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = shade(b.color, 0.68);
        context.beginPath();
        context.arc(tx, ty, 10, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = shade(b.color, 0.85);
        context.beginPath();
        context.arc(tx, ty, 5.5, 0, Math.PI * 2);
        context.fill();
      } else if (hash2(b.seed, 7) > 0.45) {
        const fw = 14 + hash2(b.seed, 8) * 20;
        rect(b.x - off + 8 + hash2(b.seed, 9) * (b.w - fw - 16), b.y - off + 8 + hash2(b.seed, 10) * (b.h - 30), fw, 13, shade(b.color, 0.7));
      }
      // Ground-floor life on low blocks: a striped awning and a signed storefront along the
      // south face. At night the sign burns neon through the tint.
      if (b.kind === 'block' && b.floors <= 3 && hash2(b.seed, 21) < 0.36) {
        const name = SHOP_NAMES[Math.floor(hash2(b.seed, 22) * SHOP_NAMES.length)];
        const signColor = SHOP_COLORS[Math.floor(hash2(b.seed, 23) * SHOP_COLORS.length)];
        const awnW = Math.min(b.w - 14, 64);
        const awnX = b.x - off + (b.w - awnW) / 2;
        const awnY = b.y - off + b.h - 2;
        for (let sIdx = 0; sIdx < awnW; sIdx += 8) {
          rect(awnX + sIdx, awnY, Math.min(8, awnW - sIdx), 6, sIdx % 16 === 0 ? '#f4f1e8' : signColor);
        }
        rect(awnX, awnY - 13, awnW, 12, 'rgba(14,16,22,0.92)');
        context.save();
        if (nf > 0.25) {
          context.shadowColor = signColor;
          context.shadowBlur = 13 * nf;
        }
        text(name, b.x - off + b.w / 2, awnY - 3.5, 9.5, nf > 0.25 ? signColor : '#f4f1e8', 'center', 800);
        context.restore();
      }
      // Windows: a grid over the roof face; at night the lit ones glow amber.
      const cols = Math.max(2, Math.floor(b.w / 17));
      const rows = Math.max(2, Math.floor(b.h / 17));
      for (let cx = 0; cx < cols; cx += 1) {
        for (let cy = 0; cy < rows; cy += 1) {
          const lit = hash2(b.seed, cx * 31 + cy * 7) < 0.12 + nf * 0.55;
          if (!lit && nf < 0.4) continue;
          context.fillStyle = lit ? (nf > 0.35 ? '#ffd98a' : '#cfe4ea') : 'rgba(30,40,50,0.35)';
          context.fillRect(b.x - off + 6 + cx * 17, b.y - off + 6 + cy * 17, 8, 6);
        }
      }
      if (b.name) {
        context.save();
        context.translate(b.x + b.w / 2, b.y - off - 8);
        text(b.name, 0, 0, 13, '#ffffff', 'center', 800);
        context.restore();
      }
      if (b.kind === 'hospital') {
        const cxp = b.x - off + b.w / 2;
        const cyp = b.y - off + b.h / 2;
        rect(cxp - 4, cyp - 13, 8, 26, '#e8483f');
        rect(cxp - 13, cyp - 4, 26, 8, '#e8483f');
      }
      if (b.kind === 'police') {
        rect(b.x - off + 8, b.y - off + 8, 44, 12, '#2c4d8f');
      }
    }
    // Crates and shipping containers on the docks and in yards.
    for (const c of state.city.crates) {
      if (c.x + c.w < x0 || c.x > x1 || c.y + c.h < y0 || c.y > y1) continue;
      rect(c.x + 3, c.y + 4, c.w, c.h, 'rgba(0,0,0,0.25)');
      rect(c.x, c.y, c.w, c.h, c.color);
      rect(c.x, c.y, c.w, 4, shade(c.color, 1.18));
      context.strokeStyle = 'rgba(0,0,0,0.3)';
      context.lineWidth = 2;
      context.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
      if (c.w > 60) {
        // Container corrugation.
        context.strokeStyle = 'rgba(0,0,0,0.22)';
        context.lineWidth = 1.5;
        context.beginPath();
        for (let rx = c.x + 9; rx < c.x + c.w - 5; rx += 9) {
          context.moveTo(rx, c.y + 3);
          context.lineTo(rx, c.y + c.h - 3);
        }
        context.stroke();
      }
    }
  }

  function drawPalms(state, frondsOnly) {
    const x0 = camera.x - 60;
    const y0 = camera.y - 60;
    const x1 = camera.x + view.vw + 60;
    const y1 = camera.y + view.vh + 60;
    for (const p of state.city.palms) {
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      if (!frondsOnly) {
        context.fillStyle = 'rgba(0,0,0,0.18)';
        context.beginPath();
        context.ellipse(p.x + 7, p.y + 6, 13, 7, 0, 0, Math.PI * 2);
        context.fill();
        rect(p.x - 2.5, p.y - 2.5, 5, 5, '#7a5c38');
        continue;
      }
      // The fronds breathe in the sea breeze — a sway seeded by position, driven by sim time.
      const sway = Math.sin(state.time * 1.4 + p.x * 0.02 + p.y * 0.013) * 0.07;
      context.strokeStyle = '#3f7d3a';
      context.lineWidth = 3;
      context.beginPath();
      for (let k = 0; k < 6; k += 1) {
        const a = (k / 6) * Math.PI * 2 + p.x * 0.01 + sway;
        context.moveTo(p.x, p.y);
        context.quadraticCurveTo(
          p.x + Math.cos(a) * 13 * p.s, p.y + Math.sin(a) * 13 * p.s - 5,
          p.x + Math.cos(a) * 21 * p.s, p.y + Math.sin(a) * 21 * p.s + 3,
        );
      }
      context.stroke();
    }
    if (frondsOnly) {
      for (const prop of state.city.props) {
        if (prop.kind !== 'umbrella') continue;
        if (prop.x < x0 || prop.x > x1 || prop.y < y0 || prop.y > y1) continue;
        context.fillStyle = prop.color;
        context.beginPath();
        context.arc(prop.x, prop.y, 13, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = 'rgba(255,255,255,0.5)';
        context.beginPath();
        context.arc(prop.x, prop.y, 4, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  function drawEffects(state) {
    for (const tr of state.tracers) {
      context.strokeStyle = tr.color;
      context.globalAlpha = Math.min(1, tr.life / 0.07);
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(tr.x1, tr.y1);
      context.lineTo(tr.x2, tr.y2);
      context.stroke();
      context.globalAlpha = 1;
    }
    for (const p of state.particles) {
      context.globalAlpha = Math.max(0, p.life / p.maxLife);
      context.fillStyle = p.color;
      context.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    context.globalAlpha = 1;
  }

  /** Slow cloud shadows drifting over the city in daylight — the light is never static. */
  function drawClouds(state) {
    const nf = nightFactor(state.clock.hour);
    if (nf > 0.75) return;
    const t = state.time;
    context.save();
    context.globalAlpha = 0.1 * (1 - nf);
    context.fillStyle = '#101820';
    for (let k = 0; k < 4; k += 1) {
      const cx = ((k * 1730 + t * (13 + k * 3)) % (WORLD_W + 1000)) - 500;
      const cy = hash2(k, 77) * (WORLD_H - 500) + 200 + Math.sin(t * 0.05 + k * 2) * 60;
      if (cx < camera.x - 480 || cx > camera.x + view.vw + 480 || cy < camera.y - 300 || cy > camera.y + view.vh + 300) continue;
      context.beginPath();
      context.ellipse(cx, cy, 430, 210, 0.3, 0, Math.PI * 2);
      context.ellipse(cx + 260, cy + 60, 300, 150, 0.3, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
    context.globalAlpha = 1;
  }

  function drawNight(state) {
    const nf = nightFactor(state.clock.hour);
    if (nf <= 0.02) return;
    rect(camera.x, camera.y, view.vw, view.vh, `rgba(8,12,38,${(nf * 0.34).toFixed(3)})`);
    context.save();
    context.globalCompositeOperation = 'lighter';
    // Streetlight pools.
    for (const prop of state.city.props) {
      if (prop.kind !== 'lamp') continue;
      if (prop.x < camera.x - 90 || prop.x > camera.x + view.vw + 90 || prop.y < camera.y - 90 || prop.y > camera.y + view.vh + 90) continue;
      context.globalAlpha = 0.34 * nf;
      context.drawImage(glow, prop.x - 44, prop.y - 44, 88, 88);
    }
    context.restore();
    context.globalAlpha = 1;
  }

  // -------------------------------------------------------------- HUD
  function drawMinimap(state, mx, my, mw, mh) {
    const sx = mw / WORLD_W;
    const sy = mh / WORLD_H;
    context.save();
    rect(mx, my, mw, mh, 'rgba(10,16,24,0.82)');
    context.beginPath();
    context.rect(mx, my, mw, mh);
    context.clip();
    rect(mx + SAND_X * sx, my, (WORLD_W - SAND_X) * sx, mh, '#1d6f96');
    rect(mx, my, SAND_X * sx, mh, '#484e57');
    context.fillStyle = '#79828d';
    for (let i = 0; i <= GRID.cols; i += 1) context.fillRect(mx + roadX(i) * sx - 1, my, 2, mh);
    for (let j = 0; j < GRID.rows; j += 1) context.fillRect(mx, my + roadY(j) * sy - 1, mw, 2);
    const dot = (x, y, color, r = 3) => {
      context.fillStyle = color;
      context.beginPath();
      context.arc(mx + x * sx, my + y * sy, r, 0, Math.PI * 2);
      context.fill();
    };
    // Fixed places: respray pink, hospital white cross, police blue square.
    const bay = state.city.respray.bay;
    dot(bay.x + bay.w / 2, bay.y + bay.h / 2, '#ff7ad9', 3.4);
    dot(state.city.hospital.door.x, state.city.hospital.door.y, '#ffffff', 3);
    context.fillStyle = '#5aa2ff';
    context.fillRect(mx + state.city.police.door.x * sx - 3, my + state.city.police.door.y * sy - 3, 6, 6);
    const story = state.story;
    if (story && story.marker) {
      const pulse = 3 + Math.sin(state.time * 5) * 1.2;
      dot(story.marker.x, story.marker.y, PALETTE.marker, pulse);
    }
    if (state.taxi.phase === 'dropoff' && state.taxi.dest) dot(state.taxi.dest.x, state.taxi.dest.y, '#7dd069', 3.6);
    if (state.taxi.phase === 'pickup' && state.taxi.ped) dot(state.taxi.ped.x, state.taxi.ped.y, '#7dd069', 3);
    for (const c of state.cars) {
      if (c.driver === 'police' || c.driver === 'policeParked') dot(c.x, c.y, PALETTE.policeBlip, 2.6);
    }
    // The player: a little arrow that turns with him.
    const p = state.player;
    context.save();
    context.translate(mx + p.x * sx, my + p.y * sy);
    context.rotate(p.angle);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(6, 0);
    context.lineTo(-4, -4);
    context.lineTo(-4, 4);
    context.closePath();
    context.fill();
    context.restore();
    context.restore();
    context.strokeStyle = 'rgba(255,255,255,0.35)';
    context.lineWidth = 1.5;
    context.strokeRect(mx, my, mw, mh);
  }

  function bar(x, y, w, h, frac, color, back = 'rgba(10,10,14,0.65)') {
    rect(x, y, w, h, back);
    if (frac > 0) rect(x + 1.5, y + 1.5, (w - 3) * Math.min(1, frac), h - 3, color);
  }

  function drawHud(state, ui) {
    const p = state.player;
    // Top-left: vitals, cash, clock, district — on one frosted glass panel.
    context.fillStyle = 'rgba(8,11,17,0.55)';
    context.beginPath();
    context.roundRect(10, 8, 228, 104, 12);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.14)';
    context.lineWidth = 1;
    context.stroke();
    bar(18, 16, 190, 15, p.health / PLAYER.health, PALETTE.health);
    bar(18, 35, 190, 11, p.armor / PLAYER.armor, PALETTE.armor);
    text('♥', 216, 29, 15, PALETTE.health, 'left', 800);
    const hh = Math.floor(state.clock.hour);
    const mm = Math.floor((state.clock.hour - hh) * 60);
    const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    text(`$${state.cash}`, 18, 78, 27, PALETTE.cash, 'left', 800);
    text(`${clock}  ·  ${state.district}`, 18, 102, 15, PALETTE.text, 'left', 600);
    // Top-right: wanted stars over the minimap.
    const stars = state.wanted.stars;
    for (let i = 0; i < 5; i += 1) {
      const x = view.w - 30 - (4 - i) * 27;
      const flash = stars > 0 && i < stars && state.wanted.seen && Math.floor(state.time * 3) % 2 === 0;
      text('★', x, 34, 24, i < stars ? (flash ? '#ffffff' : PALETTE.star) : PALETTE.starOff, 'center', 800);
    }
    drawMinimap(state, view.w - 218, 46, 200, 148);
    // Bottom-left: weapon or vehicle.
    if (p.car) {
      const names = { sedan: 'PALMIRA SEDAN', sport: 'COMET COUPE', taxi: 'PALMIRA CAB', van: 'BULWARK VAN', police: 'PD INTERCEPTOR', truck: 'HAULER PICKUP' };
      text(names[p.car.kind] || 'CAR', 18, view.h - 44, 16, PALETTE.text, 'left', 700);
      text(`${Math.round(Math.abs(p.car.speed) * 0.14)} km/h`, 18, view.h - 20, 15, PALETTE.muted, 'left', 600);
    } else {
      text('PISTOL', 18, view.h - 44, 16, PALETTE.text, 'left', 700);
      text('Mouse aim · Click/Space fire · F enter car', 18, view.h - 20, 13, PALETTE.muted, 'left', 400);
    }
    if (ui.muted) text('MUTED (M)', view.w - 18, view.h - 16, 13, PALETTE.muted, 'right', 600);
    // The car radio announces itself for a few seconds after Rio gets in.
    if (state.radio && state.time < (state.radioUntil || 0)) {
      const label = `♪ ${state.radio}`;
      const w = label.length * 8.6 + 26;
      context.fillStyle = 'rgba(8,11,17,0.62)';
      context.beginPath();
      context.roundRect(18, view.h - 108, w, 26, 13);
      context.fill();
      text(label, 32, view.h - 90, 13.5, PALETTE.accent, 'left', 700);
    }
    // Objective banner, bottom-centre.
    const story = state.story;
    let objective = '';
    if (story && story.active) objective = story.objective;
    else if (state.taxi.phase === 'pickup') objective = 'Taxi: stop beside the passenger with the ! marker';
    else if (state.taxi.phase === 'dropoff') objective = 'Taxi: drive your passenger to the green marker';
    if (objective) {
      context.fillStyle = 'rgba(10,12,18,0.72)';
      const w = Math.min(720, objective.length * 8.4 + 36);
      context.beginPath();
      context.roundRect((view.w - w) / 2, view.h - 66, w, 34, 9);
      context.fill();
      text(objective, view.w / 2, view.h - 43, 16.5, PALETTE.accent, 'center', 700);
    }
    if (story && story.active && story.timer > 0) {
      text(`${Math.ceil(story.timer)}s`, view.w / 2, 64, 34, story.timer < 12 ? PALETTE.danger : PALETTE.text, 'center', 800);
    }
    // Story banner (mission complete, fares, warnings) as a phone-style popup card: it slides
    // in at the top centre with an app dot, the headline and the detail line.
    if (state.banner.t > 0) {
      const a = Math.min(1, state.banner.t / 0.5);
      const cardW = 470;
      const cardX = (view.w - cardW) / 2;
      context.globalAlpha = a;
      context.fillStyle = 'rgba(11,13,19,0.9)';
      context.beginPath();
      context.roundRect(cardX, 66, cardW, 62, 14);
      context.fill();
      context.strokeStyle = 'rgba(255,255,255,0.16)';
      context.lineWidth = 1;
      context.stroke();
      rect(cardX, 66, 6, 62, PALETTE.accent);
      context.fillStyle = PALETTE.accent;
      context.beginPath();
      context.arc(cardX + 30, 97, 11, 0, Math.PI * 2);
      context.fill();
      text('♪', cardX + 30, 103, 14, '#191408', 'center', 900);
      text(state.banner.title, cardX + 54, 96, 21, PALETTE.text, 'left', 800);
      if (state.banner.sub) text(state.banner.sub, cardX + 54, 118, 14, PALETTE.muted, 'left', 500);
      context.globalAlpha = 1;
    }
    // Bust meter: a filling red bar when the cuffs are coming out.
    if (state.wanted.bust > 0.02) {
      const w = 260;
      rect((view.w - w) / 2, view.h - 108, w, 13, 'rgba(10,10,14,0.7)');
      rect((view.w - w) / 2 + 2, view.h - 106, (w - 4) * state.wanted.bust, 9, PALETTE.danger);
      text('BUSTED?', view.w / 2, view.h - 116, 14, PALETTE.danger, 'center', 800);
    }
    // Crosshair at the mouse when Rio is on foot and armed.
    if (!p.car && ui.mouse) {
      context.strokeStyle = 'rgba(255,255,255,0.85)';
      context.lineWidth = 1.6;
      context.beginPath();
      context.arc(ui.mouse.x, ui.mouse.y, 9, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(ui.mouse.x - 13, ui.mouse.y);
      context.lineTo(ui.mouse.x - 5, ui.mouse.y);
      context.moveTo(ui.mouse.x + 5, ui.mouse.y);
      context.lineTo(ui.mouse.x + 13, ui.mouse.y);
      context.moveTo(ui.mouse.x, ui.mouse.y - 13);
      context.lineTo(ui.mouse.x, ui.mouse.y - 5);
      context.moveTo(ui.mouse.x, ui.mouse.y + 5);
      context.lineTo(ui.mouse.x, ui.mouse.y + 13);
      context.stroke();
    }
  }

  // -------------------------------------------------------------- screens
  function dim(alpha) {
    rect(0, 0, view.w, view.h, `rgba(6,8,14,${alpha})`);
  }
  function menu(items, index, y0) {
    for (let i = 0; i < items.length; i += 1) {
      const y = y0 + i * 44;
      if (i === index) {
        rect(view.w / 2 - 170, y - 27, 340, 38, 'rgba(255,179,71,0.92)');
        text(items[i], view.w / 2, y, 23, '#191408', 'center', 800);
      } else {
        text(items[i], view.w / 2, y, 23, PALETTE.text, 'center', 700);
      }
    }
  }
  function drawTitle(state, ui) {
    dim(0.34);
    const cx = view.w / 2;
    // Sunset grade over the live city: warm at the top, violet at the street, and a low sun
    // burning over the bay on the right — the postcard Palmira sells.
    const sky = context.createLinearGradient(0, 0, 0, view.h);
    sky.addColorStop(0, 'rgba(255,138,76,0.26)');
    sky.addColorStop(0.45, 'rgba(255,94,122,0.10)');
    sky.addColorStop(1, 'rgba(90,50,140,0.20)');
    context.fillStyle = sky;
    context.fillRect(0, 0, view.w, view.h);
    const sunX = view.w * 0.78;
    const sunY = view.h * 0.3;
    const sun = context.createRadialGradient(sunX, sunY, 6, sunX, sunY, 130);
    sun.addColorStop(0, 'rgba(255,224,160,0.95)');
    sun.addColorStop(0.25, 'rgba(255,180,110,0.55)');
    sun.addColorStop(1, 'rgba(255,150,90,0)');
    context.fillStyle = sun;
    context.fillRect(sunX - 130, sunY - 130, 260, 260);
    context.fillStyle = '#ffe9bd';
    context.beginPath();
    context.arc(sunX, sunY, 27, 0, Math.PI * 2);
    context.fill();
    // Logo: a sunset band behind block letters.
    const ly = view.h * 0.3;
    const grad = context.createLinearGradient(cx - 330, ly - 70, cx - 330, ly + 30);
    grad.addColorStop(0, '#ff9a5c');
    grad.addColorStop(0.55, '#ff5e7a');
    grad.addColorStop(1, '#7a4a9e');
    context.fillStyle = grad;
    context.fillRect(cx - 330, ly - 66, 660, 92);
    for (let i = 0; i < 5; i += 1) rect(cx - 330, ly - 40 + i * 15, 660, 5, 'rgba(20,10,30,0.55)');
    text('PALMIRA', cx, ly - 6, 74, '#ffffff', 'center', 900);
    text('H E A T', cx, ly + 62, 40, PALETTE.accent, 'center', 900);
    text('An original open-world crime story — Rio Marino, wheelman for hire.', cx, ly + 96, 16.5, PALETTE.text, 'center', 500);
    menu(ui.items, ui.index, ly + 168);
    text('WASD drive & walk · F enter car · Mouse aim · M mute', cx, view.h - 26, 13.5, PALETTE.muted, 'center', 500);
  }
  function drawHelp(state, ui) {
    dim(0.62);
    const cx = view.w / 2;
    text('HOW TO PLAY', cx, 120, 38, PALETTE.accent, 'center', 900);
    const lines = [
      'Walk: WASD or arrows — hold Shift to run',
      'Enter / exit any car: F or E (stealing in front of witnesses raises your stars)',
      'Drive: W/S accelerate & brake, A/D steer — mind the walls, they bite back',
      'Shoot: mouse to aim, click or Space to fire (on foot only)',
      'Wanted: stars rise with witnessed crime and fall when you break police sight',
      'Busted: if police pin you while you are slow, the meter fills — then it is the cells',
      'Respray: drive into the Shine & Go bay unseen to clear your heat for $400',
      'Work: gold markers are story jobs for Faro; green ones are taxi fares',
      'Pause: P or Esc — save from the pause menu; the story autosaves after each job',
      '',
      'Press Enter to go back',
    ];
    lines.forEach((line, i) => text(line, cx, 176 + i * 30, 17.5, PALETTE.text, 'center', 500));
  }
  function drawBrief(state, ui) {
    dim(0.55);
    const cx = view.w / 2;
    text(ui.title, cx, view.h * 0.3, 36, PALETTE.accent, 'center', 900);
    text(`Reward $${ui.reward}`, cx, view.h * 0.3 + 36, 17, PALETTE.cash, 'center', 700);
    ui.lines.forEach((line, i) => text(line, cx, view.h * 0.3 + 84 + i * 27, 17.5, PALETTE.text, 'center', 500));
    text('Press Enter to take the job', cx, view.h * 0.3 + 84 + ui.lines.length * 27 + 26, 16, PALETTE.muted, 'center', 600);
  }
  function drawPaused(state, ui) {
    dim(0.55);
    text('PAUSED', view.w / 2, view.h * 0.32, 40, PALETTE.text, 'center', 900);
    menu(ui.items, ui.index, view.h * 0.32 + 70);
    const st = state.stats;
    text(`Jobs done ${st.missions} · Fares ${st.fares} · Cars stolen ${st.stolen} · Earned $${st.earned}`, view.w / 2, view.h * 0.32 + 70 + ui.items.length * 44 + 16, 14.5, PALETTE.muted, 'center', 500);
  }
  function drawEnd(state, ui, kind) {
    dim(kind === 'busted' ? 0.45 : 0.6);
    const cx = view.w / 2;
    const cy = view.h * 0.42;
    if (kind === 'busted') {
      // Flashing red/blue wash, jailhouse style.
      const flash = Math.floor(state.time * 2.4) % 2 === 0;
      rect(0, 0, view.w / 2, view.h, flash ? 'rgba(255,40,40,0.13)' : 'rgba(40,80,255,0.13)');
      rect(view.w / 2, 0, view.w / 2, view.h, flash ? 'rgba(40,80,255,0.13)' : 'rgba(255,40,40,0.13)');
      text('BUSTED', cx, cy, 84, '#ffffff', 'center', 900);
      text('The Palmira PD thanks you for stopping.', cx, cy + 44, 18, PALETTE.text, 'center', 500);
    } else {
      text('WASTED', cx, cy, 84, '#e8483f', 'center', 900);
      text('St. Coastal patched you up and sent the bill.', cx, cy + 44, 18, PALETTE.text, 'center', 500);
    }
    text('Press Enter to continue', cx, cy + 92, 17, PALETTE.accent, 'center', 700);
  }

  /** Paint one frame: the world, then the HUD, then the screen's overlay if any. */
  function draw(state, screen, ui) {
    computeCamera(state);
    context.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
    context.save();
    context.translate(-camera.x + state.shakeX, -camera.y + state.shakeY);
    drawGround(state);
    drawSkids(state);
    const story = state.story;
    if (story && story.marker) drawMarker(story.marker.x, story.marker.y, state.time, PALETTE.marker);
    if (state.taxi.phase === 'dropoff' && state.taxi.dest) drawMarker(state.taxi.dest.x, state.taxi.dest.y, state.time, '#7dd069');
    drawPickups(state);
    drawPalms(state, false);
    for (const car of state.cars) {
      if (car.x < camera.x - 130 || car.x > camera.x + view.vw + 130 || car.y < camera.y - 130 || car.y > camera.y + view.vh + 130) continue;
      drawCar(car, state);
    }
    for (const ped of state.peds) drawPed(ped, state);
    drawPlayer(state);
    drawBuildings(state);
    drawPalms(state, true);
    drawEffects(state);
    drawClouds(state);
    drawNight(state);
    context.restore();
    context.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (screen === SCREEN_PLAY || screen === SCREEN_PAUSED) drawHud(state, ui);
    if (screen === SCREEN_TITLE) {
      drawHudTitleless(state);
      drawTitle(state, ui);
    } else if (screen === SCREEN_HELP) drawHelp(state, ui);
    else if (screen === SCREEN_BRIEF) drawBrief(state, ui);
    else if (screen === SCREEN_PAUSED) drawPaused(state, ui);
    else if (screen === SCREEN_BUSTED) drawEnd(state, ui, 'busted');
    else if (screen === SCREEN_WASTED) drawEnd(state, ui, 'wasted');
  }

  // On the title screen the world is the backdrop; a small clock/district tag is all we show.
  function drawHudTitleless(state) {
    const hh = Math.floor(state.clock.hour);
    const mm = Math.floor((state.clock.hour - hh) * 60);
    text(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${state.district}`, 18, view.h - 18, 14, 'rgba(244,241,232,0.8)', 'left', 600);
  }

  return { draw, getCamera: () => camera, getView: () => view };
}
