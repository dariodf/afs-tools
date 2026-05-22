// cannon-boom.js
// Synthesizes a cannon-shot sound effect using Web Audio nodes.
// We didn't ship a recorded SFX because (a) cannon-shot.mp4 has no
// audio track and (b) sourcing a CC0/public-domain cannon recording
// just for this demo would add another attribution dependency.
// Synthesis is deterministic, license-free, and roughly the right
// flavor: a wide-band thump that decays into low-frequency rumble.
//
// Anatomy of one shot:
//   - Sub-bass sine sweep (80 → 28 Hz) for the body of the boom
//   - Low-passed white noise for the "crack + air" component
//   - Optional second noise burst delayed by ~80 ms to suggest a
//     reflection / second wave
//   - Master envelope: fast attack, exponential decay over ~900 ms
//
// Tuned by ear against the cannon hits in the 1812 finale. Doesn't
// pretend to be a real cannon — just sells the haptic-event UX.

export function playCannonBoom(audioContext, { gain = 0.9 } = {}) {
  const ctx = audioContext;
  const now = ctx.currentTime;
  const duration = 0.9;

  // ---------- Sub-bass body ----------
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(80, now);
  sub.frequency.exponentialRampToValueAtTime(28, now + 0.35);
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0, now);
  subGain.gain.linearRampToValueAtTime(1.0 * gain, now + 0.004);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
  sub.connect(subGain);

  // ---------- White-noise crack ----------
  const bufferLen = Math.floor(ctx.sampleRate * duration);
  const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufferLen; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  // Bandpass-ish: low-pass at 700 Hz removes the sizzle but leaves
  // the dense thud component.
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 700;
  lp.Q.value = 0.5;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0, now);
  noiseGain.gain.linearRampToValueAtTime(0.55 * gain, now + 0.002);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  noise.connect(lp);
  lp.connect(noiseGain);

  // ---------- Reflection / second wave ----------
  // A quieter delayed noise burst gives the sound a sense of space.
  const reflect = ctx.createBufferSource();
  reflect.buffer = noiseBuf;
  const reflectLp = ctx.createBiquadFilter();
  reflectLp.type = "lowpass";
  reflectLp.frequency.value = 400;
  const reflectGain = ctx.createGain();
  reflectGain.gain.setValueAtTime(0, now);
  reflectGain.gain.linearRampToValueAtTime(0.25 * gain, now + 0.085);
  reflectGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
  reflect.connect(reflectLp);
  reflectLp.connect(reflectGain);

  // ---------- Output ----------
  const out = ctx.createGain();
  out.gain.value = 1;
  subGain.connect(out);
  noiseGain.connect(out);
  reflectGain.connect(out);
  out.connect(ctx.destination);

  sub.start(now);
  sub.stop(now + duration);
  noise.start(now);
  noise.stop(now + duration);
  reflect.start(now + 0.04);
  reflect.stop(now + duration);
}
