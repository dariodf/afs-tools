// test/test-demo-session-lifecycle.js
// Verifies cleanup invariants for the long-running stateful
// objects in the demo: DemoSession and HapticsEventManager.
//
// These objects schedule timers, hold audio resources, and
// accumulate state across calls. Three bugs caught this session
// — clearTimeout's `this` binding, stale subtitle render after
// mode toggle, audio buffer never refilling after restart —
// would all have been surfaced by lifecycle-shaped tests like
// these.
//
// DemoSession.start() needs browser APIs (AudioContext,
// MediaElementSource) so we can't drive it end-to-end here. Instead
// we test:
//   - stop() before start: no-op, no throw
//   - stop() idempotent: calling twice is fine
//   - stop() clears internal references (matcher, capture, timer)
//   - directly manipulating internal state and calling stop()
//     verifies the cleanup path itself
//
// HapticsEventManager is plain JS with injectable schedule/cancel,
// so we exercise it more thoroughly:
//   - reset() clears pending Map AND fired Set AND last positions
//   - cancel called for every pending handle on reset
//   - step → reset → step re-schedules from scratch
//   - reset on never-stepped manager doesn't throw
//
// Run with: node test/test-demo-session-lifecycle.js

import { DemoSession } from "../demo/src/demo-session.js";
import { HapticsEventManager } from "../demo/src/haptics-events.js";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// -----------------------------------------------------------------
// DemoSession
// -----------------------------------------------------------------

// stop() before any start: must not throw, must leave state clean.
{
  const s = new DemoSession({ onPosition: () => {}, onStatus: () => {} });
  let threw = false;
  try { s.stop(); } catch (e) { threw = true; }
  check("DemoSession.stop() before start: no throw", !threw);
  check("DemoSession.stop() before start: matcher null", s.matcher === null);
  check("DemoSession.stop() before start: capture null", s.capture === null);
  check("DemoSession.stop() before start: matchTimer null", s.matchTimer === null);
  check("DemoSession.stop() before start: running false", s.running === false);
}

// Multiple stop() calls in a row should be safe (idempotent).
{
  const s = new DemoSession();
  let threw = false;
  try { s.stop(); s.stop(); s.stop(); } catch (e) { threw = true; }
  check("DemoSession.stop() idempotent: no throw on repeat", !threw);
}

// Simulate the post-start state by manipulating internals, then
// verify stop() clears everything. This catches "stop() forgot
// to null this.X" regressions.
{
  const s = new DemoSession();
  s.running = true;
  let captureStopCalled = false;
  s.capture = { stop: () => { captureStopCalled = true; } };
  let timerCleared = false;
  const fakeTimer = { fake: true };
  s.matchTimer = fakeTimer;
  // We can't replace clearInterval globally, but the test can verify
  // that stop() calls capture.stop() and clears matchTimer by
  // checking the references afterward.
  s.matcher = { dummy: true };

  s.stop();

  check("DemoSession.stop() simulated: capture.stop() called", captureStopCalled);
  check("DemoSession.stop() simulated: matchTimer cleared", s.matchTimer === null);
  check("DemoSession.stop() simulated: capture cleared", s.capture === null);
  check("DemoSession.stop() simulated: matcher cleared", s.matcher === null);
  check("DemoSession.stop() simulated: running flag cleared", s.running === false);
}

// _ensureLoaded throws when AFS not loaded — the demo relies on
// this to fail fast if start* is called before loadAFS.
{
  const s = new DemoSession();
  let threw = false;
  let msg = "";
  try { s._ensureLoaded(); } catch (e) { threw = true; msg = e.message; }
  check(
    "DemoSession._ensureLoaded() throws when AFS not loaded",
    threw && /loadAFS/.test(msg),
    msg,
  );
}

// -----------------------------------------------------------------
// HapticsEventManager
// -----------------------------------------------------------------

function makeFakeScheduler() {
  const calls = [];
  const cancellations = [];
  let nextHandle = 1;
  return {
    calls,
    cancellations,
    schedule: (cb, ms) => {
      const handle = nextHandle++;
      calls.push({ handle, cb, ms });
      return handle;
    },
    cancel: (handle) => { cancellations.push(handle); },
  };
}

// reset() on a never-stepped manager: just a no-op, no throw.
{
  const fake = makeFakeScheduler();
  const m = new HapticsEventManager(
    [{ time_ms: 1000, type: "cannon" }],
    () => {},
    { schedule: fake.schedule, cancel: fake.cancel },
  );
  let threw = false;
  try { m.reset(); } catch (e) { threw = true; }
  check("HapticsEventManager.reset() pre-step: no throw", !threw);
  check("HapticsEventManager.reset() pre-step: no cancels issued", fake.cancellations.length === 0);
}

// reset() after step(): cancel called once per pending handle.
{
  const fake = makeFakeScheduler();
  const events = [
    { time_ms: 1000, type: "a" },
    { time_ms: 2000, type: "b" },
    { time_ms: 3000, type: "c" },
  ];
  const m = new HapticsEventManager(events, () => {}, {
    schedule: fake.schedule,
    cancel: fake.cancel,
  });
  m.step(0, 0); // position 0, wallTime 0 — all 3 events within horizon
  check(
    "HapticsEventManager step(): scheduled all 3 events",
    fake.calls.length === 3,
    `scheduled=${fake.calls.length}`,
  );

  const pendingHandles = fake.calls.map((c) => c.handle);
  m.reset();

  check(
    "HapticsEventManager.reset(): cancel called once per pending",
    fake.cancellations.length === pendingHandles.length,
    `cancellations=${fake.cancellations.length}`,
  );
  check(
    "HapticsEventManager.reset(): pending map cleared",
    m.pending.size === 0,
  );
  check(
    "HapticsEventManager.reset(): fired set cleared",
    m.fired.size === 0,
  );
  check(
    "HapticsEventManager.reset(): lastPosition / lastWallTime cleared",
    m.lastPosition === null && m.lastWallTime === null,
  );
}

// step → reset → step should re-schedule from scratch (catches a
// regression where reset leaves stale state that prevents new
// scheduling).
{
  const fake = makeFakeScheduler();
  const m = new HapticsEventManager(
    [{ time_ms: 1000, type: "a" }],
    () => {},
    { schedule: fake.schedule, cancel: fake.cancel },
  );
  m.step(0, 0);
  m.reset();
  m.step(0, 1000); // different wall time, same position
  check(
    "HapticsEventManager step→reset→step: re-scheduled after reset",
    fake.calls.length === 2,
    `total scheduled=${fake.calls.length}`,
  );
}

// step() after firing all events: no more scheduling. Verifies the
// `fired` accumulator works the way the lifecycle expects.
{
  const fake = makeFakeScheduler();
  const m = new HapticsEventManager(
    [{ time_ms: 100, type: "x" }],
    () => {},
    { schedule: fake.schedule, cancel: fake.cancel, predictionOffsetMs: 0 },
  );
  m.step(0, 0);                        // schedules
  // Manually invoke the scheduled callback to simulate firing.
  fake.calls[0].cb();
  m.step(200, 200);                    // 200 ms later, event already fired
  check(
    "HapticsEventManager: post-fire step does not re-schedule",
    fake.calls.length === 1,
    `scheduled=${fake.calls.length}`,
  );
}

console.log("");
console.log(`test-demo-session-lifecycle: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
