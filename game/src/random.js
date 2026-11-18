// A small seeded random number generator (mulberry32): the same seed always produces the
// same stream, which is what makes the city, the traffic and the staged screenshot scenes
// perfectly repeatable. Every random decision in the simulation draws from one of these.

export function createRandom(seed) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A separate stream for decoration-only randomness (render speckles and the like), seeded apart so it can never perturb the simulation. */
export function decorationRandom(seed) {
  return createRandom((seed ^ 0x9e3779b9) | 0);
}
