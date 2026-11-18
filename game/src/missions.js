// The story of Palmira Heat: five jobs for wheelman Rio Marino, run by the fixer Faro out of a
// beachfront cafe. This module is the mission controller — it owns the chain's state machine
// (briefing -> active -> done), the objectives, markers and timers, and it drives the world
// only through the small api world.js hands it (spawn a car, set the heat, pay cash, banner a
// message). The taxi side activity lives in world.js; everything story-shaped lives here.
import { GRID } from './config.js';
import { BEACH_ROAD_X, blockRect, roadX, roadY } from './city.js';

export const MISSIONS = [
  {
    id: 'boat',
    title: 'Fresh Off the Boat',
    from: 'FARO',
    reward: 600,
    intro: [
      'FARO: Rio Marino. Heard you can drive. Heard you need money.',
      'FARO: A teal Comet coupe is parked up in Marina Bay. Owner owes me.',
      'FARO: Take it. Bring it to the Shine & Go garage. Quiet, yeah?',
    ],
  },
  {
    id: 'package',
    title: 'A Package for Sal',
    from: 'FARO',
    reward: 900,
    intro: [
      'FARO: Sal left a package by the Old Port gates. Small. Heavy. Do not open it.',
      'FARO: Walk it over to the Costa Verde drop. The harbour cops have been restless,',
      'FARO: so if the heat comes, it comes. Just get it there.',
    ],
  },
  {
    id: 'beachrun',
    title: 'Beachfront Run',
    from: 'FARO',
    reward: 750,
    intro: [
      'FARO: A casino man wants to see if you are fast or just lucky.',
      'FARO: Five flags down the beachfront avenue, against the clock.',
      'FARO: Any car you like. Try not to redecorate it.',
    ],
  },
  {
    id: 'cooloff',
    title: 'Cool Off',
    from: 'FARO',
    reward: 1000,
    intro: [
      'FARO: You are getting famous, Rio. Three stars famous.',
      'FARO: The PD wants a word. You are not going to give them one.',
      'FARO: Break their line of sight and stay gone until it blows over.',
    ],
  },
  {
    id: 'pier9',
    title: 'The Pier 9 Job',
    from: 'FARO',
    reward: 2500,
    intro: [
      'FARO: Last one, and it is the big one. A grey Bulwark armoured van,',
      'FARO: parked off Solana Avenue with a fortune in the back.',
      'FARO: Take it to my crew at Pier 9. Every cop in Palmira will come. Let them.',
    ],
  },
];

const CHECKPOINTS = [0, 2, 4, 6, 8].map((j) => ({ x: BEACH_ROAD_X, y: roadY(j) + 30 }));

/**
 * Create the story controller. `api` is world.js's bridge: { state, city, random,
 * spawnSpecialCar(x, y, angle, opts), setStars(n), addHeat(n), pay(n), banner(text, sub),
 * sparkle(x, y) }.
 */
export function createStory(api) {
  const s = api.state;
  const story = {
    /** Index of the current (or next) mission; == MISSIONS.length when the story is done. */
    index: 0,
    active: false,
    complete: false,
    phase: '',
    objective: '',
    marker: null,
    timer: 0,
    checkpoint: 0,
    targetCar: null,
    hasPackage: false,
  };
  s.story = story;

  function setObjective(text, marker) {
    story.objective = text;
    story.marker = marker;
  }

  function finish() {
    const m = MISSIONS[story.index];
    api.pay(m.reward);
    api.banner('MISSION COMPLETE', `${m.title}  +$${m.reward}`);
    api.jingle();
    story.active = false;
    story.targetCar = null;
    story.hasPackage = false;
    story.marker = null;
    story.objective = '';
    story.index += 1;
    if (story.index >= MISSIONS.length) {
      story.complete = true;
      api.banner('STORY COMPLETE', 'Palmira is yours, Rio. Free roam — taxis and trouble remain.');
    }
    api.autosave();
  }

  function fail(reason) {
    api.banner('MISSION FAILED', reason + ' — the job restarts.');
    story.active = false;
    story.targetCar = null;
    story.hasPackage = false;
    story.marker = null;
    story.objective = '';
    // Same index: start() will re-run it.
  }

  /** Begin mission `index` (defaults to the current one): spawn its props, set its first objective. */
  function start(index = story.index) {
    if (index >= MISSIONS.length) return;
    story.index = index;
    const m = MISSIONS[index];
    story.active = true;
    story.timer = 0;
    story.checkpoint = 0;
    story.hasPackage = false;
    if (m.id === 'boat') {
      const spot = { x: roadX(6), y: roadY(1) + 120 };
      story.targetCar = api.spawnSpecialCar(spot.x, spot.y, Math.PI / 2, { kind: 'sport', color: '#1abc9c', tag: 'mission' });
      story.phase = 'steal';
      setObjective('Steal the teal Comet coupe in Marina Bay', { x: spot.x, y: spot.y, r: 60 });
    } else if (m.id === 'package') {
      const r = blockRect(1, 2);
      story.phase = 'pickup';
      setObjective('Pick up the package at the Old Port gates', { x: r.x + 20, y: r.y + GRID.block - 14, r: 34 });
    } else if (m.id === 'beachrun') {
      story.phase = 'run';
      story.timer = 80;
      const c = CHECKPOINTS[0];
      setObjective('Beachfront Run: flag 1 of 5 — any car, against the clock', { x: c.x, y: c.y, r: 70 });
    } else if (m.id === 'cooloff') {
      story.phase = 'escape';
      api.setStars(3);
      setObjective('Lose the heat: break police sight until your stars are gone', null);
    } else if (m.id === 'pier9') {
      const spot = { x: roadX(8), y: roadY(3) + 120 };
      story.targetCar = api.spawnSpecialCar(spot.x, spot.y, Math.PI / 2, { kind: 'van', color: '#5d6d7e', tag: 'mission', armored: true });
      story.phase = 'steal';
      setObjective('Steal the grey Bulwark armoured van off Solana Avenue', { x: spot.x, y: spot.y, r: 60 });
    }
  }

  function playerAt(marker, r) {
    const p = s.player;
    const dx = p.x - marker.x;
    const dy = p.y - marker.y;
    return dx * dx + dy * dy < r * r;
  }

  function update(dt) {
    if (!story.active) return;
    const m = MISSIONS[story.index];
    const p = s.player;
    if (m.id === 'boat') {
      if (story.phase === 'steal') {
        if (story.targetCar && p.car === story.targetCar) {
          story.phase = 'deliver';
          const bay = api.city.respray.bay;
          setObjective('Deliver the Comet to the Shine & Go garage', { x: bay.x + bay.w / 2, y: bay.y + bay.h / 2, r: 58 });
          api.banner('FARO', 'Good hands. Now the garage, and keep it pretty.');
        } else if (story.targetCar && story.targetCar.dead) {
          fail('The Comet was wrecked.');
        }
      } else if (story.phase === 'deliver') {
        const bay = api.city.respray.bay;
        if (p.car === story.targetCar && playerAt({ x: bay.x + bay.w / 2, y: bay.y + bay.h / 2 }, 58)) finish();
        else if (story.targetCar && story.targetCar.dead) fail('The Comet was wrecked.');
      }
    } else if (m.id === 'package') {
      if (story.phase === 'pickup') {
        if (!p.car && playerAt(story.marker, 34)) {
          story.hasPackage = true;
          story.phase = 'deliver';
          api.setStars(2);
          const r = blockRect(2, 8);
          setObjective('Deliver the package to Costa Verde — the heat is on', { x: r.x + GRID.block - 20, y: r.y + 14, r: 36 });
          api.banner('FARO', 'That is the one. Move, Rio — sirens already.');
          api.sparkle(p.x, p.y);
        }
      } else if (story.phase === 'deliver') {
        if (!p.car && playerAt(story.marker, 36)) finish();
      }
    } else if (m.id === 'beachrun') {
      story.timer -= dt;
      if (story.timer <= 0) {
        fail('Out of time on the beachfront.');
        return;
      }
      const c = CHECKPOINTS[story.checkpoint];
      if (p.car && playerAt(c, 78)) {
        story.checkpoint += 1;
        api.sparkle(c.x, c.y);
        api.pickupSound();
        if (story.checkpoint >= CHECKPOINTS.length) {
          const bonus = Math.round(story.timer) * 4;
          api.pay(bonus);
          api.banner('CHECKPOINT BONUS', `+$${bonus} for time to spare`);
          finish();
        } else {
          const n = CHECKPOINTS[story.checkpoint];
          setObjective(`Beachfront Run: flag ${story.checkpoint + 1} of 5 — ${Math.ceil(story.timer)}s left`, { x: n.x, y: n.y, r: 70 });
        }
      }
    } else if (m.id === 'cooloff') {
      if (s.wanted.stars === 0 && s.wanted.heat <= 0) finish();
    } else if (m.id === 'pier9') {
      if (story.phase === 'steal') {
        if (story.targetCar && p.car === story.targetCar) {
          story.phase = 'deliver';
          api.setStars(3);
          const a = api.city.docks.apron;
          setObjective('Deliver the Bulwark to Pier 9 — every cop in Palmira is coming', { x: a.x, y: a.y, r: 64 });
          api.banner('FARO', 'That van sings, Rio. Pier 9. Do not stop for anybody.');
        } else if (story.targetCar && story.targetCar.dead) {
          fail('The Bulwark was wrecked.');
        }
      } else if (story.phase === 'deliver') {
        const a = api.city.docks.apron;
        if (p.car === story.targetCar && playerAt(a, 64)) finish();
        else if (story.targetCar && story.targetCar.dead) fail('The Bulwark was wrecked.');
      }
    }
  }

  return { story, start, update, MISSIONS };
}
