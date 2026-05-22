// srt-parser.js
// Parses SubRip Text (.srt) subtitle files.
//
// SRT format:
//   1
//   00:00:01,234 --> 00:00:03,456
//   First line of subtitle text
//   Second line of the same cue
//
//   2
//   00:00:04,000 --> 00:00:05,500
//   Next cue
//
// Output: an array of { index, start_ms, end_ms, text } objects.

const TIMESTAMP_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseTimestamp(h, m, s, ms) {
  return (
    parseInt(h, 10) * 3600000 +
    parseInt(m, 10) * 60000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms.padEnd(3, "0"), 10)
  );
}

export function parseSRT(text) {
  // Normalize line endings; strip BOM if present.
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    // The first line may be a numeric index; the timestamp line may be
    // first or second. Find the timestamp line.
    let tsLineIdx = -1;
    let match = null;
    for (let i = 0; i < Math.min(2, lines.length); i++) {
      const m = lines[i].match(TIMESTAMP_RE);
      if (m) {
        tsLineIdx = i;
        match = m;
        break;
      }
    }
    if (!match) continue;
    const index = tsLineIdx > 0 ? parseInt(lines[0], 10) : cues.length + 1;
    const start_ms = parseTimestamp(match[1], match[2], match[3], match[4]);
    const end_ms = parseTimestamp(match[5], match[6], match[7], match[8]);
    const text = lines.slice(tsLineIdx + 1).join("\n");
    cues.push({ index, start_ms, end_ms, text });
  }
  return cues;
}

// Find the cue (if any) active at a given time in milliseconds.
// Returns the latest cue whose [start_ms, end_ms] contains the time,
// or null if none.
//
// Cues are typically non-overlapping; in case of overlap, the latest
// (highest start_ms <= time) is returned.
export function findActiveCue(cues, time_ms) {
  // Cues come in chronological order; binary search the start.
  let lo = 0;
  let hi = cues.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (cues[mid].start_ms <= time_ms) lo = mid;
    else hi = mid - 1;
  }
  if (lo < 0 || lo >= cues.length) return null;
  const c = cues[lo];
  if (c.start_ms <= time_ms && time_ms <= c.end_ms) return c;
  return null;
}

// Serialize cues back to SRT text. Useful for the SRT-shift script
// and for verifying round-trips.
export function serializeSRT(cues) {
  const formatTime = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0") +
      "," +
      String(millis).padStart(3, "0")
    );
  };
  return cues
    .map(
      (c) =>
        `${c.index}\n${formatTime(c.start_ms)} --> ${formatTime(c.end_ms)}\n${c.text}`,
    )
    .join("\n\n");
}

// Shift every cue by deltaMs milliseconds. Negative values shift earlier.
// Cues that would end up with negative start_ms are dropped.
export function shiftCues(cues, deltaMs) {
  return cues
    .map((c) => ({
      ...c,
      start_ms: c.start_ms + deltaMs,
      end_ms: c.end_ms + deltaMs,
    }))
    .filter((c) => c.start_ms >= 0);
}
