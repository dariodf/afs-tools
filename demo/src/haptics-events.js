// haptics-events.js
// Schedules callbacks to fire at the precise wall-clock moments
// upcoming source-audio events occur.
//
// The naive pattern — "fire when matcher reports the position
// crossed an event" — has visible lag: the matcher itself reports
// positions ~50-250 ms after the actual sound (capture buffer, tick
// interval, chromaprint hop), so the haptic feels late. Cannon hits
// in particular feel wrong if they trail the audio.
//
// This module flips the model. It treats the matcher's position
// estimate as a clock reading and uses the *known* event timings
// (from e.g. overture-finale-cannons.json) to schedule each fire at
// the exact wall-clock moment that source position will be reached.
// `setTimeout` precision (a few ms in browsers) becomes the new
// floor for timing accuracy, instead of the tick interval.
//
// The predictionOffsetMs option compensates for the residual lag
// between when the source audio actually plays and when the matcher
// learns about it — i.e., the latency budget of capture + chromaprint
// + tick. Default 100 ms is a reasonable starting point for mic mode
// on a modern device; can be tuned (step 1), computed (step 2), or
// adapted live (step 3).

export class HapticsEventManager {
  // events: [{ time_ms, type, label }, ...] — source-relative event times
  // onFire: (event) => void — invoked at each scheduled wall-clock moment
  // options:
  //   predictionOffsetMs   — see module docstring (default 100)
  //   scheduleHorizonMs    — don't schedule events further out than this;
  //                          they'll be picked up by later step() calls when
  //                          the position estimate is fresher (default 5000)
  //   rescheduleThresholdMs — minimum drift in projected wall-clock target
  //                           before we cancel + reschedule on subsequent
  //                           ticks. Prevents setTimeout churn (default 30)
  //   schedule / cancel    — injectable for tests; default to setTimeout /
  //                          clearTimeout
  constructor(events, onFire, options = {}) {
    this.events = events.slice().sort((a, b) => a.time_ms - b.time_ms);
    this.onFire = onFire;
    this.predictionOffsetMs = options.predictionOffsetMs ?? 100;
    this.scheduleHorizonMs = options.scheduleHorizonMs ?? 5000;
    this.rescheduleThresholdMs = options.rescheduleThresholdMs ?? 30;
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? clearTimeout;

    // Per-event state:
    //   pending[i] = { handle, targetWallTime } if a fire is scheduled
    //   fired set of indices we've already fired or marked as missed
    this.pending = new Map();
    this.fired = new Set();
    this.lastPosition = null;
    this.lastWallTime = null;
  }

  // Called on each matcher tick with the latest position estimate.
  //   positionMs  — source-time position the matcher believes we're at
  //   wallTimeMs  — performance.now() captured at the time of the match
  //
  // Assumes real-time playback (1× speed). The demo doesn't support
  // variable playback rates; if we ever do, this is the spot to thread
  // a rate scaler through.
  step(positionMs, wallTimeMs) {
    this.lastPosition = positionMs;
    this.lastWallTime = wallTimeMs;

    for (let i = 0; i < this.events.length; i++) {
      if (this.fired.has(i)) continue;
      const event = this.events[i];
      const sourceDelta = event.time_ms - positionMs;

      // Event is in the past beyond what we'd fire compensating for
      // offset. Mark as missed; don't schedule a stale fire.
      if (sourceDelta < -this.predictionOffsetMs) {
        const pending = this.pending.get(i);
        if (pending) {
          this.cancel(pending.handle);
          this.pending.delete(i);
        }
        this.fired.add(i);
        continue;
      }

      // Event too far ahead to schedule yet. Skip; a later tick with
      // a fresher (more accurate) position will pick it up.
      if (sourceDelta > this.scheduleHorizonMs) continue;

      // Compute the wall-clock moment we want to fire. Subtract the
      // offset so we fire `offset` ms earlier than the naive
      // projection — compensating for the position being that-much
      // stale by the time the matcher reported it.
      const wallDelay = sourceDelta - this.predictionOffsetMs;
      const targetWallTime = wallTimeMs + wallDelay;

      const pending = this.pending.get(i);
      if (pending) {
        // Already scheduled; only reschedule if the new target has
        // drifted significantly. Saves setTimeout churn at the cost
        // of a small steady-state inaccuracy bounded by the
        // threshold (default 30 ms).
        if (Math.abs(targetWallTime - pending.targetWallTime) < this.rescheduleThresholdMs) {
          continue;
        }
        this.cancel(pending.handle);
      }

      const fireIndex = i;
      const handle = this.schedule(() => {
        this.pending.delete(fireIndex);
        this.fired.add(fireIndex);
        this.onFire(event);
      }, Math.max(0, wallDelay));

      this.pending.set(i, { handle, targetWallTime });
    }
  }

  // Update the prediction offset and refresh any pending schedules
  // so the new value takes effect immediately.
  setOffset(ms) {
    if (ms === this.predictionOffsetMs) return;
    this.predictionOffsetMs = ms;
    if (this.lastPosition != null) {
      // Clear pending schedules and re-derive them from the latest
      // known position. `fired` is preserved — we don't want a new
      // offset to un-fire past events.
      for (const { handle } of this.pending.values()) this.cancel(handle);
      this.pending.clear();
      this.step(this.lastPosition, this.lastWallTime);
    }
  }

  // Cancel all pending schedules and forget firing history. Use when
  // the user reloads a demo, seeks, or switches sources.
  reset() {
    for (const { handle } of this.pending.values()) this.cancel(handle);
    this.pending.clear();
    this.fired.clear();
    this.lastPosition = null;
    this.lastWallTime = null;
  }
}
