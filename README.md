# Palmira Heat

An original top-down open-world crime game in a single static web page — no build step, no
assets, no network. Everything is drawn with canvas and synthesized with WebAudio.

**The story.** Rio Marino steps off the boat in Palmira, a neon coastal city of palm avenues,
docks and beachfront money, with nothing but a driver's hands. The fixer Faro starts feeding
him work: lift a Comet coupe and keep it pretty, run a package across town hot, chase flags
down the beachfront against the clock, cool off a three-star heat, and finally steal an
armored van out from under the Palmira PD and deliver it to Pier 9. Five jobs tell the story;
after that, the city is yours — taxi fares, respray runs and a wanted level that remembers
everything the witnesses saw.

## Run it

```sh
node serve.ts            # serves game/ on http://localhost:8080
# or: node serve.ts --port 8123
```

Open the URL in a browser and choose **New Game**.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrows | Walk (on foot) · accelerate, brake, steer (in a car) |
| Shift | Run |
| F or E | Enter / exit any car — stealing is a crime when witnessed |
| Mouse + click / Space | Aim and fire the pistol (on foot) |
| P or Esc | Pause — resume, save, restart |
| M | Mute |

## What's in the city

- **A living city**: a 13×10-block road grid with named districts, sidewalks, crosswalks and
  stop lines, ~120 buildings with pseudo-3D roofs, water towers and AC units, storefront
  signs (Café Sol, Club Neptune, Faro Records…) with striped awnings that burn neon at night,
  palm trees swaying in the sea breeze, a beach with animated foam, moored boats off the
  docks, shipping containers at Pier 9, a police station, St. Coastal hospital and the
  Shine & Go respray garage.
- **Traffic and people**: lane-following traffic that queues, yields and creeps around parked
  cars; pedestrians who stroll the sidewalks, hail taxis, and flee gunfire and fast cars.
- **Wanted system**: 0–5 stars from witnessed crime (theft, gunfire, knocking someone down,
  hitting a patrol car). Police spawn scaled by stars, chase and ram; at 3+ stars officers
  bail out and shoot. Get pinned while slow and the bust meter fills — BUSTED means a fine
  and the cells at Palmira PD. Health at zero means WASTED and a hospital bill. Break police
  sight to cool off, or slip into the respray bay unseen for $400.
- **Five story missions** with phone-style briefings and popups, gold map markers, cash
  rewards and a story-complete state — plus repeatable taxi fares (distance and speed pay).
- **Day and night**: a full clock with golden-hour light, drifting cloud shadows, streetlight
  pools, headlight cones and lit windows after dark.
- **Sound, synthesized**: engine pitch follows speed, a two-tone siren swells as police
  close in, gunshots, pickups, a mission-complete jingle, an original radio station announced
  every time Rio gets into a car (Radio Onda 98.1, Club Neptune FM, Azure Wave Radio…), and a
  title-screen music loop. M mutes. Audio only ever starts after a user gesture.
- **Saves**: localStorage keeps cash, story progress, position and stats; the story autosaves
  after every completed job, and Continue picks up where Rio left off.

## Architecture

Plain static ES modules under `game/src/`, no dependencies:

- `world.js` — the whole simulation (city life, driving, police, wanted, gunplay, missions,
  taxi, pickups, particles, clock). It advances in fixed `STEP = 1/60` steps from an input
  struct and returns event flags; it knows nothing about screens or sound.
- `city.js` — the seeded city build: road grid, districts, buildings, specials, solids.
- `missions.js` — the five-job story chain as data plus a small state machine.
- `render.js` — canvas drawing only: layered city, gradient-bodied cars with turning wheels
  and brake lights, HUD, live minimap, screens. The camera follows with speed look-ahead and
  eases its zoom out as Rio speeds up.
- `shots.js` — deterministic screenshot staging behind `?shot=start|play|chase|end&seed=N`:
  each scene plays the real simulation forward with autopilots (Rio really steals the car,
  really commits the crimes that raise the stars, really gets busted).
- `input.js`, `audio.js`, `main.js` — keyboard/mouse, the WebAudio synth (fully guarded
  until a gesture unlocks it), and the boot/loop/screen state machine.
- `random.js` — mulberry32. Every random decision in the simulation and staging comes from
  the seeded RNG: the same seed always grows the same city and the same day.

`main.ts` packages the entry (copies `game/` and `screenshots/`, writes `dossier.json` via
`vendor/makefun-game.ts`); `serve.ts` serves the game for local play; `shots.json` lists the
four staged scenes that produced the screenshots in `screenshots/`.
