// Boot and the one loop: input is read every frame, the world advances in fixed 1/60 s steps
// (several in a slow frame, none in a fast one), and the renderer paints what is there. The
// game moves between screens — title, how-to, mission briefing, play, paused, busted, wasted —
// and this file owns the transitions, the save file in localStorage, and turning the world's
// event flags into sound.
//
// ?seed=N fixes the city's growth and every random roll. ?shot=start|play|chase|end (with
// &seed=N) stages that scene instead of running the loop, paints it twice and sets
// window.__shotReady for a screenshot.
import { SAVE_KEY, STEP } from './config.js';
import { createRandom } from './random.js';
import {
  createWorld, EV_BUSTED, EV_CASH, EV_CRIME, EV_ENTER, EV_HURT, EV_JINGLE, EV_OSHOT, EV_PICKUP, EV_SHOT, EV_WASTED,
} from './world.js';
import { ACTION_CONFIRM, ACTION_DOWN, ACTION_ENTER, ACTION_MUTE, ACTION_PAUSE, ACTION_UP, createInput } from './input.js';
import {
  SCREEN_BRIEF, SCREEN_BUSTED, SCREEN_HELP, SCREEN_PAUSED, SCREEN_PLAY, SCREEN_TITLE, SCREEN_WASTED, createRenderer,
} from './render.js';
import { createAudio } from './audio.js';
import { stageShot } from './shots.js';
import { MISSIONS } from './missions.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped, not replayed. */
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');
const world = createWorld(createRandom(seed));
const renderer = createRenderer(canvas);
const audio = createAudio();

function readSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function writeSave() {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize()));
  } catch {
    // Storage can be off (private windows): saving then lasts this visit only.
  }
}

function runShot(name) {
  const scene = stageShot(name, world);
  const ui = { items: ['New Game', 'How to Play'], index: 0, mouse: null, muted: false, title: '', lines: [], reward: 0 };
  let painted = 0;
  function paint() {
    renderer.draw(world.state, scene.screen, ui);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

function runGame() {
  const input = createInput(canvas);
  let screen = SCREEN_TITLE;
  let menuIndex = 0;
  let save = readSave();
  let briefTimer = 0;
  let lastStoryIndex = world.story.index;
  let accumulator = 0;
  let last = performance.now();

  function announce(message) {
    status.textContent = message;
  }

  function titleItems() {
    const items = ['New Game'];
    if (save) items.push('Continue');
    items.push('How to Play');
    return items;
  }
  const PAUSE_ITEMS = ['Resume', 'Save Game', 'Restart Story', 'Title Screen'];

  function showBrief() {
    screen = SCREEN_BRIEF;
    announce(`Job ${world.story.index + 1}: ${MISSIONS[world.story.index].title}.`);
  }

  function startNew() {
    world.reset();
    save = null;
    lastStoryIndex = 0;
    briefTimer = 0;
    if (!world.story.complete && world.story.index < MISSIONS.length) showBrief();
    else screen = SCREEN_PLAY;
  }

  function continueSave() {
    if (!save) return;
    world.restore(save);
    lastStoryIndex = world.story.index;
    if (!world.story.complete && !world.story.active && world.story.index < MISSIONS.length) showBrief();
    else screen = SCREEN_PLAY;
  }

  function confirm() {
    if (screen === SCREEN_TITLE) {
      const items = titleItems();
      const pick = items[menuIndex];
      if (pick === 'New Game') startNew();
      else if (pick === 'Continue') continueSave();
      else if (pick === 'How to Play') screen = SCREEN_HELP;
    } else if (screen === SCREEN_HELP) {
      screen = SCREEN_TITLE;
      menuIndex = 0;
    } else if (screen === SCREEN_BRIEF) {
      world.startMission(world.story.index);
      screen = SCREEN_PLAY;
      announce(MISSIONS[world.story.index].title + '. ' + world.story.objective);
    } else if (screen === SCREEN_PAUSED) {
      const pick = PAUSE_ITEMS[menuIndex];
      if (pick === 'Resume') screen = SCREEN_PLAY;
      else if (pick === 'Save Game') {
        writeSave();
        save = readSave();
        screen = SCREEN_PLAY;
        announce('Saved.');
      } else if (pick === 'Restart Story') startNew();
      else if (pick === 'Title Screen') {
        screen = SCREEN_TITLE;
        menuIndex = 0;
      }
    } else if (screen === SCREEN_BUSTED) {
      world.respawnBusted();
      screen = SCREEN_PLAY;
    } else if (screen === SCREEN_WASTED) {
      world.respawnWasted();
      screen = SCREEN_PLAY;
    }
  }

  function handleActions() {
    const actions = input.takeActions();
    if (actions & ACTION_MUTE) audio.setMuted(!audio.isMuted());
    if (screen === SCREEN_TITLE || screen === SCREEN_PAUSED) {
      const count = screen === SCREEN_TITLE ? titleItems().length : PAUSE_ITEMS.length;
      if (actions & ACTION_UP) menuIndex = (menuIndex + count - 1) % count;
      if (actions & ACTION_DOWN) menuIndex = (menuIndex + 1) % count;
    }
    if (actions & ACTION_CONFIRM) {
      audio.unlock();
      confirm();
      return 0;
    }
    if (actions & ACTION_PAUSE) {
      if (screen === SCREEN_PLAY) {
        screen = SCREEN_PAUSED;
        menuIndex = 0;
        announce('Paused.');
      } else if (screen === SCREEN_PAUSED) {
        screen = SCREEN_PLAY;
        announce('Playing.');
      } else if (screen === SCREEN_HELP) {
        screen = SCREEN_TITLE;
      }
      return 0;
    }
    return actions;
  }

  function buildInput(actions, firstStep) {
    const cam = renderer.getCamera();
    const scale = renderer.getView().scale || 1;
    const mouse = input.mousePos();
    const p = world.state.player;
    let aimAngle = p.angle;
    if (mouse.x !== 0 || mouse.y !== 0) {
      // The camera zooms with speed, so screen pixels are world units divided by the scale.
      aimAngle = Math.atan2(mouse.y / scale - (p.y - cam.y), mouse.x / scale - (p.x - cam.x));
    }
    return {
      mx: input.axisX(),
      my: input.axisY(),
      run: input.run(),
      throttle: input.throttle(),
      steer: input.steer(),
      enterPressed: firstStep && (actions & ACTION_ENTER) !== 0,
      fire: input.firing(),
      aimAngle,
    };
  }

  const BLANK = { mx: 0, my: 0, run: false, throttle: 0, steer: 0, enterPressed: false, fire: false, aimAngle: 0 };

  function playEvents(events) {
    if (events & EV_SHOT) audio.gunshot();
    if (events & EV_OSHOT) audio.officerShot();
    if (events & EV_HURT) audio.hurt();
    if (events & EV_PICKUP) audio.pickup();
    if (events & EV_CASH) audio.cash();
    if (events & EV_CRIME) audio.crime();
    if (events & EV_JINGLE) audio.jingle();
    if (events & EV_ENTER) audio.enter();
  }

  function afterStep(events) {
    playEvents(events);
    if (world.state.over === 'busted' && screen === SCREEN_PLAY) {
      screen = SCREEN_BUSTED;
      audio.busted();
      audio.setEngine(false, 0);
      audio.setSiren(0);
      announce('Busted.');
    } else if (world.state.over === 'wasted' && screen === SCREEN_PLAY) {
      screen = SCREEN_WASTED;
      audio.wasted();
      audio.setEngine(false, 0);
      audio.setSiren(0);
      announce('Wasted.');
    }
    // A finished job autosaves, and the next briefing follows once the banner has landed.
    if (world.story.index !== lastStoryIndex) {
      lastStoryIndex = world.story.index;
      writeSave();
      save = readSave();
      briefTimer = 2.6;
    }
    if (screen === SCREEN_PLAY && !world.story.active && !world.story.complete && world.story.index < MISSIONS.length) {
      briefTimer -= STEP;
      if (briefTimer <= 0) showBrief();
    } else if (world.story.active) {
      briefTimer = 0;
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    accumulator += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    const actions = handleActions();
    const stepping = screen === SCREEN_PLAY || screen === SCREEN_TITLE;
    if (stepping) {
      let first = true;
      while (accumulator >= STEP && (screen === SCREEN_PLAY || screen === SCREEN_TITLE)) {
        const events = world.step(STEP, screen === SCREEN_PLAY ? buildInput(actions, first) : BLANK);
        first = false;
        if (screen === SCREEN_PLAY) afterStep(events);
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    // Continuous sounds follow the frame, not the step.
    const p = world.state.player;
    if (screen === SCREEN_PLAY && p.car) {
      const top = { sedan: 430, sport: 560, taxi: 430, van: 360, police: 520, truck: 330 }[p.car.kind] || 430;
      audio.setEngine(true, Math.abs(p.car.speed) / top);
    } else {
      audio.setEngine(false, 0);
    }
    let siren = 0;
    if (screen === SCREEN_PLAY && world.state.wanted.stars > 0) {
      let best = Infinity;
      for (const c of world.state.cars) {
        if (c.driver === 'police' || c.driver === 'policeParked') {
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < best) best = d;
        }
      }
      if (best < 700) siren = 1 - best / 700;
    }
    audio.setSiren(siren);
    audio.setMusic(screen === SCREEN_TITLE);

    const ui = { items: [], index: menuIndex, mouse: input.mousePos(), muted: audio.isMuted(), title: '', lines: [], reward: 0 };
    if (screen === SCREEN_TITLE) ui.items = titleItems();
    else if (screen === SCREEN_PAUSED) ui.items = PAUSE_ITEMS;
    else if (screen === SCREEN_BRIEF && world.story.index < MISSIONS.length) {
      const m = MISSIONS[world.story.index];
      ui.title = m.title;
      ui.lines = m.intro;
      ui.reward = m.reward;
    }
    renderer.draw(world.state, screen, ui);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === SCREEN_PLAY) {
      screen = SCREEN_PAUSED;
      menuIndex = 0;
      announce('Paused.');
    }
  });
  window.addEventListener('pointerdown', () => audio.unlock(), { once: false });

  announce('Palmira Heat. Choose New Game to start.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
