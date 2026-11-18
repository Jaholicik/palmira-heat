// Every sound in Palmira is synthesized — no audio files. The whole module is built to be
// called carelessly: nothing exists until the player's first key press or click unlocks
// the AudioContext (browser policy), every call is guarded, and a headless screenshot run
// with no gesture at all simply stays silent and never throws.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let engine = null; // { osc, osc2, gain }
  let siren = null; // { osc, gain }
  let musicTimer = 0;
  let chordIndex = 0;
  let muted = false;

  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      const len = ctx.sampleRate * 0.5;
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      ctx = null;
    }
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  function tone(freq, dur, type = 'sine', vol = 0.16, delay = 0, slideTo = 0) {
    if (!ctx || muted) return;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain);
      gain.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch { /* a sound is never worth a crash */ }
  }

  function noise(dur, vol, freq = 1600, delay = 0) {
    if (!ctx || muted || !noiseBuffer) return;
    try {
      const t0 = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    } catch { /* guarded */ }
  }

  function startEngine() {
    if (!ctx || engine) return;
    try {
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      osc.type = 'sawtooth';
      osc2.type = 'square';
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.055, ctx.currentTime + 0.25);
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start();
      osc2.start();
      engine = { osc, osc2, gain };
    } catch { engine = null; }
  }

  function stopEngine() {
    if (!engine) return;
    try {
      const e = engine;
      e.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.18);
      setTimeout(() => { try { e.osc.stop(); e.osc2.stop(); } catch { /* done */ } }, 240);
    } catch { /* guarded */ }
    engine = null;
  }

  function startSiren() {
    if (!ctx || siren) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(master);
      osc.start();
      siren = { osc, gain };
    } catch { siren = null; }
  }

  function stopSiren() {
    if (!siren) return;
    try { siren.osc.stop(); } catch { /* done */ }
    siren = null;
  }

  const CHORDS = [
    [110.0, 164.8, 220.0, 261.6], // Am
    [87.3, 130.8, 174.6, 220.0], // F
    [98.0, 146.8, 196.0, 246.9], // G
    [130.8, 196.0, 261.6, 329.6], // C
  ];

  return {
    unlock,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master && ctx) {
        try { master.gain.linearRampToValueAtTime(muted ? 0 : 0.5, ctx.currentTime + 0.05); } catch { /* guarded */ }
      }
      if (muted) { stopEngine(); stopSiren(); }
      return muted;
    },
    shot() { noise(0.1, 0.5, 1500); tone(140, 0.07, 'square', 0.22, 0, 60); },
    officerShot() { noise(0.08, 0.2, 1700); },
    pickup() { tone(660, 0.09, 'sine', 0.18); tone(990, 0.14, 'sine', 0.18, 0.07); },
    cash() { tone(880, 0.08, 'triangle', 0.2); tone(1318, 0.16, 'triangle', 0.2, 0.06); },
    jingle() {
      const notes = [523.3, 659.3, 784.0, 1046.5];
      notes.forEach((f, i) => tone(f, 0.22, 'triangle', 0.2, i * 0.09));
    },
    sting() { tone(98, 0.3, 'sawtooth', 0.1); tone(103.8, 0.3, 'sawtooth', 0.1); },
    click() { tone(1250, 0.04, 'sine', 0.07); },
    /** Continuous sounds, driven once per frame from the live state. */
    update(state, screen, dt) {
      if (!ctx) return;
      try {
        const p = state.player;
        if (p.car && screen === 'play') {
          startEngine();
          if (engine) {
            const ratio = Math.min(1, Math.abs(p.car.speed) / p.car.spec.top);
            const f = 42 + ratio * 128;
            engine.osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.06);
            engine.osc2.frequency.setTargetAtTime(f * 0.5 + 2, ctx.currentTime, 0.06);
          }
        } else stopEngine();
        // Siren: audible when a unit is close and the heat is on.
        let nearest = Infinity;
        if (state.stars > 0) {
          const pp = p.car ? { x: p.car.x, y: p.car.y } : { x: p.x, y: p.y };
          for (const car of state.cars) {
            if (car.kind !== 'police' || car.leaveMode) continue;
            const d = Math.hypot(car.x - pp.x, car.y - pp.y);
            if (d < nearest) nearest = d;
          }
          for (const o of state.officers) {
            const d = Math.hypot(o.x - pp.x, o.y - pp.y);
            if (d < nearest) nearest = d;
          }
        }
        if (nearest < 520 && screen === 'play') {
          startSiren();
          if (siren) {
            const wail = Math.floor(ctx.currentTime * 1.5) % 2 === 0 ? 715 : 955;
            siren.osc.frequency.setTargetAtTime(wail, ctx.currentTime, 0.05);
            siren.gain.gain.setTargetAtTime(muted ? 0 : 0.06 * (1 - nearest / 560), ctx.currentTime, 0.1);
          }
        } else stopSiren();
        // Title music: a slow synth-pad progression, only on the title screen.
        if (screen === 'title' && !muted) {
          musicTimer -= dt;
          if (musicTimer <= 0) {
            musicTimer = 2.6;
            const chord = CHORDS[chordIndex % CHORDS.length];
            chordIndex += 1;
            for (const f of chord) tone(f, 2.4, 'triangle', 0.045);
            tone(chord[0] / 2, 2.4, 'sine', 0.05);
          }
        }
      } catch { /* guarded */ }
    },
  };
}
