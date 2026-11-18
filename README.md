# Palmira Heat

A top-down open-world crime game that runs entirely in the browser — no build step, no
network requests, no assets beyond the code. You are **Rio Marino**, fresh off the boat
in **Palmira**, a sun-bleached bay city of thirteen by ten blocks, and the fixer **Faro**
has work for you.

Steal cars, run a five-job story chain, dodge a five-star wanted system with patrol cars
that drive the streets to find you, work taxi fares between jobs, and watch the city
change around you — morning glare, golden sunset, neon after dark.

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080 — the whole game is the static files under `game/`.

## Controls

| Input | Action |
| --- | --- |
| W A S D / arrows | Move / drive |
| Shift | Run |
| F or E | Enter / exit any car (parked, moving, or police) |
| Mouse + click, or Space | Aim and fire the pistol |
| Esc or P | Pause |
| M | Sound on / off |

## What's in the city

- **A living city** — 13×10 blocks across ten named districts, ~120 buildings with
  storefronts and rooftop furniture, palm trees, docks with moored boats, a beach with
  an animated shoreline, a police station, a hospital, a bank, and the Shine & Go
  respray garage.
- **Traffic and pedestrians** — lane-following traffic that yields and turns at
  junctions, parked cars everywhere, and crowds that stroll, hail taxis, and scatter
  when the shooting starts.
- **The law** — a 0–5 star wanted level fed by witnessed crime. Patrol units route
  across the street grid to reach you, ram you, and bail out to shoot at three stars
  and up. Get cornered slow and you are BUSTED; lose them and the heat fades. The
  respray wipes the slate for $400 — if no unit watches you roll in.
- **A story** — five jobs from Faro: a specific car to steal and deliver, a package run
  under heat, a timed beachfront checkpoint dash, a three-star escape, and an armored
  van to take to Pier 9. Then free roam, with repeatable taxi fares.
- **A full day** — a day/night cycle with a golden hour, lit windows, lamp pools,
  headlight cones and neon that wakes up after dark, plus drifting cloud shadows.
- **Sound, synthesized** — engine pitch that follows your speed, gunfire, sirens that
  swell as units close in, and a title theme, all generated with WebAudio. Nothing
  loads, nothing streams.

Progress autosaves to localStorage after every job (and from the pause menu): cash,
story progress, position, health, armor and stats.

## Architecture

Plain ES modules under `game/src/`, no dependencies:

- `world.js` — the fixed-step (60 Hz) simulation: city life, driving, combat, the
  wanted system, taxi fares, pickups. It returns event bit flags; it knows nothing
  about drawing or sound. All randomness comes from one seeded stream, so any scene
  replays identically.
- `city.js` — the deterministic city build: blocks, buildings, specials, props.
- `missions.js` — Faro's five-job story chain and its objectives, banners and pay.
- `render.js` — the canvas renderer: world pass, night light pass, frosted-glass HUD
  and minimap, menus and end screens.
- `audio.js` — the guarded WebAudio synth; silent and harmless until a key press or
  click unlocks it.
- `input.js` — held axes plus one-shot action flags.
- `shots.js` — screenshot staging: autopilots that play the real simulation into the
  four cover scenes (title, mission drive, three-star chase, BUSTED).
- `main.js` — boot, the live loop, screens, saving; also the `?shot=` capture mode.
- `main.ts` (repo root) — the competition plumbing: copies `game/` and `screenshots/`
  to the output directory and writes the dossier.

## Original IP

Palmira, Rio Marino, Faro, and every business name, radio station and line of dialogue
in this game are original creations written for it. Any resemblance to other games,
cities or fixers is purely a matter of genre.
