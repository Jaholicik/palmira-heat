// Palmira Heat — boot and the live loop. Two modes share this file: the screenshot mode
// (?shot=<name>&seed=N) stages a scene through the real simulation and renders it for
// the capture, and the live game — title, play, pause, BUSTED and WASTED — running the
// same fixed-step simulation behind the renderer, with sound and saving wired to its
// events.
import { BUST_FINE, SAVE_KEY, STEP, WASTED_FEE } from './config.js';
import { createRandom } from './random.js';
import {
  createWorld, EVENT_BUSTED, EVENT_CASH, EVENT_CRIME, EVENT_ENTER_CAR, EVENT_OFFICER_SHOT,
  EVENT_PICKUP, EVENT_SHOT, EVENT_WASTED,
} from './world.js';
import { createMissions, EVENT_JINGLE } from './missions.js';
import {
  createRenderer, SCREEN_BUSTED, SCREEN_HOWTO, SCREEN_PAUSED, SCREEN_PLAY, SCREEN_TITLE,
  SCREEN_WASTED,
} from './render.js';
import { ACTION_CONFIRM, ACTION_INTERACT, ACTION_MUTE, ACTION_PAUSE, createInput } from './input.js';
import { createAudio } from './audio.js';
import { stageShot } from './shots.js';

const canvas = document.getElementById('game');
const status = document.getElementById('status');
const params = new URLSearchParams(window.location.search);
const shotName = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') || '', 10);
const seed = Number.isFinite(seedParam) ? seedParam : Math.floor(Math.random() * 1e9);

const world = createWorld(createRandom(seed));
const renderer = createRenderer(canvas);
const audio = createAudio();
let missions = createMissions();

// ---------------------------------------------------------------------------
// Saving: cash, story progress, position and stats, in localStorage.
// ---------------------------------------------------------------------------

function readSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.world || !data.missions) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSave() {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify({
      world: world.getSaveData(),
      missions: missions.snapshot(),
    }));
  } catch { /* a full or blocked store is not worth a crash */ }
}

let hasSave = readSave() !== null;

// ---------------------------------------------------------------------------
// Screenshot mode: stage the scene, draw it twice, say when it is ready.
// ---------------------------------------------------------------------------

if (shotName) {
  const scene = stageShot(shotName, world, missions);
  const shotUi = shotName === 'start'
    ? { menuItems: ['New Game', 'How to Play'], menuSelected: 0 }
    : shotName === 'end'
      ? { fineText: `Fine $${BUST_FINE} — released outside Palmira PD` }
      : {};
  const drawShot = () => renderer.draw(world.state, scene.screen, shotUi);
  requestAnimationFrame(() => {
    drawShot();
    requestAnimationFrame(() => {
      drawShot();
      window.__shotReady = true;
    });
  });
} else {
  // -------------------------------------------------------------------------
  // The live game.
  // -------------------------------------------------------------------------
  const input = createInput(canvas);
  let screen = SCREEN_TITLE;
  let menuSelected = 0;
  let fineText = '';
  let last = performance.now();
  let acc = 0;
  const MAX_FRAME = 0.25;

  function announce(message) {
    if (status) status.textContent = message;
  }

  function titleItems() {
    const items = [{ label: 'New Game', act: 'new' }];
    if (hasSave) items.push({ label: 'Continue', act: 'continue' });
    items.push({ label: 'How to Play', act: 'howto' });
    return items;
  }

  function pauseItems() {
    return [
      { label: 'Resume', act: 'resume' },
      { label: 'Save Game', act: 'save' },
      { label: 'Restart Story', act: 'restart' },
      { label: 'Quit to Title', act: 'title' },
    ];
  }

  function newGame() {
    world.reset();
    missions = createMissions();
    screen = SCREEN_PLAY;
    menuSelected = 0;
    announce('New game. Rio is back in Palmira.');
  }

  function continueGame() {
    const save = readSave();
    if (!save) return;
    world.reset();
    world.loadSaveData(save.world);
    missions = createMissions();
    missions.applySave(save.missions);
    screen = SCREEN_PLAY;
    menuSelected = 0;
    announce('Welcome back to Palmira.');
  }

  function enterEndScreen(kind) {
    missions.onGameOver(world);
    if (kind === 'busted') {
      world.state.cash = Math.max(0, world.state.cash - BUST_FINE);
      fineText = `Fine $${BUST_FINE} — released outside Palmira PD`;
      screen = SCREEN_BUSTED;
      announce('Busted. The Palmira PD takes its fine and lets Rio walk.');
    } else {
      world.state.cash = Math.max(0, world.state.cash - WASTED_FEE);
      fineText = `Hospital bill $${WASTED_FEE} — St. Azure patched Rio up`;
      screen = SCREEN_WASTED;
      announce('Wasted. Rio wakes up at St. Azure Hospital, lighter in the wallet.');
    }
  }

  /** Menu navigation for the current screen; returns true when a menu consumed the frame. */
  function runMenu(items, actions) {
    const nav = input.takeNav();
    if (nav !== 0) {
      menuSelected = (menuSelected + nav + items.length) % items.length;
      audio.click();
    }
    const hover = renderer.menuRects.find((r) => input.mouse.x >= r.x && input.mouse.x <= r.x + r.w
      && input.mouse.y >= r.y && input.mouse.y <= r.y + r.h);
    if (hover && hover.index !== menuSelected) menuSelected = hover.index;
    if (actions & ACTION_CONFIRM) {
      const item = items[hover ? hover.index : menuSelected];
      if (item) activate(item.act);
      return true;
    }
    return false;
  }

  function activate(act) {
    audio.click();
    if (screen === SCREEN_TITLE) {
      if (act === 'new') newGame();
      else if (act === 'continue') continueGame();
      else if (act === 'howto') {
        screen = SCREEN_HOWTO;
        announce('How to play.');
      }
    } else if (screen === SCREEN_PAUSED) {
      if (act === 'resume') {
        screen = SCREEN_PLAY;
        announce('Back on the street.');
      } else if (act === 'save') {
        writeSave();
        hasSave = true;
        announce('Game saved.');
      } else if (act === 'restart') newGame();
      else if (act === 'title') {
        screen = SCREEN_TITLE;
        menuSelected = 0;
        announce('Palmira Heat.');
      }
    }
  }

  function playStep(actions) {
    const ax = input.axes();
    const driving = !!world.state.player.car;
    const aim = renderer.toWorld(input.mouse.x, input.mouse.y);
    const ctrl = {
      mx: ax.x,
      my: driving ? -ax.y : ax.y,
      run: input.run(),
      interact: !!(actions & ACTION_INTERACT),
      fire: input.fire(),
      aimX: aim.x,
      aimY: aim.y,
    };
    let ev = world.step(STEP, ctrl);
    const mres = missions.update(world, STEP);
    ev |= mres.events;
    if (ev & EVENT_SHOT) audio.shot();
    if (ev & EVENT_OFFICER_SHOT) audio.officerShot();
    if (ev & EVENT_PICKUP) audio.pickup();
    if (ev & EVENT_CASH) audio.cash();
    if (ev & EVENT_JINGLE) audio.jingle();
    if (ev & EVENT_CRIME) audio.sting();
    void (ev & EVENT_ENTER_CAR);
    if (mres.completed) {
      writeSave();
      hasSave = true;
    }
    if (ev & EVENT_BUSTED) enterEndScreen('busted');
    else if (ev & EVENT_WASTED) enterEndScreen('wasted');
  }

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    if (dt < 0) dt = 0;
    const actions = input.takeActions();
    if (actions & ACTION_MUTE) audio.toggleMute();

    let items = null;
    if (screen === SCREEN_TITLE) items = titleItems();
    else if (screen === SCREEN_PAUSED) items = pauseItems();

    if (screen === SCREEN_PAUSED && (actions & ACTION_PAUSE)) {
      screen = SCREEN_PLAY;
      announce('Back on the street.');
    } else if (screen === SCREEN_TITLE || screen === SCREEN_PAUSED) {
      runMenu(items, actions);
    } else if (screen === SCREEN_HOWTO) {
      if (actions & (ACTION_CONFIRM | ACTION_PAUSE)) {
        screen = SCREEN_TITLE;
        menuSelected = 0;
        announce('Palmira Heat.');
      }
    } else if (screen === SCREEN_BUSTED || screen === SCREEN_WASTED) {
      if (actions & ACTION_CONFIRM) {
        world.respawn(screen === SCREEN_BUSTED ? 'busted' : 'wasted');
        screen = SCREEN_PLAY;
        announce('Back on the street.');
      }
    } else if (screen === SCREEN_PLAY) {
      if (actions & ACTION_PAUSE) {
        screen = SCREEN_PAUSED;
        menuSelected = 0;
        announce('Paused.');
        items = pauseItems();
      }
    }

    // Step the simulation: ambient on the menus, live in play, frozen when paused.
    if (screen === SCREEN_PLAY && !(actions & ACTION_PAUSE)) {
      acc += dt;
      let first = true;
      let guard = 0;
      while (acc >= STEP && guard < 6) {
        playStep(first ? actions : 0);
        first = false;
        acc -= STEP;
        guard += 1;
        if (screen !== SCREEN_PLAY) {
          acc = 0;
          break;
        }
      }
      if (guard >= 6) acc = 0;
    } else if (screen === SCREEN_TITLE || screen === SCREEN_HOWTO) {
      acc += dt;
      let guard = 0;
      while (acc >= STEP && guard < 6) {
        world.step(STEP, { mx: 0, my: 0, run: false, interact: false, fire: false, aimX: 0, aimY: 0 }, true);
        acc -= STEP;
        guard += 1;
      }
      if (guard >= 6) acc = 0;
    }

    audio.update(world.state, screen, dt);
    renderer.draw(world.state, screen, {
      mouse: input.mouse,
      muted: audio.muted,
      menuItems: items ? items.map((i) => i.label) : [],
      menuSelected,
      fineText,
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) {
      screen = SCREEN_PAUSED;
      menuSelected = 0;
      announce('Paused.');
    }
  });
  announce('Palmira Heat. A top-down open world.');
  requestAnimationFrame(frame);
}
