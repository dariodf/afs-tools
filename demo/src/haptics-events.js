// haptics-events.js
// Fires callbacks when playback position passes predefined event times.
//
// Used by the haptics demo for cannon events in the 1812 Overture.
// The events.json file contains a list of { time_ms, type, label }
// entries hand-annotated from the source audio. As the matcher
// reports new positions, this module checks whether any event is
// within a small window (±200ms) of the current position and fires
// the configured callback for each.
//
// State is kept per-event to avoid double-firing if the position
// crosses an event multiple times (e.g., during local-search wobble).

export class HapticsEventManager {
  constructor(events, onFire) {
    // events: [{ time_ms, type, label }, ...] sorted by time_ms.
    this.events = events.slice().sort((a, b) => a.time_ms - b.time_ms);
    this.onFire = onFire;
    // Map event index -> last fired wall time (or null).
    this.lastFiredAt = new Array(this.events.length).fill(null);
    // How close (in ms) the position must be to an event for it to fire.
    this.windowMs = 200;
    // How long after firing before the same event can fire again
    // (only matters if the user seeks backward and re-crosses the event).
    this.refireCooldownMs = 5000;
  }

  // Called by the demo whenever a new position is known. timeMs is
  // the source position in milliseconds; wallTimeMs is the local
  // performance.now() value for deduplication purposes.
  step(timeMs, wallTimeMs) {
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      const delta = timeMs - event.time_ms;
      if (Math.abs(delta) > this.windowMs) continue;
      const lastFired = this.lastFiredAt[i];
      if (lastFired != null && wallTimeMs - lastFired < this.refireCooldownMs) {
        continue;
      }
      this.lastFiredAt[i] = wallTimeMs;
      this.onFire(event);
    }
  }

  // Reset firing state (e.g., when the user re-loads the demo or seeks).
  reset() {
    this.lastFiredAt.fill(null);
  }
}
