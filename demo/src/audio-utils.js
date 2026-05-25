// audio-utils.js
// Small pure-JS helpers for audio manipulation used by the browser
// content-authoring path (demo/generate.html). Kept separate from
// generate.js so they're testable in Node without DOM / WebAudio
// dependencies.

// Downmix a multi-channel audio buffer (anything with the
// AudioBuffer-like duck type — `numberOfChannels`, `length`,
// `getChannelData(c)`) to a single Float32Array of mono samples
// by averaging the per-channel values at each sample index.
//
// We accept the duck-typed shape rather than a real AudioBuffer
// so tests can pass in a plain object with getChannelData(c) →
// Float32Array. Production callers pass the result of
// AudioContext.decodeAudioData() directly.
export function downmixToMono(audioBufferLike) {
  const len = audioBufferLike.length | 0;
  const channels = audioBufferLike.numberOfChannels | 0;
  const mono = new Float32Array(len);
  if (channels <= 0 || len <= 0) return mono;
  if (channels === 1) {
    // Fast path: just copy. Avoids the per-sample divide and the
    // slightly different rounding behavior when c=1.
    mono.set(audioBufferLike.getChannelData(0));
    return mono;
  }
  for (let c = 0; c < channels; c++) {
    const ch = audioBufferLike.getChannelData(c);
    for (let i = 0; i < len; i++) {
      mono[i] += ch[i] / channels;
    }
  }
  return mono;
}
