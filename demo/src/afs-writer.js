// afs-writer.js
// Serializes chromaprint fingerprints into AFS v0.1 format.
//
// Used in two places:
//   1. The browser "make your own AFS" feature, when generating an AFS
//      file from in-browser audio decoding + chromaprint fingerprinting.
//   2. The afs-format CLI script, which uses Node.js to wrap this logic
//      around fpcalc output.
//
// The output is a complete .afs file as a string, ready to be written to
// disk or offered for download.

import { chromaprintCueMs } from "./chromaprint.js";

// Build an AFS v0.1 file from a Uint32Array of chromaprint hashes plus
// optional metadata. Returns the file content as a string.
//
// metadata fields (all optional):
//   generator         - tool name and version
//   generated_at      - ISO 8601 timestamp; defaults to now
//   audio.sample_rate_hz
//   audio.channels
//   audio.language
//   source.title
//   source.year
//   source.duration_ms
//   source.imdb_id
//   source.sha256
//   ...any custom fields (passed through)
//
// hashStartIndex lets you offset the body's time cues so the first
// hash represents the i-th chromaprint analysis frame from the start
// of the source rather than the 0-th. Useful for sparse files. Cues
// are computed with cumulative-correct rounding so different
// generators produce the same integer cue sequence.
//
// cueFn(i) returns the time cue (ms) for the i-th input hash. Defaults
// to the chromaprint cue function; override for other algorithms.
export function writeAFS(hashes, metadata = {}, options = {}) {
  const hashStartIndex = options.hashStartIndex ?? 0;
  const cueFn = options.cueFn ?? chromaprintCueMs;

  const lines = [];

  // Optional file-level comment header.
  if (options.comment) {
    for (const line of options.comment.split("\n")) {
      lines.push(`# ${line}`);
    }
    lines.push("");
  }

  // Required [afs] section.
  lines.push("[afs]");
  lines.push('version = "0.1"');
  lines.push("");

  // Required [fingerprint] section.
  lines.push("[fingerprint]");
  lines.push('algorithm = "chromaprint"');
  lines.push("");

  // Metadata, if any.
  const generatedAt = metadata.generated_at || new Date().toISOString();
  const generator = metadata.generator || "afs-writer-js 0.1.0";
  const hasMetadata =
    generator ||
    generatedAt ||
    metadata.audio ||
    metadata.source ||
    Object.keys(metadata).some(
      (k) => k !== "audio" && k !== "source" && k !== "generator" && k !== "generated_at",
    );
  if (hasMetadata) {
    lines.push("[metadata]");
    lines.push(`generator = ${tomlString(generator)}`);
    lines.push(`generated_at = ${tomlString(generatedAt)}`);
    // Pass through any custom top-level metadata fields.
    for (const [k, v] of Object.entries(metadata)) {
      if (k === "audio" || k === "source" || k === "generator" || k === "generated_at") {
        continue;
      }
      lines.push(`${k} = ${tomlValue(v)}`);
    }
    lines.push("");

    if (metadata.audio) {
      lines.push("[metadata.audio]");
      for (const [k, v] of Object.entries(metadata.audio)) {
        if (v != null) lines.push(`${k} = ${tomlValue(v)}`);
      }
      lines.push("");
    }
    if (metadata.source) {
      lines.push("[metadata.source]");
      for (const [k, v] of Object.entries(metadata.source)) {
        if (v != null) lines.push(`${k} = ${tomlValue(v)}`);
      }
      lines.push("");
    }
  }

  // Delimiter.
  lines.push("---");

  // Body: one "time_ms hash" per line. Cue is computed from the
  // absolute hash index so the sequence is the same across
  // implementations.
  for (let i = 0; i < hashes.length; i++) {
    const time_ms = cueFn(hashStartIndex + i);
    lines.push(`${time_ms} ${hashes[i] >>> 0}`);
  }
  lines.push(""); // trailing newline

  return lines.join("\n");
}

// Format a value as a TOML literal. Handles strings, numbers, booleans.
function tomlValue(v) {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  // Fallback: stringify and quote.
  return tomlString(String(v));
}

function tomlString(s) {
  // Basic TOML string: escape backslash, double quote, and control chars.
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
