/**
 * Web Audio API sound primitives — no audio files required.
 * All sounds are synthesised on the fly.
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
  }
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  return ctx;
}

function gain(ac: AudioContext, value: number): GainNode {
  const g = ac.createGain();
  g.gain.value = value;
  g.connect(ac.destination);
  return g;
}

function tone(
  ac: AudioContext,
  dest: AudioNode,
  freq: number,
  startAt: number,
  duration: number,
  type: OscillatorType = "sine",
) {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(dest);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

/** New incident — urgent double-pulse */
export function playNewIncident(volume = 0.5) {
  const ac = getCtx();
  const g = gain(ac, volume);
  const now = ac.currentTime;
  // Two sharp beeps
  tone(ac, g, 880, now, 0.12, "square");
  tone(ac, g, 880, now + 0.18, 0.12, "square");
  // Fade out gain
  g.gain.setValueAtTime(volume, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
}

/** Pending approval — ascending attention chime */
export function playPendingApproval(volume = 0.45) {
  const ac = getCtx();
  const g = gain(ac, volume);
  const now = ac.currentTime;
  const freqs = [523, 659, 784]; // C5 E5 G5
  freqs.forEach((f, i) => {
    tone(ac, g, f, now + i * 0.13, 0.22, "sine");
  });
  g.gain.setValueAtTime(volume, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
}

/** Resolved — pleasant success chime */
export function playResolved(volume = 0.4) {
  const ac = getCtx();
  const g = gain(ac, volume);
  const now = ac.currentTime;
  const freqs = [523, 659, 784, 1047]; // C5 E5 G5 C6
  freqs.forEach((f, i) => {
    tone(ac, g, f, now + i * 0.1, 0.28, "sine");
  });
  g.gain.setValueAtTime(volume, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
}

/** Failed — descending error tone */
export function playFailed(volume = 0.45) {
  const ac = getCtx();
  const g = gain(ac, volume);
  const now = ac.currentTime;
  const freqs = [440, 349, 261]; // A4 F4 C4 descending
  freqs.forEach((f, i) => {
    tone(ac, g, f, now + i * 0.15, 0.25, "sawtooth");
  });
  g.gain.setValueAtTime(volume, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
}

/** Predictive anomaly — subtle low pulse */
export function playPredictive(volume = 0.3) {
  const ac = getCtx();
  const g = gain(ac, volume);
  const now = ac.currentTime;
  tone(ac, g, 220, now, 0.18, "sine");
  tone(ac, g, 277, now + 0.22, 0.18, "sine");
  g.gain.setValueAtTime(volume, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
}
