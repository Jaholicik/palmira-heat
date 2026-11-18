// Faro's five jobs: the story chain that teaches Palmira one crime at a time. Each mission
// is a tiny state machine that reads the world (never draws, never touches the browser):
// begin() sets the scene and briefs Rio by phone, update() watches for the objective and
// pays out. Getting busted or wasted aborts the running job — Faro always calls back.
import { HEAT, PITCH } from './config.js';
import { roadX, roadY } from './city.js';
import { EVENT_CASH } from './world.js';

export const EVENT_JINGLE = 512;

const BAY_PAD = 8;

function inBay(world, car) {
  const bay = world.state.city.specials.respray.bay;
  return car.x > bay.x - BAY_PAD && car.x < bay.x + bay.w + BAY_PAD && car.y > bay.y - BAY_PAD && car.y < bay.y + bay.h + BAY_PAD;
}

function removeCar(world, car) {
  const cars = world.state.cars;
  const at = cars.indexOf(car);
  if (at >= 0) cars.splice(at, 1);
}

function sweepSpecial(world, tag) {
  const cars = world.state.cars;
  for (let i = cars.length - 1; i >= 0; i -= 1) {
    if (cars[i].special === tag && cars[i].driver !== 'player') cars.splice(i, 1);
  }
}

function pay(world, amount) {
  world.state.cash += amount;
  world.state.stats.earned += amount;
}

// ---------------------------------------------------------------------------
// The five jobs
// ---------------------------------------------------------------------------

const MISSIONS = [
  {
    id: 'comet',
    title: 'Fresh Off the Boat',
    reward: 600,
    begin(world, run) {
      sweepSpecial(world, 'comet');
      run.car = world.spawnSpecialCar('sport', 'comet', roadX(9) - 37, roadY(4) + 150, Math.PI / 2);
      run.car.color = '#2fb3a8';
      run.car.roof = '#1f7d76';
      run.stage = 'steal';
      world.popup('FARO', 'Rio. You made it to Palmira. Good. Now listen — I need wheels with a pedigree.');
      world.popup('FARO', 'A teal Comet S sits on the Neon Mile, keys in, owner careless. Take it. Bring it to Shine & Go.');
    },
    update(world, run) {
      const s = world.state;
      if (run.stage === 'steal') {
        s.objective = { text: 'Steal the Comet S', x: run.car.x, y: run.car.y };
        if (s.player.car === run.car) {
          run.stage = 'deliver';
          world.popup('FARO', 'Good hands. Now the garage, and keep it pretty.');
        }
        return 'run';
      }
      const bay = s.city.specials.respray.bay;
      s.objective = { text: 'Deliver the Comet to Shine & Go', x: bay.x + bay.w / 2, y: bay.y + bay.h / 2 };
      if (s.player.car === run.car && inBay(world, run.car)) {
        world.exitCar();
        removeCar(world, run.car);
        return 'done';
      }
      return 'run';
    },
    abort(world, run) {
      if (run.car && run.car.driver !== 'player') removeCar(world, run.car);
    },
  },
  {
    id: 'package',
    title: "Sal's Package",
    reward: 900,
    begin(world, run) {
      run.point = { x: roadX(1) + 44, y: roadY(8) + 36 };
      run.dest = { x: roadX(7) + 38, y: roadY(2) + 84 };
      run.stage = 'pickup';
      world.popup('FARO', 'Sal left a package in the Old Port, by the water stairs. Pick it up, carry it to Downtown.');
      world.popup('FARO', 'One thing — the moment you touch it, every badge in Palmira will smell it. Drive like you mean it.');
    },
    update(world, run) {
      const s = world.state;
      const pp = world.playerPos();
      if (run.stage === 'pickup') {
        s.objective = { text: 'Pick up the package', x: run.point.x, y: run.point.y };
        if (Math.hypot(pp.x - run.point.x, pp.y - run.point.y) < 34) {
          run.stage = 'deliver';
          world.setHeatAtLeast(HEAT.bands[1] + 10);
          world.popup('FARO', 'That is the stuff. Now move — Downtown, the garage by the plaza.');
        }
        return 'run';
      }
      s.objective = { text: 'Deliver the package — Downtown', x: run.dest.x, y: run.dest.y };
      if (Math.hypot(pp.x - run.dest.x, pp.y - run.dest.y) < 46) return 'done';
      return 'run';
    },
    abort() {},
  },
  {
    id: 'beachrun',
    title: 'Beachfront Run',
    reward: 750,
    begin(world, run) {
      run.points = [1, 3, 5, 7, 9].map((j) => ({ x: roadX(13), y: roadY(j) }));
      run.next = 0;
      run.timeLeft = 85;
      world.popup('FARO', 'A friend bets you cannot run the whole beachfront before the light changes. Five gates. Prove him poor.');
    },
    update(world, run, dt) {
      const s = world.state;
      run.timeLeft -= dt;
      const target = run.points[run.next];
      s.objective = { text: `Beachfront Run — gate ${run.next + 1} of 5 · ${Math.max(0, Math.ceil(run.timeLeft))}s`, x: target.x, y: target.y };
      if (run.timeLeft <= 0) {
        world.popup('FARO', 'Too slow, the bet is lost. We go again when you are ready.');
        return 'fail';
      }
      const pp = world.playerPos();
      if (s.player.car && Math.hypot(pp.x - target.x, pp.y - target.y) < 58) {
        run.next += 1;
        if (run.next >= run.points.length) return 'done';
        world.popup('FARO', `Gate ${run.next} of 5. Keep her singing.`);
      }
      return 'run';
    },
    abort() {},
  },
  {
    id: 'cooloff',
    title: 'Cool Off',
    reward: 1000,
    begin(world, run) {
      world.setHeatAtLeast(HEAT.bands[2] + 30);
      world.popup('FARO', 'Change of plans — the last drop went loud and the whole PD is lit up. Shake them, Rio. All of them.');
      run.stage = 'escape';
    },
    update(world, run) {
      const s = world.state;
      s.objective = { text: 'Lose the heat — break their line of sight', x: null, y: null };
      if (s.stars === 0 && s.heat <= 0) return 'done';
      return 'run';
    },
    abort() {},
  },
  {
    id: 'pier9',
    title: 'The Pier 9 Job',
    reward: 2500,
    begin(world, run) {
      sweepSpecial(world, 'van');
      const bankX = 7 * PITCH + PITCH / 2;
      run.car = world.spawnSpecialCar('armored', 'van', bankX, roadY(4), 0);
      run.stage = 'steal';
      world.popup('FARO', 'Last job, biggest teeth. A Bastion armored van idles outside Palma Bank, full of other people\'s money.');
      world.popup('FARO', 'Take it to Pier 9 at the docks. The whole city will try to stop you. That is why it pays.');
    },
    update(world, run) {
      const s = world.state;
      const pier = s.city.specials.pier.point;
      if (run.stage === 'steal') {
        s.objective = { text: 'Steal the armored van', x: run.car.x, y: run.car.y };
        if (s.player.car === run.car) {
          run.stage = 'deliver';
          world.setHeatAtLeast(HEAT.bands[2] + 20);
          world.popup('FARO', 'Everybody knows that van now. Run, Rio — Pier 9!');
        }
        return 'run';
      }
      s.objective = { text: 'Deliver the van — Pier 9', x: pier.x, y: pier.y };
      const pp = world.playerPos();
      if (s.player.car === run.car && Math.hypot(pp.x - pier.x, pp.y - pier.y) < 62) {
        world.exitCar();
        removeCar(world, run.car);
        return 'done';
      }
      return 'run';
    },
    abort(world, run) {
      if (run.car && run.car.driver !== 'player') removeCar(world, run.car);
    },
  },
];

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export function createMissions() {
  let index = 0;
  let complete = false;
  let run = null; // { def, ...scratch }
  let gapTimer = 1.6;

  function startNext(world) {
    const def = MISSIONS[index];
    run = { def };
    def.begin(world, run);
  }

  function update(world, dt) {
    let events = 0;
    let completed = false;
    const s = world.state;
    if (complete) {
      if (s.objective && s.objective.mission) s.objective = null;
      return { events, completed };
    }
    if (!run) {
      gapTimer -= dt;
      if (s.objective && s.objective.mission) s.objective = null;
      if (gapTimer <= 0 && index < MISSIONS.length) startNext(world);
      return { events, completed };
    }
    const result = run.def.update(world, run, dt);
    if (s.objective) s.objective.mission = true;
    if (result === 'done') {
      pay(world, run.def.reward);
      world.banner('MISSION COMPLETE', `${run.def.title} — +$${run.def.reward}`);
      events |= EVENT_CASH | EVENT_JINGLE;
      completed = true;
      index += 1;
      run = null;
      gapTimer = 3.2;
      s.objective = null;
      if (index >= MISSIONS.length) {
        complete = true;
        world.banner('STORY COMPLETE', 'Palmira is yours, Rio — free roam');
        world.popup('FARO', 'That is the set, Rio. The city knows your name now. Anything else is just appetite.');
      }
    } else if (result === 'fail') {
      run = null;
      gapTimer = 3.2;
      s.objective = null;
    }
    return { events, completed };
  }

  function onGameOver(world) {
    if (run) {
      run.def.abort(world, run);
      run = null;
      gapTimer = 2.4;
      world.state.objective = null;
      world.popup('FARO', 'Forget it. Breathe. We run it again when the dust settles.');
    }
  }

  return {
    update,
    onGameOver,
    snapshot() { return { index, complete }; },
    applySave(data) {
      index = data.index ?? 0;
      complete = !!data.complete;
      run = null;
      gapTimer = 2.2;
    },
    get complete() { return complete; },
    get index() { return index; },
    get total() { return MISSIONS.length; },
  };
}
