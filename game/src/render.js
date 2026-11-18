// Palmira, drawn. A single canvas renderer: the world pass (city, traffic, people, the
// chase) under a day/night grade, a light pass that punches lamp pools, headlights and
// neon through the dark, and a frosted-glass HUD with the minimap on top. Everything
// time-based derives from the simulation's own clock and time, so a staged frame renders
// identically every run; decoration randomness comes from its own seeded stream and can
// never touch the simulation.
import {
  BEACH_W, BLOCK, CITY_H, CITY_W, COLS, FONT, LANE, PALETTE, PITCH, ROAD_W, ROWS,
  SIDEWALK, WORLD_H, WORLD_W,
} from './config.js';
import { districtAt, roadX, roadY } from './city.js';
import { clamp, lerp } from './world.js';
import { decorationRandom } from './random.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_HOWTO = 'howto';
export const SCREEN_PLAY = 'play';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_BUSTED = 'busted';
export const SCREEN_WASTED = 'wasted';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    rgbCache.set(hex, c);
  }
  return c;
}
function mix(hexA, hexB, t) {
  const a = rgb(hexA);
  const b = rgb(hexB);
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}
function shade(hex, f) {
  const c = rgb(hex);
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`;
}
function rgba(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
/** Deterministic 0..1 hash for window lighting and other per-building variety. */
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  let lastCam = { x: 0, y: 0, scale: 1 };
  const menuRects = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(320, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(240, Math.floor(window.innerHeight * dpr));
  }
  resize();
  window.addEventListener('resize', resize);

  // Soft radial sprites, tinted per use: lamp pools, headlight glows, cloud shadows.
  function makeGlow(r, g, b) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g2 = c.getContext('2d');
    const grad = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
    grad.addColorStop(0.5, `rgba(${r},${g},${b},0.32)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    g2.fillStyle = grad;
    g2.fillRect(0, 0, 128, 128);
    return c;
  }
  const glowWarm = makeGlow(255, 186, 92);
  const glowWhite = makeGlow(255, 244, 214);
  const glowRed = makeGlow(255, 70, 60);
  const glowBlue = makeGlow(70, 130, 255);
  const glowDark = makeGlow(6, 8, 18);

  // A tile of deterministic speckle, laid over asphalt, concrete and sand.
  const speckle = (() => {
    const c = document.createElement('canvas');
    c.width = 180;
    c.height = 180;
    const g2 = c.getContext('2d');
    const rnd = decorationRandom(99);
    for (let i = 0; i < 620; i += 1) {
      const v = rnd();
      g2.fillStyle = v < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
      g2.fillRect(rnd() * 180, rnd() * 180, 1.6, 1.6);
    }
    return ctx.createPattern(c, 'repeat');
  })();

  // Fixed decoration fields: water sparkles and drifting cloud shadows.
  const deco = decorationRandom(7);
  const sparkles = [];
  for (let i = 0; i < 110; i += 1) {
    sparkles.push({ dx: deco() * WATER_W(), dy: deco() * WORLD_H, ph: deco() * 6.28, len: 6 + deco() * 12 });
  }
  function WATER_W() { return WORLD_W - CITY_W - BEACH_W; }
  const clouds = [];
  for (let i = 0; i < 6; i += 1) {
    clouds.push({ off: deco() * 2400, y: deco() * WORLD_H, r: 240 + deco() * 220, sp: 9 + deco() * 9 });
  }

  const fontCache = new Map();
  function font(size, weight = 600) {
    const key = `${weight}:${size}`;
    let f = fontCache.get(key);
    if (!f) {
      f = `${weight} ${size}px ${FONT}`;
      fontCache.set(key, f);
    }
    return f;
  }
  function text(str, x, y, size, color, align = 'left', weight = 600) {
    ctx.font = font(size, weight);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Time-of-day grading: daylight level, golden-hour warmth, and the sun's shadow throw. */
  function grade(hour, titleScreen) {
    const h = titleScreen ? 17.85 : hour;
    let daylight;
    if (h < 4.8 || h > 20.6) daylight = 0.1;
    else if (h < 7.4) daylight = lerp(0.1, 1, (h - 4.8) / 2.6);
    else if (h < 16.7) daylight = 1;
    else if (h < 19.9) daylight = lerp(1, 0.22, (h - 16.7) / 3.2);
    else daylight = lerp(0.22, 0.1, (h - 19.9) / 0.7);
    const gold = h > 16.4 && h < 20 ? Math.sin(((h - 16.4) / 3.6) * Math.PI) : 0;
    const dawn = h > 5.4 && h < 8 ? Math.sin(((h - 5.4) / 2.6) * Math.PI) * 0.4 : 0;
    return {
      daylight,
      darkness: 1 - daylight,
      gold: Math.max(gold, dawn),
      shadowX: lerp(6, 30, gold),
      shadowY: lerp(12, 7, gold),
    };
  }

  // -------------------------------------------------------------------------
  // World pass
  // -------------------------------------------------------------------------

  function drawGround(state, g, v) {
    const { city } = state;
    // City floor and block bases.
    ctx.fillStyle = PALETTE.sidewalk;
    ctx.fillRect(0, 0, CITY_W, CITY_H);
    for (let i = 0; i < COLS; i += 1) {
      for (let j = 0; j < ROWS; j += 1) {
        const x = roadX(i) + ROAD_W / 2;
        const y = roadY(j) + ROAD_W / 2;
        if (x + BLOCK < v.x0 || x > v.x1 || y + BLOCK < v.y0 || y > v.y1) continue;
        const vary = 0.94 + hash1(i * 31 + j * 57) * 0.1;
        ctx.fillStyle = shade(PALETTE.blockBase, vary);
        ctx.fillRect(x + SIDEWALK, y + SIDEWALK, BLOCK - SIDEWALK * 2, BLOCK - SIDEWALK * 2);
      }
    }
    // Parks: grass with a pale cross of paths.
    for (const p of city.parks) {
      if (p.x + p.w < v.x0 || p.x > v.x1 || p.y + p.h < v.y0 || p.y > v.y1) continue;
      ctx.fillStyle = PALETTE.grass;
      ctx.fillRect(p.x + SIDEWALK, p.y + SIDEWALK, p.w - SIDEWALK * 2, p.h - SIDEWALK * 2);
      ctx.fillStyle = rgba('#e8e0c8', 0.5);
      ctx.fillRect(p.x + p.w / 2 - 5, p.y + SIDEWALK, 10, p.h - SIDEWALK * 2);
      ctx.fillRect(p.x + SIDEWALK, p.y + p.h / 2 - 5, p.w - SIDEWALK * 2, 10);
    }
    // The respray apron: painted concrete with a guide box, so the bay reads at a glance.
    const bay = city.specials.respray.bay;
    ctx.fillStyle = '#7d7f7a';
    ctx.fillRect(bay.x - 8, bay.y - 6, bay.w + 16, bay.h + 12);
    ctx.strokeStyle = rgba(PALETTE.gold, 0.65);
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(bay.x, bay.y, bay.w, bay.h);
    ctx.setLineDash([]);
    // Sand, its wet band, and the animated foam line where the bay takes it back.
    ctx.fillStyle = PALETTE.sand;
    ctx.fillRect(CITY_W, 0, BEACH_W, CITY_H);
    ctx.fillStyle = speckle;
    ctx.fillRect(CITY_W, Math.max(0, v.y0), BEACH_W, Math.min(CITY_H, v.y1) - Math.max(0, v.y0));
    ctx.fillStyle = PALETTE.sandWet;
    ctx.fillRect(CITY_W + BEACH_W - 18, 0, 18, CITY_H);
    // The sea.
    const sea = ctx.createLinearGradient(CITY_W + BEACH_W, 0, WORLD_W, 0);
    sea.addColorStop(0, PALETTE.water);
    sea.addColorStop(1, PALETTE.waterDeep);
    ctx.fillStyle = sea;
    ctx.fillRect(CITY_W + BEACH_W, 0, WORLD_W - CITY_W - BEACH_W, WORLD_H);
    ctx.fillStyle = '#ffffff';
    for (const s of sparkles) {
      const x = CITY_W + BEACH_W + 14 + s.dx;
      const y = s.dy;
      if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
      ctx.globalAlpha = 0.1 + 0.16 * (0.5 + 0.5 * Math.sin(state.time * 1.8 + s.ph));
      ctx.fillRect(x, y, s.len, 1.6);
    }
    ctx.globalAlpha = 1;
    // Foam: a breathing white edge along the shoreline.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    const yStart = Math.max(0, Math.floor(v.y0 / 24) * 24);
    for (let y = yStart; y < Math.min(WORLD_H, v.y1 + 24); y += 24) {
      const x = CITY_W + BEACH_W + Math.sin(state.time * 1.25 + y * 0.02) * 4.5 + Math.sin(y * 0.11) * 2;
      if (y === yStart) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawRoads(state, v) {
    ctx.fillStyle = PALETTE.asphalt;
    for (let i = 0; i <= COLS; i += 1) {
      const x = roadX(i);
      if (x + ROAD_W / 2 < v.x0 || x - ROAD_W / 2 > v.x1) continue;
      ctx.fillRect(x - ROAD_W / 2, Math.max(0, v.y0), ROAD_W, Math.min(CITY_H, v.y1) - Math.max(0, v.y0));
    }
    for (let j = 0; j <= ROWS; j += 1) {
      const y = roadY(j);
      if (y + ROAD_W / 2 < v.y0 || y - ROAD_W / 2 > v.y1) continue;
      ctx.fillRect(Math.max(0, v.x0), y - ROAD_W / 2, Math.min(CITY_W, v.x1) - Math.max(0, v.x0), ROAD_W);
    }
    ctx.fillStyle = speckle;
    for (let i = 0; i <= COLS; i += 1) {
      const x = roadX(i);
      if (x + ROAD_W / 2 < v.x0 || x - ROAD_W / 2 > v.x1) continue;
      ctx.fillRect(x - ROAD_W / 2, Math.max(0, v.y0), ROAD_W, Math.min(CITY_H, v.y1) - Math.max(0, v.y0));
    }
    // Curbs.
    ctx.fillStyle = PALETTE.curb;
    for (let i = 0; i <= COLS; i += 1) {
      const x = roadX(i);
      if (x + ROAD_W / 2 < v.x0 || x - ROAD_W / 2 > v.x1) continue;
      ctx.fillRect(x - ROAD_W / 2, Math.max(0, v.y0), 2.5, Math.min(CITY_H, v.y1) - Math.max(0, v.y0));
      ctx.fillRect(x + ROAD_W / 2 - 2.5, Math.max(0, v.y0), 2.5, Math.min(CITY_H, v.y1) - Math.max(0, v.y0));
    }
    // Centre double-yellow and lane dashes, drawn segment by segment between junctions.
    for (let i = 0; i <= COLS; i += 1) {
      const x = roadX(i);
      if (x + ROAD_W / 2 < v.x0 || x - ROAD_W / 2 > v.x1) continue;
      for (let j = 0; j < ROWS; j += 1) {
        const y0 = roadY(j) + ROAD_W / 2;
        const y1 = roadY(j + 1) - ROAD_W / 2;
        if (y1 < v.y0 || y0 > v.y1) continue;
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(x - 4.5, y0, 2.4, y1 - y0);
        ctx.fillRect(x + 2.1, y0, 2.4, y1 - y0);
        ctx.fillStyle = 'rgba(240,240,235,0.75)';
        for (let y = y0 + 8; y < y1 - 20; y += 52) {
          ctx.fillRect(x - LANE - 1, y, 2, 24);
          ctx.fillRect(x + LANE - 1, y, 2, 24);
        }
      }
    }
    for (let j = 0; j <= ROWS; j += 1) {
      const y = roadY(j);
      if (y + ROAD_W / 2 < v.y0 || y - ROAD_W / 2 > v.y1) continue;
      for (let i = 0; i < COLS; i += 1) {
        const x0 = roadX(i) + ROAD_W / 2;
        const x1 = roadX(i + 1) - ROAD_W / 2;
        if (x1 < v.x0 || x0 > v.x1) continue;
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(x0, y - 4.5, x1 - x0, 2.4);
        ctx.fillRect(x0, y + 2.1, x1 - x0, 2.4);
        ctx.fillStyle = 'rgba(240,240,235,0.75)';
        for (let x = x0 + 8; x < x1 - 20; x += 52) {
          ctx.fillRect(x, y - LANE - 1, 24, 2);
          ctx.fillRect(x, y + LANE - 1, 24, 2);
        }
      }
    }
    // Crosswalks and stop lines at every junction in view.
    for (let i = 0; i <= COLS; i += 1) {
      for (let j = 0; j <= ROWS; j += 1) {
        const cx = roadX(i);
        const cy = roadY(j);
        if (cx + 70 < v.x0 || cx - 70 > v.x1 || cy + 70 < v.y0 || cy - 70 > v.y1) continue;
        ctx.fillStyle = 'rgba(240,240,235,0.6)';
        for (let sIdx = 0; sIdx < 5; sIdx += 1) {
          const off = -ROAD_W / 2 + 8 + sIdx * 17;
          ctx.fillRect(cx + off, cy - ROAD_W / 2 - 13, 10, 9); // north crossing
          ctx.fillRect(cx + off, cy + ROAD_W / 2 + 4, 10, 9); // south
          ctx.fillRect(cx - ROAD_W / 2 - 13, cy + off, 9, 10); // west
          ctx.fillRect(cx + ROAD_W / 2 + 4, cy + off, 9, 10); // east
        }
        ctx.fillStyle = 'rgba(240,240,235,0.85)';
        ctx.fillRect(cx + 5, cy - ROAD_W / 2 - 19, ROAD_W / 2 - 10, 3.4); // stop lines (right-hand entries)
        ctx.fillRect(cx - ROAD_W / 2 + 5, cy + ROAD_W / 2 + 16, ROAD_W / 2 - 10, 3.4);
        ctx.fillRect(cx - ROAD_W / 2 - 19, cy + 5, 3.4, ROAD_W / 2 - 10);
        ctx.fillRect(cx + ROAD_W / 2 + 16, cy - ROAD_W / 2 + 5, 3.4, ROAD_W / 2 - 10);
      }
    }
  }

  function drawPierAndBoats(state, v) {
    const pier = state.city.specials.pier.rect;
    ctx.fillStyle = 'rgba(8,10,16,0.3)';
    ctx.fillRect(pier.x + 7, pier.y + 9, pier.w, pier.h);
    ctx.fillStyle = '#8a6b46';
    ctx.fillRect(pier.x, pier.y, pier.w, pier.h);
    ctx.strokeStyle = 'rgba(60,40,20,0.5)';
    ctx.lineWidth = 1.4;
    for (let x = pier.x + 14; x < pier.x + pier.w; x += 14) {
      ctx.beginPath();
      ctx.moveTo(x, pier.y + 3);
      ctx.lineTo(x, pier.y + pier.h - 3);
      ctx.stroke();
    }
    ctx.fillStyle = '#5d4630';
    for (let x = pier.x + 8; x < pier.x + pier.w; x += 34) {
      ctx.beginPath();
      ctx.arc(x, pier.y + 6, 3.4, 0, 6.29);
      ctx.arc(x, pier.y + pier.h - 6, 3.4, 0, 6.29);
      ctx.fill();
    }
    for (const boat of state.city.boats) {
      if (boat.x + 60 < v.x0 || boat.x - 60 > v.x1 || boat.y + 60 < v.y0 || boat.y - 60 > v.y1) continue;
      const bob = Math.sin(state.time * 0.9 + boat.phase) * 2.2;
      ctx.save();
      ctx.translate(boat.x, boat.y + bob);
      ctx.rotate(boat.angle + Math.sin(state.time * 0.6 + boat.phase) * 0.02);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, boat.len * 0.72, boat.len * 0.34, 0, 0, 6.29);
      ctx.stroke();
      ctx.fillStyle = 'rgba(8,10,16,0.25)';
      roundRectPath(-boat.len / 2 + 3, -boat.len / 5 + 4, boat.len, boat.len / 2.5, 8);
      ctx.fill();
      const grad = ctx.createLinearGradient(-boat.len / 2, 0, boat.len / 2, 0);
      grad.addColorStop(0, shade(boat.color, 0.75));
      grad.addColorStop(0.5, mix(boat.color, '#ffffff', 0.35));
      grad.addColorStop(1, shade(boat.color, 0.8));
      ctx.fillStyle = grad;
      roundRectPath(-boat.len / 2, -boat.len / 5, boat.len, boat.len / 2.5, 8);
      ctx.fill();
      ctx.fillStyle = '#eef2f0';
      roundRectPath(-boat.len * 0.12, -boat.len / 8, boat.len * 0.3, boat.len / 4, 3);
      ctx.fill();
      ctx.strokeStyle = '#4a4238';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(boat.len * 0.05, 0);
      ctx.lineTo(boat.len * 0.05, -boat.len * 0.42);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBuilding(b, state, g, v, lights) {
    const lift = b.height * 0.55;
    if (b.x + b.w + 40 < v.x0 || b.x - 40 > v.x1 || b.y + b.h + 20 < v.y0 || b.y - lift - 20 > v.y1) return;
    // Soft shadow, thrown by the sun (long and low at golden hour).
    ctx.fillStyle = 'rgba(10,12,20,0.27)';
    ctx.fillRect(b.x + g.shadowX, b.y - lift + g.shadowY, b.w, b.h);
    // The south face: the wall the street actually sees.
    ctx.fillStyle = shade(b.facade, 0.74);
    ctx.fillRect(b.x, b.y + b.h - lift, b.w, lift);
    // Windows on that face: glass by day, warm lamps by night.
    const rowsW = lift > 30 ? 2 : 1;
    const colsW = Math.max(2, Math.floor(b.w / 17));
    for (let rI = 0; rI < rowsW; rI += 1) {
      for (let cI = 0; cI < colsW; cI += 1) {
        const lit = hash1(b.seed + rI * 131 + cI * 17) < 0.5;
        const wx = b.x + 6 + cI * ((b.w - 12) / colsW);
        const wy = b.y + b.h - lift + 5 + rI * (lift / (rowsW + 0.6));
        if (g.darkness > 0.35 && lit) ctx.fillStyle = '#ffd98a';
        else ctx.fillStyle = 'rgba(38,54,72,0.85)';
        ctx.fillRect(wx, wy, 7.5, 5.5);
      }
    }
    // The roof, lifted north by the building's height, with its furniture.
    ctx.fillStyle = b.roof;
    ctx.fillRect(b.x, b.y - lift, b.w, b.h);
    ctx.strokeStyle = rgba('#ffffff', 0.16);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(b.x + 3, b.y - lift + 3, b.w - 6, b.h - 6);
    ctx.fillStyle = rgba('#000000', 0.14);
    ctx.fillRect(b.x + 7, b.y - lift + 7, b.w - 14, b.h - 14);
    for (const rp of b.roofProps) {
      const px = b.x + rp.dx;
      const py = b.y - lift + rp.dy;
      if (rp.kind === 'ac') {
        ctx.fillStyle = '#9aa0a2';
        ctx.fillRect(px, py, rp.w, rp.h);
        ctx.strokeStyle = 'rgba(40,44,48,0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px + rp.w / 2, py + rp.h / 2, Math.min(rp.w, rp.h) / 3, 0, 6.29);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#8d9296';
        ctx.fillRect(px + 3, py + rp.h - 4, 3, 5);
        ctx.fillRect(px + rp.w - 6, py + rp.h - 4, 3, 5);
        ctx.beginPath();
        ctx.ellipse(px + rp.w / 2, py + rp.h / 2, rp.w / 2, rp.h / 2, 0, 0, 6.29);
        ctx.fill();
        ctx.fillStyle = '#767b7f';
        ctx.beginPath();
        ctx.ellipse(px + rp.w / 2, py + rp.h / 2 - 2, rp.w / 2, rp.h / 3.4, 0, 0, 6.29);
        ctx.fill();
      }
    }
    // Storefront: a sign band and a striped awning on the street face.
    if (b.shop) {
      const bandY = b.y + b.h - 14;
      ctx.fillStyle = '#141a24';
      ctx.fillRect(b.x + 2, bandY, b.w - 4, 13);
      text(b.shop.name.toUpperCase(), b.x + b.w / 2, bandY + 10, 8.5, b.shop.neon, 'center', 800);
      const awnY = b.y + b.h - 1;
      for (let ax = b.x + 2; ax < b.x + b.w - 8; ax += 10) {
        ctx.fillStyle = ((ax / 10) | 0) % 2 === 0 ? b.shop.awning : '#efe9da';
        ctx.fillRect(ax, awnY, 10, 6);
      }
      if (g.darkness > 0.3) {
        lights.push({ kind: 'neon', x: b.x + b.w / 2, y: bandY + 6, text: b.shop.name.toUpperCase(), color: b.shop.neon, w: b.w });
      }
    }
    if (b.sign) {
      const label = b.sign;
      ctx.font = font(10.5, 800);
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(16,20,28,0.88)';
      roundRectPath(b.x + b.w / 2 - tw / 2, b.y - lift + 8, tw, 17, 4);
      ctx.fill();
      text(label, b.x + b.w / 2, b.y - lift + 20.5, 10.5, '#f2f0e9', 'center', 800);
    }
  }

  function drawTree(t, state, g) {
    const sway = Math.sin(state.time * 1.25 + t.phase) * 0.07;
    ctx.fillStyle = 'rgba(10,12,20,0.22)';
    ctx.beginPath();
    ctx.ellipse(t.x + g.shadowX * 0.4, t.y + 4, 13 * t.size, 6 * t.size, 0, 0, 6.29);
    ctx.fill();
    ctx.strokeStyle = PALETTE.trunk;
    ctx.lineWidth = 3.4 * t.size;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y + 3);
    ctx.quadraticCurveTo(t.x + sway * 20, t.y - 5, t.x + sway * 34, t.y - 10 * t.size);
    ctx.stroke();
    const topX = t.x + sway * 34;
    const topY = t.y - 10 * t.size;
    ctx.strokeStyle = PALETTE.frond;
    ctx.lineWidth = 3 * t.size;
    for (let k = 0; k < 7; k += 1) {
      const a = (k / 7) * Math.PI * 2 + t.phase + sway;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo(
        topX + Math.cos(a) * 13 * t.size, topY + Math.sin(a) * 7 * t.size - 4,
        topX + Math.cos(a) * 23 * t.size, topY + Math.sin(a) * 12 * t.size + 5,
      );
      ctx.stroke();
    }
    ctx.fillStyle = shade(PALETTE.frond, 1.15);
    ctx.beginPath();
    ctx.arc(topX, topY, 4.4 * t.size, 0, 6.29);
    ctx.fill();
  }

  function drawCar(car, state, g, lights) {
    const spec = car.spec;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    const L = car.len;
    const W = car.wid;
    // Shadow and body.
    ctx.fillStyle = 'rgba(8,10,16,0.3)';
    roundRectPath(-L / 2 + g.shadowX * 0.35, -W / 2 + g.shadowY * 0.35, L, W, 7);
    ctx.fill();
    // Wheels; the front pair turns with the wheel.
    ctx.fillStyle = '#14161a';
    const wy = W / 2 - 1;
    for (const [wx, front] of [[-L * 0.33, false], [L * 0.33, true]]) {
      for (const sideSign of [-1, 1]) {
        ctx.save();
        ctx.translate(wx, sideSign * wy);
        if (front) ctx.rotate(car.steerVis * 0.9);
        roundRectPath(-6.5, -2.8, 13, 5.6, 2);
        ctx.fill();
        ctx.restore();
      }
    }
    // Metallic body: a lengthwise gradient with a bright spine.
    const grad = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    grad.addColorStop(0, shade(car.color, 0.62));
    grad.addColorStop(0.32, mix(car.color, '#ffffff', 0.38));
    grad.addColorStop(0.55, car.color);
    grad.addColorStop(1, shade(car.color, 0.55));
    ctx.fillStyle = grad;
    roundRectPath(-L / 2, -W / 2, L, W, 7);
    ctx.fill();
    if (car.kind === 'police') {
      ctx.fillStyle = '#eef1f4';
      roundRectPath(-L * 0.2, -W / 2 + 1, L * 0.42, W - 2, 4);
      ctx.fill();
      ctx.fillStyle = PALETTE.policeBlue;
      ctx.fillRect(-L * 0.2, -3, L * 0.42, 6);
    }
    if (car.wrecked) {
      ctx.fillStyle = 'rgba(20,18,16,0.4)';
      roundRectPath(-L / 2, -W / 2, L, W, 7);
      ctx.fill();
    }
    // Glass cabin.
    const glass = ctx.createLinearGradient(-L * 0.2, -W / 2, L * 0.25, W / 2);
    glass.addColorStop(0, '#a8d4e6');
    glass.addColorStop(0.5, '#5d84a0');
    glass.addColorStop(1, '#33506a');
    ctx.fillStyle = car.wrecked ? '#3c4650' : glass;
    roundRectPath(-L * 0.17, -W / 2 + 5, L * 0.4, W - 10, 5);
    ctx.fill();
    ctx.fillStyle = rgba(car.roof, 0.92);
    roundRectPath(-L * 0.1, -W / 2 + 8, L * 0.24, W - 16, 4);
    ctx.fill();
    // Type details.
    if (car.type === 'taxi') {
      ctx.fillStyle = '#1c1c1e';
      for (let cxI = -L / 2 + 7; cxI < L / 2 - 12; cxI += 8) {
        if (((cxI / 8) | 0) % 2 === 0) {
          ctx.fillRect(cxI, -W / 2 + 2.5, 6, 4);
          ctx.fillRect(cxI, W / 2 - 6.5, 6, 4);
        }
      }
      ctx.fillStyle = '#ffd94d';
      roundRectPath(-6, -5, 12, 10, 2);
      ctx.fill();
    }
    if (car.type === 'sport') {
      ctx.fillStyle = shade(car.color, 0.6);
      ctx.fillRect(-L / 2 + 1, -W / 2 + 3, 5, W - 6);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(-L * 0.05, -2.2, L * 0.34, 4.4);
    }
    if (car.type === 'armored') {
      ctx.strokeStyle = 'rgba(24,26,30,0.65)';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(-L * 0.42, -W / 2 + 4, L * 0.3, W - 8);
      ctx.fillStyle = 'rgba(24,26,30,0.5)';
      for (let rx = -L * 0.4; rx < -L * 0.14; rx += 9) {
        ctx.beginPath();
        ctx.arc(rx, -W / 2 + 6, 1.4, 0, 6.29);
        ctx.arc(rx, W / 2 - 6, 1.4, 0, 6.29);
        ctx.fill();
      }
    }
    if (car.kind === 'police') {
      const phase = Math.floor(state.time * 2.4 + car.sirenPhase) % 2 === 0;
      ctx.fillStyle = phase ? '#ff4b41' : '#7a1610';
      roundRectPath(-8, -W / 2 + 5, 8, W - 10, 2);
      ctx.fill();
      ctx.fillStyle = phase ? '#1d3f7a' : '#4d7dff';
      roundRectPath(0, -W / 2 + 5, 8, W - 10, 2);
      ctx.fill();
    }
    // Lights: headlights, tail lights, brakes.
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath();
    ctx.arc(L / 2 - 1, -W / 2 + 6, 2.6, 0, 6.29);
    ctx.arc(L / 2 - 1, W / 2 - 6, 2.6, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = car.brakeVis > 0.25 ? '#ff5a4d' : '#a02721';
    ctx.fillRect(-L / 2 - 0.5, -W / 2 + 4, 3, 6);
    ctx.fillRect(-L / 2 - 0.5, W / 2 - 10, 3, 6);
    ctx.restore();
    // Light sources for the night pass.
    if (g.darkness > 0.28) {
      const fx = car.x + Math.cos(car.angle) * (L / 2 + 26);
      const fy = car.y + Math.sin(car.angle) * (L / 2 + 26);
      lights.push({ kind: 'glow', sprite: 'white', x: fx, y: fy, r: 62, a: 0.34 });
      lights.push({ kind: 'cone', x: car.x, y: car.y, angle: car.angle, len: L });
      if (car.brakeVis > 0.25) {
        lights.push({ kind: 'glow', sprite: 'red', x: car.x - Math.cos(car.angle) * L / 2, y: car.y - Math.sin(car.angle) * L / 2, r: 30, a: 0.4 });
      }
      if (car.kind === 'police' && !car.leaveMode) {
        const phase = Math.floor(state.time * 2.4 + car.sirenPhase) % 2 === 0;
        lights.push({ kind: 'glow', sprite: phase ? 'red' : 'blue', x: car.x, y: car.y, r: 74, a: 0.5 });
      }
    }
    void spec;
  }

  function drawPersonBody(x, y, angle, color, skin, opts = {}) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(8,10,16,0.25)';
    ctx.beginPath();
    ctx.ellipse(2.5, 3.5, 8, 4.6, 0, 0, 6.29);
    ctx.fill();
    if (opts.down) {
      ctx.rotate(angle);
      ctx.globalAlpha = opts.alpha ?? 1;
      ctx.fillStyle = color;
      roundRectPath(-11, -4.5, 19, 9, 4);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(11, 0, 4.2, 0, 6.29);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }
    const bob = opts.walkPhase ? Math.sin(opts.walkPhase) * 2.4 : 0;
    ctx.rotate(angle + Math.PI / 2);
    // Legs trail behind the body in its own frame, scissoring with the walk cycle.
    ctx.strokeStyle = 'rgba(30,30,36,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-2, 3);
    ctx.lineTo(-2 + bob * 0.55, 9.5);
    ctx.moveTo(2, 3);
    ctx.lineTo(2 - bob * 0.55, 9.5);
    ctx.stroke();
    ctx.fillStyle = color;
    roundRectPath(-5.5, -6.5 + Math.abs(bob) * 0.24, 11, 12.5, 4.5);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(0, -1.5, 4.3, 0, 6.29);
    ctx.fill();
    ctx.restore();
  }

  function drawWorld(state, g, v, lights) {
    const { city } = state;
    drawGround(state, g, v);
    drawRoads(state, v);
    drawPierAndBoats(state, v);
    // Street lamps: a pole now, a pool of light in the night pass.
    for (const lamp of city.lamps) {
      if (lamp.x < v.x0 || lamp.x > v.x1 || lamp.y < v.y0 || lamp.y > v.y1) continue;
      ctx.fillStyle = '#3c4046';
      ctx.beginPath();
      ctx.arc(lamp.x, lamp.y, 2.6, 0, 6.29);
      ctx.fill();
      if (g.darkness > 0.28) lights.push({ kind: 'glow', sprite: 'warm', x: lamp.x, y: lamp.y, r: 58, a: 0.3 * g.darkness + 0.12 });
    }
    // Props: containers, crates, benches.
    for (const p of city.props) {
      if (p.x + p.w < v.x0 || p.x > v.x1 || p.y + p.h < v.y0 || p.y > v.y1) continue;
      ctx.fillStyle = 'rgba(8,10,16,0.22)';
      ctx.fillRect(p.x + 3, p.y + 4, p.w, p.h);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      if (p.kind === 'container') {
        ctx.strokeStyle = 'rgba(20,22,26,0.4)';
        ctx.lineWidth = 1.4;
        for (let rx = p.x + 8; rx < p.x + p.w - 4; rx += 9) {
          ctx.beginPath();
          ctx.moveTo(rx, p.y + 2);
          ctx.lineTo(rx, p.y + p.h - 2);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(20,22,26,0.55)';
        ctx.strokeRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2);
      } else if (p.kind === 'crate') {
        ctx.strokeStyle = 'rgba(70,50,24,0.6)';
        ctx.lineWidth = 1.3;
        ctx.strokeRect(p.x + 1.5, p.y + 1.5, p.w - 3, p.h - 3);
        ctx.beginPath();
        ctx.moveTo(p.x + 2, p.y + 2);
        ctx.lineTo(p.x + p.w - 2, p.y + p.h - 2);
        ctx.moveTo(p.x + p.w - 2, p.y + 2);
        ctx.lineTo(p.x + 2, p.y + p.h - 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(50,34,18,0.55)';
        ctx.fillRect(p.x + 2, p.y + p.h / 2 - 1, p.w - 4, 2);
      }
    }
    // Buildings, then their green neighbours.
    for (const b of city.buildings) drawBuilding(b, state, g, v, lights);
    for (const t of city.trees) {
      if (t.x + 30 < v.x0 || t.x - 30 > v.x1 || t.y + 30 < v.y0 || t.y - 40 > v.y1) continue;
      drawTree(t, state, g);
    }
    // Skid marks, fading over their sixteen seconds.
    ctx.strokeStyle = '#17181c';
    ctx.lineCap = 'round';
    for (const s of state.skids) {
      if (s.x < v.x0 || s.x > v.x1 || s.y < v.y0 || s.y > v.y1) continue;
      ctx.globalAlpha = 0.36 * clamp(1 - s.age / 16, 0, 1);
      ctx.lineWidth = 4.6;
      const dx = Math.cos(s.angle);
      const dy = Math.sin(s.angle);
      ctx.beginPath();
      ctx.moveTo(s.x - dx * 7, s.y - dy * 7);
      ctx.lineTo(s.x + dx * 7, s.y + dy * 7);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Pickups.
    for (const pk of state.pickups) {
      if (!pk.active) continue;
      const pulse = 1 + Math.sin(state.time * 3.2 + pk.x * 0.05) * 0.1;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, 11 * pulse, 0, 6.29);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,24,30,0.35)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (pk.kind === 'health') {
        ctx.fillStyle = '#d63a32';
        ctx.fillRect(pk.x - 2.6, pk.y - 7, 5.2, 14);
        ctx.fillRect(pk.x - 7, pk.y - 2.6, 14, 5.2);
      } else {
        ctx.fillStyle = PALETTE.policeBlue;
        ctx.beginPath();
        ctx.moveTo(pk.x, pk.y - 7.5);
        ctx.lineTo(pk.x + 6.4, pk.y - 4);
        ctx.lineTo(pk.x + 6.4, pk.y + 2);
        ctx.quadraticCurveTo(pk.x + 6.4, pk.y + 6.4, pk.x, pk.y + 8);
        ctx.quadraticCurveTo(pk.x - 6.4, pk.y + 6.4, pk.x - 6.4, pk.y + 2);
        ctx.lineTo(pk.x - 6.4, pk.y - 4);
        ctx.closePath();
        ctx.fill();
      }
      if (g.darkness > 0.28) lights.push({ kind: 'glow', sprite: 'white', x: pk.x, y: pk.y, r: 30, a: 0.3 });
    }
    // Objective markers: a gold pillar for the story, cyan for a fare.
    const marker = state.objective && state.objective.x !== null
      ? { x: state.objective.x, y: state.objective.y, color: PALETTE.gold }
      : state.taxiObjective
        ? { x: state.taxiObjective.x, y: state.taxiObjective.y, color: '#57d7e8' }
        : null;
    if (marker) {
      const grad = ctx.createLinearGradient(0, marker.y - 130, 0, marker.y);
      grad.addColorStop(0, rgba(marker.color, 0));
      grad.addColorStop(1, rgba(marker.color, 0.5));
      ctx.fillStyle = grad;
      ctx.fillRect(marker.x - 5, marker.y - 130, 10, 130);
      ctx.strokeStyle = rgba(marker.color, 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(marker.x, marker.y, 15 + Math.sin(state.time * 3.4) * 3, 8 + Math.sin(state.time * 3.4) * 1.6, 0, 0, 6.29);
      ctx.stroke();
      const cy = marker.y - 138 + Math.sin(state.time * 4) * 5;
      ctx.fillStyle = marker.color;
      ctx.beginPath();
      ctx.moveTo(marker.x - 9, cy);
      ctx.lineTo(marker.x + 9, cy);
      ctx.lineTo(marker.x, cy + 11);
      ctx.closePath();
      ctx.fill();
    }
    // Vehicles, people, then Rio.
    for (const car of state.cars) {
      if (car.x + 90 < v.x0 || car.x - 90 > v.x1 || car.y + 90 < v.y0 || car.y - 90 > v.y1) continue;
      drawCar(car, state, g, lights);
    }
    for (const ped of state.peds) {
      if (ped.mode === 'gone' || ped.mode === 'passenger') continue;
      if (ped.x + 24 < v.x0 || ped.x - 24 > v.x1 || ped.y + 24 < v.y0 || ped.y - 24 > v.y1) continue;
      if (ped.mode === 'down') {
        drawPersonBody(ped.x, ped.y, ped.angle, ped.color, ped.skin, { down: true, alpha: 0.35 + 0.65 * clamp(ped.downTimer / 6, 0, 1) });
      } else {
        drawPersonBody(ped.x, ped.y, ped.angle, ped.color, ped.skin, { walkPhase: ped.mode === 'walk' || ped.mode === 'flee' || ped.mode === 'toCar' ? ped.walkPhase : 0 });
        if (ped.mode === 'hail') {
          const bobY = ped.y - 24 + Math.sin(state.time * 5) * 2.4;
          ctx.fillStyle = PALETTE.gold;
          ctx.beginPath();
          ctx.arc(ped.x, bobY, 7.5, 0, 6.29);
          ctx.fill();
          text('!', ped.x, bobY + 3.6, 10, '#1c1c1e', 'center', 800);
        }
      }
    }
    for (const o of state.officers) {
      drawPersonBody(o.x, o.y, o.angle, '#274b8f', '#c68863', { walkPhase: o.walkPhase });
      ctx.fillStyle = '#16294d';
      ctx.beginPath();
      ctx.arc(o.x, o.y - 1.5, 4.6, 0, Math.PI, true);
      ctx.fill();
    }
    const p = state.player;
    if (!p.car) {
      drawPersonBody(p.x, p.y, p.angle, '#0e7c86', '#c68863', { walkPhase: p.walkPhase });
      // The pistol arm and, for a few frames after a shot, the muzzle flash.
      const gx = p.x + Math.cos(p.angle) * 13;
      const gy = p.y + Math.sin(p.angle) * 13;
      ctx.strokeStyle = '#22242a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(gx, gy);
      ctx.stroke();
      if (p.muzzle > 0) {
        const fx = p.x + Math.cos(p.angle) * 19;
        const fy = p.y + Math.sin(p.angle) * 19;
        ctx.strokeStyle = '#ffe9a3';
        ctx.lineWidth = 2;
        for (let k = 0; k < 4; k += 1) {
          const a = p.angle + (k - 1.5) * 0.4;
          ctx.beginPath();
          ctx.moveTo(fx, fy);
          ctx.lineTo(fx + Math.cos(a) * 9, fy + Math.sin(a) * 9);
          ctx.stroke();
        }
        if (g.darkness > 0.28) lights.push({ kind: 'glow', sprite: 'warm', x: fx, y: fy, r: 34, a: 0.55 });
      }
    }
    // Particles last: tracers, sparks, smoke, sparkle.
    for (const pt of state.particles) {
      const a = clamp(pt.life / pt.max, 0, 1);
      if (pt.tracer) {
        ctx.strokeStyle = pt.color;
        ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pt.x - pt.vx * 0.03, pt.y - pt.vy * 0.03);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      } else if (pt.size > 4) {
        // Smoke: a soft puff that swells as it thins.
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = a * 0.3;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * (1.7 - a * 0.7), 0, 6.29);
        ctx.fill();
      } else {
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(0.6, pt.size * a), 0, 6.29);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    // Cloud shadows drift over everything, slow and huge.
    for (const c of clouds) {
      const cx = ((state.time * c.sp + c.off) % (WORLD_W + 900)) - 450;
      if (cx + c.r < v.x0 || cx - c.r > v.x1 || c.y + c.r < v.y0 || c.y - c.r > v.y1) continue;
      ctx.globalAlpha = 0.13;
      ctx.drawImage(glowDark, cx - c.r, c.y - c.r * 0.62, c.r * 2, c.r * 1.24);
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Light pass: drawn additively over the night grade.
  // -------------------------------------------------------------------------

  function drawLights(state, g, lights) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      if (L.kind === 'glow') {
        const spr = L.sprite === 'warm' ? glowWarm : L.sprite === 'red' ? glowRed : L.sprite === 'blue' ? glowBlue : glowWhite;
        ctx.globalAlpha = L.a;
        ctx.drawImage(spr, L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
      } else if (L.kind === 'cone') {
        ctx.save();
        ctx.translate(L.x, L.y);
        ctx.rotate(L.angle);
        const gr = ctx.createLinearGradient(L.len / 2, 0, L.len / 2 + 105, 0);
        gr.addColorStop(0, 'rgba(255,240,200,0.17)');
        gr.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.moveTo(L.len / 2, -7);
        ctx.lineTo(L.len / 2 + 105, -28);
        ctx.lineTo(L.len / 2 + 105, 28);
        ctx.lineTo(L.len / 2, 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else if (L.kind === 'neon') {
        ctx.globalAlpha = 0.95;
        ctx.font = font(8.5, 800);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor = L.color;
        ctx.shadowBlur = 13;
        ctx.fillStyle = L.color;
        ctx.fillText(L.text, L.x, L.y + 3.5);
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    void state;
    void g;
  }

  // -------------------------------------------------------------------------
  // HUD (drawn in CSS pixels)
  // -------------------------------------------------------------------------

  function frosted(x, y, w, h, r = 12) {
    roundRectPath(x, y, w, h, r);
    ctx.fillStyle = 'rgba(10,14,22,0.58)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRectPath(x + 1, y + 1, w - 2, h * 0.42, r);
    ctx.fill();
  }

  function starPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const rad = i % 2 === 0 ? r : r * 0.45;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function wrap(str, maxW, size, weight = 500) {
    ctx.font = font(size, weight);
    const words = String(str).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function clockText(clock) {
    const hh = Math.floor(clock) % 24;
    const mm = Math.floor((clock - Math.floor(clock)) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function drawMinimap(state, x, y) {
    const MW = 188;
    const MH = 132;
    const sx = MW / WORLD_W;
    const sy = MH / WORLD_H;
    frosted(x, y, MW, MH, 10);
    ctx.save();
    roundRectPath(x + 3, y + 3, MW - 6, MH - 6, 8);
    ctx.clip();
    ctx.fillStyle = '#232a26';
    ctx.fillRect(x + 3, y + 3, MW - 6, MH - 6);
    ctx.fillStyle = '#2e6d8c';
    ctx.fillRect(x + (CITY_W + BEACH_W) * sx, y, (WORLD_W - CITY_W - BEACH_W) * sx, MH);
    ctx.fillStyle = '#c9ab72';
    ctx.fillRect(x + CITY_W * sx, y, BEACH_W * sx, MH);
    ctx.strokeStyle = 'rgba(235,235,230,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= COLS; i += 1) {
      ctx.moveTo(x + roadX(i) * sx, y + 3);
      ctx.lineTo(x + roadX(i) * sx, y + MH - 3);
    }
    for (let j = 0; j <= ROWS; j += 1) {
      ctx.moveTo(x + 3, y + roadY(j) * sy);
      ctx.lineTo(x + MW - 3, y + roadY(j) * sy);
    }
    ctx.stroke();
    const dot = (wx, wy, color, r = 3) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + wx * sx, y + wy * sy, r, 0, 6.29);
      ctx.fill();
    };
    const sp = state.city.specials;
    dot(sp.respray.bay.x + sp.respray.bay.w / 2, sp.respray.bay.y + sp.respray.bay.h / 2, '#51d88a', 3.2);
    dot(sp.pd.door.x, sp.pd.door.y, '#6ea8ff', 3);
    dot(sp.hospital.door.x, sp.hospital.door.y, '#ff7a72', 3);
    const flash = Math.floor(state.time * 2.2) % 2 === 0;
    for (const car of state.cars) {
      if (car.kind !== 'police' || car.leaveMode) continue;
      dot(car.x, car.y, flash ? '#ff5a4d' : '#4d7dff', 2.6);
    }
    if (state.taxiObjective) dot(state.taxiObjective.x, state.taxiObjective.y, '#57d7e8', 3.2);
    if (state.objective && state.objective.x !== null) {
      dot(state.objective.x, state.objective.y, PALETTE.gold, 3.6 + Math.sin(state.time * 4) * 0.9);
    }
    // Rio's arrow.
    const pp = state.player.car ? { x: state.player.car.x, y: state.player.car.y, a: state.player.car.angle } : { x: state.player.x, y: state.player.y, a: state.player.angle };
    ctx.save();
    ctx.translate(x + pp.x * sx, y + pp.y * sy);
    ctx.rotate(pp.a);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(10,12,16,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4.4, -3.8);
    ctx.lineTo(-4.4, 3.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    text('PALMIRA', x + MW - 8, y + MH - 7, 7.5, 'rgba(240,240,235,0.55)', 'right', 700);
  }

  function drawHUD(state, ui, W, H) {
    const p = state.player;
    // Top-left: who Rio is, how he is doing, what he is worth.
    frosted(14, 12, 238, 94);
    text('RIO MARINO', 26, 31, 10, PALETTE.hudMuted, 'left', 800);
    text(districtAt(p.car ? p.car.x : p.x, p.car ? p.car.y : p.y).toUpperCase(), 240, 31, 9.5, PALETTE.gold, 'right', 700);
    // Health.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRectPath(26, 40, 150, 10, 5);
    ctx.fill();
    const hp = clamp(p.health / 100, 0, 1);
    ctx.fillStyle = hp > 0.3 ? '#51d88a' : PALETTE.danger;
    if (hp > 0) {
      roundRectPath(26, 40, 150 * hp, 10, 5);
      ctx.fill();
    }
    text('HP', 182, 49, 9, PALETTE.hudMuted, 'left', 700);
    // Armor.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRectPath(26, 55, 150, 7, 3.5);
    ctx.fill();
    const ap = clamp(p.armor / 100, 0, 1);
    if (ap > 0) {
      ctx.fillStyle = '#7aa2d8';
      roundRectPath(26, 55, 150 * ap, 7, 3.5);
      ctx.fill();
    }
    text('ARMOR', 182, 62, 8, PALETTE.hudMuted, 'left', 700);
    text(`$${Math.max(0, Math.floor(state.cash)).toLocaleString('en-US')}`, 26, 92, 19, '#7ee787', 'left', 800);
    text(clockText(state.clock), 240, 92, 16, PALETTE.hudText, 'right', 700);
    // Top-right: the law's opinion of Rio, as stars.
    for (let i = 0; i < 5; i += 1) {
      const cx = W - 26 - (4 - i) * 27;
      starPath(cx, 30, 11);
      if (i < state.stars) {
        ctx.fillStyle = PALETTE.gold;
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (state.bust > 0.02) {
      const bw = 138;
      text('BUSTED', W - 14, 56, 9, PALETTE.danger, 'right', 800);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      roundRectPath(W - 14 - bw, 62, bw, 8, 4);
      ctx.fill();
      ctx.fillStyle = PALETTE.danger;
      roundRectPath(W - 14 - bw, 62, bw * clamp(state.bust, 0, 1), 8, 4);
      ctx.fill();
    }
    // Objective banner, top-centre.
    const obj = state.objective;
    const taxiObj = !obj && state.taxiObjective ? state.taxiObjective : null;
    if (obj || taxiObj) {
      const target = obj || taxiObj;
      const pp = p.car ? { x: p.car.x, y: p.car.y } : { x: p.x, y: p.y };
      let label = target.text;
      if (target.x !== null && target.x !== undefined) {
        const d = Math.hypot(target.x - pp.x, target.y - pp.y);
        label += `  ·  ${Math.max(0, Math.round(d / 9))}m`;
      }
      ctx.font = font(13, 700);
      const tw = ctx.measureText(label).width + 34;
      frosted(W / 2 - tw / 2, 12, tw, 32, 16);
      ctx.fillStyle = obj ? PALETTE.gold : '#57d7e8';
      ctx.beginPath();
      ctx.arc(W / 2 - tw / 2 + 15, 28, 4.4, 0, 6.29);
      ctx.fill();
      text(label, W / 2 - tw / 2 + 26, 32.5, 13, PALETTE.hudText, 'left', 700);
    }
    // Phone popups from Faro, stacked under the stars.
    let py = 84;
    for (const pop of state.popups) {
      const lines = wrap(pop.text, 218, 11.5, 500).slice(0, 3);
      const cardH = 30 + lines.length * 14.5;
      const age = pop.max - pop.ttl;
      const slide = age < 0.22 ? (1 - age / 0.22) * 38 : 0;
      const alpha = clamp(pop.ttl / 0.6, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      const cx = W - 14 - 252 + slide;
      frosted(cx, py, 252, cardH, 12);
      ctx.strokeStyle = PALETTE.gold;
      ctx.lineWidth = 1.4;
      roundRectPath(cx + 10, py + 9, 10, 17, 3);
      ctx.stroke();
      text(pop.from.toUpperCase(), cx + 28, py + 21, 10.5, PALETTE.gold, 'left', 800);
      text('now', cx + 240, py + 21, 9, PALETTE.hudMuted, 'right', 600);
      lines.forEach((line, li) => text(line, cx + 12, py + 40 + li * 14.5, 11.5, PALETTE.hudText, 'left', 500));
      ctx.restore();
      py += cardH + 8;
    }
    // Centre banner: mission complete, story beats.
    if (state.banner) {
      const b = state.banner;
      const fadeIn = clamp((b.max - b.ttl) / 0.25, 0, 1);
      const fadeOut = clamp(b.ttl / 0.5, 0, 1);
      ctx.save();
      ctx.globalAlpha = Math.min(fadeIn, fadeOut);
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 14;
      text(b.title, W / 2, H * 0.3, 31, '#ffffff', 'center', 800);
      ctx.shadowBlur = 0;
      if (b.sub) text(b.sub, W / 2, H * 0.3 + 24, 14.5, PALETTE.gold, 'center', 700);
      ctx.restore();
    }
    // Radio pill, bottom-centre, while the station name is fresh.
    if (state.radio) {
      const label = `♪  ${state.radio.name}`;
      ctx.font = font(12.5, 700);
      const tw = ctx.measureText(label).width + 26;
      ctx.save();
      ctx.globalAlpha = clamp(state.radio.ttl / 0.5, 0, 1);
      frosted(W / 2 - tw / 2, H - 52, tw, 28, 14);
      text(label, W / 2, H - 33.5, 12.5, PALETTE.hudText, 'center', 700);
      ctx.restore();
    }
    drawMinimap(state, 14, H - 146);
    // Bottom-right: the weapon, or the machine Rio is sitting in.
    frosted(W - 204, H - 66, 190, 52);
    if (p.car) {
      text(p.car.spec.name.toUpperCase(), W - 192, H - 44, 11, PALETTE.hudMuted, 'left', 800);
      text(`${Math.round(Math.abs(p.car.speed) * 0.32)} km/h`, W - 192, H - 22, 17, PALETTE.hudText, 'left', 700);
      text('F — EXIT', W - 26, H - 22, 9.5, PALETTE.hudMuted, 'right', 700);
    } else {
      text('PISTOL', W - 192, H - 44, 11, PALETTE.hudMuted, 'left', 800);
      text('Click / Space — fire', W - 192, H - 22, 12, PALETTE.hudText, 'left', 600);
    }
    if (ui.muted) text('SOUND OFF (M)', W - 16, 56 + (state.bust > 0.02 ? 22 : 0), 9, PALETTE.hudMuted, 'right', 700);
    // Crosshair, only when Rio is on foot and the scene is live.
    if (!p.car && ui.mouse && ui.screen === SCREEN_PLAY) {
      const mx = ui.mouse.x;
      const my = ui.mouse.y;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(mx, my, 7, 0, 6.29);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(mx - 1, my - 1, 2, 2);
    }
    // A whisper of controls along the bottom.
    text(p.car ? 'W A S D drive · Shift — · F exit' : 'W A S D move · Shift run · F enter car · Esc pause', W / 2, H - 8, 10, 'rgba(240,240,235,0.5)', 'center', 500);
  }

  // -------------------------------------------------------------------------
  // Screens (CSS pixels)
  // -------------------------------------------------------------------------

  function drawMenu(ui, cx, y0) {
    const items = ui.menuItems || [];
    items.forEach((label, i) => {
      const y = y0 + i * 38;
      const selected = i === (ui.menuSelected || 0);
      if (selected) {
        ctx.fillStyle = PALETTE.gold;
        ctx.fillRect(cx - 118, y - 16, 4, 22);
      }
      text(label, cx - 102, y, selected ? 17.5 : 16, selected ? '#ffffff' : 'rgba(235,235,228,0.72)', 'left', selected ? 800 : 600);
      menuRects.push({ x: cx - 122, y: y - 24, w: 244, h: 32, index: i });
    });
  }

  function drawTitle(state, ui, W, H) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(26,10,40,0.34)');
    grad.addColorStop(0.42, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(8,4,18,0.66)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 5;
    try { ctx.letterSpacing = '7px'; } catch { /* older engines */ }
    text('PALMIRA', W / 2, H * 0.3, 64, '#ffffff', 'center', 800);
    ctx.restore();
    const heat = ctx.createLinearGradient(W / 2 - 130, 0, W / 2 + 130, 0);
    heat.addColorStop(0, '#ffd98a');
    heat.addColorStop(0.5, '#ff7a59');
    heat.addColorStop(1, '#e5484d');
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 16;
    try { ctx.letterSpacing = '30px'; } catch { /* older engines */ }
    ctx.font = font(58, 800);
    ctx.textAlign = 'center';
    ctx.fillStyle = heat;
    ctx.fillText('HEAT', W / 2 + 15, H * 0.3 + 62);
    ctx.restore();
    text('Steal it. Run it. Survive it.', W / 2, H * 0.3 + 92, 14.5, 'rgba(255,240,220,0.88)', 'center', 600);
    drawMenu(ui, W / 2 - 60, H * 0.58);
    text('A top-down open world · keyboard + mouse · M — sound', W / 2, H - 18, 11, 'rgba(240,240,235,0.55)', 'center', 500);
    void state;
  }

  const HOWTO_LINES = [
    ['Move / drive', 'W A S D or arrow keys'],
    ['Run', 'Shift'],
    ['Enter / exit a car', 'F or E — any car, parked or not'],
    ['Fire the pistol', 'Mouse click or Space, aimed at the cursor'],
    ['Pause', 'Esc or P · Sound on/off: M'],
    ['', ''],
    ['The law', 'Crimes seen by witnesses raise your stars, 0 to 5.'],
    ['', 'Lose the heat and it fades. Get cornered slow and you are BUSTED.'],
    ['Respray', 'Drive into the Shine & Go bay unseen — $400 wipes the slate.'],
    ['Work', 'Follow Faro\u2019s messages through five jobs, then run taxi fares.'],
    ['Survive', 'Health at St. Azure Hospital, armor at the PD and the pier.'],
    ['Saving', 'The game autosaves after every job. Continue from the title.'],
  ];

  function drawHowto(W, H) {
    ctx.fillStyle = 'rgba(5,7,12,0.68)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.min(580, W - 40);
    const ph = 430;
    const x = W / 2 - pw / 2;
    const y = H / 2 - ph / 2;
    frosted(x, y, pw, ph, 16);
    text('HOW TO PLAY', W / 2, y + 42, 20, PALETTE.gold, 'center', 800);
    HOWTO_LINES.forEach(([k, val], i) => {
      const ly = y + 78 + i * 26;
      if (k) text(k, x + 34, ly, 13, PALETTE.hudMuted, 'left', 700);
      if (val) text(val, x + 190, ly, 13, PALETTE.hudText, 'left', 500);
    });
    text('Enter or Esc — back', W / 2, y + ph - 18, 12, 'rgba(240,240,235,0.6)', 'center', 600);
  }

  function drawPaused(state, ui, W, H) {
    ctx.fillStyle = 'rgba(5,7,12,0.5)';
    ctx.fillRect(0, 0, W, H);
    text('PAUSED', W / 2, H * 0.34, 30, '#ffffff', 'center', 800);
    drawMenu(ui, W / 2 - 60, H * 0.44);
    void state;
  }

  function drawEndScreen(state, ui, W, H, busted) {
    if (busted) {
      const flash = Math.floor(state.time * 2.2) % 2 === 0;
      ctx.fillStyle = flash ? 'rgba(255,60,50,0.1)' : 'rgba(60,110,255,0.1)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = 'rgba(28,2,4,0.46)';
      ctx.fillRect(0, 0, W, H);
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 18;
    try { ctx.letterSpacing = '9px'; } catch { /* older engines */ }
    text(busted ? 'BUSTED' : 'WASTED', W / 2, H * 0.42, 56, busted ? '#ff6b61' : '#e5534b', 'center', 800);
    ctx.restore();
    if (ui.fineText) text(ui.fineText, W / 2, H * 0.42 + 34, 15, PALETTE.hudText, 'center', 600);
    const blink = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(state.time * 3.2));
    ctx.globalAlpha = blink;
    text('Press Enter — back on the street', W / 2, H * 0.42 + 66, 13, 'rgba(240,240,235,0.85)', 'center', 600);
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  function draw(state, screen, ui = {}) {
    const W = canvas.width;
    const H = canvas.height;
    const g = grade(state.clock, screen === SCREEN_TITLE);
    const cam = state.camera;
    const scale = (H / 820) * cam.zoom;
    const shakeX = state.shake > 0 ? Math.sin(state.time * 91.7) * state.shake * 3.4 : 0;
    const shakeY = state.shake > 0 ? Math.cos(state.time * 83.3) * state.shake * 3.4 : 0;
    lastCam = { x: cam.x, y: cam.y, scale };
    const v = {
      x0: cam.x - W / scale / 2 - 80,
      x1: cam.x + W / scale / 2 + 80,
      y0: cam.y - H / scale / 2 - 80,
      y1: cam.y + H / scale / 2 + 80,
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d3247';
    ctx.fillRect(0, 0, W, H);
    const lights = [];
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cam.x + shakeX, -cam.y + shakeY);
    drawWorld(state, g, v, lights);
    ctx.restore();
    if (g.darkness > 0.02) {
      ctx.fillStyle = `rgba(9,13,44,${(g.darkness * 0.44).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (g.gold > 0.02) {
      ctx.fillStyle = `rgba(255,116,32,${(g.gold * 0.15).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (lights.length) {
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      ctx.translate(-cam.x + shakeX, -cam.y + shakeY);
      drawLights(state, g, lights);
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = W / dpr;
    const ch = H / dpr;
    menuRects.length = 0;
    const uiFull = { ...ui, screen };
    if (screen !== SCREEN_TITLE && screen !== SCREEN_HOWTO) drawHUD(state, uiFull, cw, ch);
    if (screen === SCREEN_TITLE) drawTitle(state, uiFull, cw, ch);
    else if (screen === SCREEN_HOWTO) drawHowto(cw, ch);
    else if (screen === SCREEN_PAUSED) drawPaused(state, uiFull, cw, ch);
    else if (screen === SCREEN_BUSTED) drawEndScreen(state, uiFull, cw, ch, true);
    else if (screen === SCREEN_WASTED) drawEndScreen(state, uiFull, cw, ch, false);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** World coordinates under a CSS-pixel point (for mouse aim). */
  function toWorld(cssX, cssY) {
    return {
      x: lastCam.x + (cssX * dpr - canvas.width / 2) / lastCam.scale,
      y: lastCam.y + (cssY * dpr - canvas.height / 2) / lastCam.scale,
    };
  }

  return { draw, toWorld, menuRects, resize };
}
