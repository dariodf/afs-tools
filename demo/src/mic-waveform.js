// mic-waveform.js
// Real-time waveform visualization of mic input. Hooks an
// AnalyserNode off the existing AudioCapture source and draws a
// thin time-domain trace on a canvas at the device's animation
// rate.
//
// Designed to be unobtrusive — the visualizer is a feedback cue
// ("yes, we're hearing audio"), not a focal element of the UI.

const SMOOTHING = 0.6;
const FFT_SIZE = 1024;

export class MicWaveform {
  // capture: AudioCapture instance — must already have audioContext + source set
  // canvas: HTMLCanvasElement to draw onto
  constructor(capture, canvas) {
    this.capture = capture;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.analyser = capture.audioContext.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = SMOOTHING;
    capture.source.connect(this.analyser);
    this.buffer = new Uint8Array(this.analyser.fftSize);
    this.rafHandle = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._draw();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    try {
      this.capture.source.disconnect(this.analyser);
    } catch {
      // already disconnected, fine
    }
  }

  _draw() {
    this.analyser.getByteTimeDomainData(this.buffer);
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // Resize the backing buffer once for DPR, only if needed.
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);

    // Compute peak amplitude this frame — used to scale the
    // visual so small/quiet sounds still produce a visible trace.
    let peak = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const a = Math.abs(this.buffer[i] - 128) / 128;
      if (a > peak) peak = a;
    }
    // Floor + auto-gain so the line is always visible.
    const gain = peak < 0.05 ? 4 : Math.min(2.5, 0.6 / peak);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(140, 200, 255, 0.85)";
    ctx.beginPath();
    const slice = w / this.buffer.length;
    for (let i = 0; i < this.buffer.length; i++) {
      const x = i * slice;
      // 0..255 → -1..1 (128 is silence)
      const v = ((this.buffer[i] - 128) / 128) * gain;
      const y = h / 2 + (v * h) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Subtle baseline so an empty canvas isn't black
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}
