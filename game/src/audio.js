// All of Palmira Heat's sound is synthesized with WebAudio — no audio files. The module is
// defensive by design: the AudioContext is only created after a real user gesture (unlock()),
// every call is a no-op until then and wrapped so a failure can never crash the game. That
// matters for the screenshot staging, which runs headless with no gesture at all: the game
// stays silent and alive. M toggles mute (main.js owns the key, this owns the gain).

export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let engineNodes = null;
  let sirenNodes = null;
  let musicTimer = null;
  let musicStep = 0;

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.42;
      master.connect(ctx.destination);
      return true;
    } catch {
      ctx = null;
      return false;
    }
  }

  function unlock() {
    try {
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume();
    } catch { /* sound is a garnish, never a blocker */ }
  }

  function tone(freq, dur, type = 'sine', vol = 0.2, when = 0, slideTo = 0) {
    if (!ctx || muted) return;
    try {
      const t0 = ctx.currentTime + when;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch { /* ignore */ }
  }

  function noise(dur, vol, freqFrom, freqTo, when = 0) {
    if (!ctx || muted) return;
    try {
      const t0 = ctx.currentTime + when;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(freqFrom, t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), t0 + dur);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(filter).connect(gain).connect(master);
      src.start(t0);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ one-shots
  function gunshot() {
    noise(0.16, 0.5, 3200, 300);
    tone(140, 0.1, 'square', 0.18, 0, 60);
  }
  function officerShot() {
    noise(0.11, 0.22, 2600, 400);
  }
  function hurt() {
    tone(90, 0.16, 'sawtooth', 0.25, 0, 50);
  }
  function pickup() {
    tone(660, 0.09, 'sine', 0.22);
    tone(990, 0.14, 'sine', 0.22, 0.07);
  }
  function cash() {
    tone(880, 0.07, 'triangle', 0.2);
    tone(1174, 0.07, 'triangle', 0.2, 0.06);
    tone(1568, 0.12, 'triangle', 0.2, 0.12);
  }
  function crime() {
    tone(392, 0.12, 'square', 0.12);
    tone(311, 0.2, 'square', 0.12, 0.1);
  }
  function jingle() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => tone(f, 0.22, 'triangle', 0.24, i * 0.11));
    tone(1318, 0.4, 'triangle', 0.2, 0.46);
  }
  function enter() {
    noise(0.05, 0.15, 1200, 500);
    tone(220, 0.06, 'sine', 0.1, 0.03);
  }
  function busted() {
    tone(330, 0.25, 'square', 0.16);
    tone(262, 0.25, 'square', 0.16, 0.22);
    tone(196, 0.5, 'square', 0.16, 0.44);
  }
  function wasted() {
    tone(220, 0.9, 'sawtooth', 0.14, 0, 55);
  }

  // ------------------------------------------------------------ engine loop
  function setEngine(on, ratio) {
    if (!ctx) return;
    try {
      if (on && !engineNodes) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const osc2 = ctx.createOscillator();
        osc2.type = 'square';
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 420;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(filter);
        osc2.connect(filter);
        filter.connect(gain).connect(master);
        osc.start();
        osc2.start();
        engineNodes = { osc, osc2, gain, filter };
      }
      if (engineNodes) {
        const t = ctx.currentTime;
        const f = 46 + ratio * 118;
        engineNodes.osc.frequency.setTargetAtTime(f, t, 0.06);
        engineNodes.osc2.frequency.setTargetAtTime(f * 0.5 + 3, t, 0.06);
        engineNodes.filter.frequency.setTargetAtTime(300 + ratio * 700, t, 0.1);
        engineNodes.gain.gain.setTargetAtTime(on && !muted ? 0.05 + ratio * 0.075 : 0, t, 0.09);
      }
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ siren loop
  function setSiren(level) {
    if (!ctx) return;
    try {
      if (level > 0.02 && !sirenNodes) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const lfo = ctx.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 0.55;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 130;
        lfo.connect(lfoGain).connect(osc.frequency);
        osc.frequency.value = 800;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(master);
        osc.start();
        lfo.start();
        sirenNodes = { osc, lfo, gain };
      }
      if (sirenNodes) {
        sirenNodes.gain.gain.setTargetAtTime(muted ? 0 : level * 0.05, ctx.currentTime, 0.15);
      }
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ title music
  // A lazy two-bar loop: soft bass pulse under a slow synthwave-ish arp, scheduled by a timer
  // only while the title screen is up. Frequencies only — an original 8-note figure.
  const BASS = [110, 0, 110, 0, 130.8, 0, 98, 0];
  const ARP = [440, 523, 659, 523, 587, 698, 880, 698];
  function musicTick() {
    if (!ctx || muted) return;
    const step = musicStep % 8;
    musicStep += 1;
    if (BASS[step]) tone(BASS[step], 0.22, 'triangle', 0.16);
    tone(ARP[step], 0.18, 'sine', 0.07);
    if (step % 4 === 0) tone(ARP[step] / 2, 0.5, 'sine', 0.05);
  }
  function setMusic(on) {
    try {
      if (on && ctx && !musicTimer) {
        musicTimer = window.setInterval(musicTick, 235);
      } else if (!on && musicTimer) {
        window.clearInterval(musicTimer);
        musicTimer = null;
      }
    } catch { /* ignore */ }
  }

  function setMuted(next) {
    muted = next;
    try {
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.42, ctx.currentTime, 0.03);
      if (engineNodes && ctx) engineNodes.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      if (sirenNodes && ctx) sirenNodes.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    } catch { /* ignore */ }
  }

  return {
    unlock, gunshot, officerShot, hurt, pickup, cash, crime, jingle, enter, busted, wasted,
    setEngine, setSiren, setMusic, setMuted,
    isMuted: () => muted,
  };
}
