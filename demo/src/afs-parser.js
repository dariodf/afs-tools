// afs-parser.js
// Parses AFS v0.1 files into a structured form.
//
// An AFS file is:
//   <TOML header>
//   ---
//   <body: one "time_ms payload" per line, # comments allowed>
//
// Output shape:
//   {
//     version: "0.1",
//     algorithm: "chromaprint",
//     metadata: { ... raw TOML metadata ... },
//     fingerprints: [{ time_ms: number, payload: string }, ...]
//   }
//
// TOML parsing is delegated to smol-toml, a small (~5KB minified+gzipped)
// fully-compliant TOML 1.0 parser. See:
//   https://www.npmjs.com/package/smol-toml
//
// In the demo, this is imported from a bundler (smol-toml as an npm
// dep) or a CDN ESM build. For Node.js tests, we use Node's built-in
// TOML support if available, falling back to smol-toml.

import { parse as parseToml } from "smol-toml";

const SUPPORTED_VERSIONS = ["0.1"];
const SUPPORTED_ALGORITHMS = ["chromaprint"];

export class AFSParseError extends Error {
  constructor(message, line) {
    super(line != null ? `Line ${line}: ${message}` : message);
    this.name = "AFSParseError";
    this.line = line;
  }
}

export function parseAFS(text) {
  // Split header from body at the first line that is exactly "---".
  const lines = text.split(/\r?\n/);
  let delimiterIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      delimiterIndex = i;
      break;
    }
  }
  if (delimiterIndex === -1) {
    throw new AFSParseError("missing '---' delimiter between header and body");
  }

  const headerText = lines.slice(0, delimiterIndex).join("\n");
  const bodyLines = lines.slice(delimiterIndex + 1);

  // Parse the TOML header.
  let header;
  try {
    header = parseToml(headerText);
  } catch (e) {
    throw new AFSParseError(`invalid TOML header: ${e.message}`);
  }

  // Validate required sections.
  if (!header.afs || typeof header.afs.version !== "string") {
    throw new AFSParseError("missing required [afs].version");
  }
  if (!header.fingerprint || typeof header.fingerprint.algorithm !== "string") {
    throw new AFSParseError("missing required [fingerprint].algorithm");
  }

  // Version check (major version match; minor versions within a major
  // are accepted, with algorithm validation handling forward compat).
  const major = header.afs.version.split(".")[0];
  const supportedMajors = SUPPORTED_VERSIONS.map((v) => v.split(".")[0]);
  if (!supportedMajors.includes(major)) {
    throw new AFSParseError(
      `unsupported AFS major version "${header.afs.version}"; this parser supports ${SUPPORTED_VERSIONS.join(", ")}`,
    );
  }

  // Algorithm check.
  if (!SUPPORTED_ALGORITHMS.includes(header.fingerprint.algorithm)) {
    throw new AFSParseError(
      `unsupported algorithm "${header.fingerprint.algorithm}"; this parser supports ${SUPPORTED_ALGORITHMS.join(", ")}`,
    );
  }

  // Parse the body.
  const fingerprints = [];
  let lastTime = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const raw = bodyLines[i];
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;

    // Split on the first run of whitespace (space or tab). Spec §4.1
    // allows one or more whitespace characters as the separator.
    const wsMatch = trimmed.match(/[ \t]+/);
    if (!wsMatch) {
      throw new AFSParseError(
        `body line missing payload: "${trimmed}"`,
        delimiterIndex + 1 + i + 1,
      );
    }
    const splitAt = wsMatch.index;
    const timeStr = trimmed.slice(0, splitAt);
    const payload = trimmed.slice(splitAt + wsMatch[0].length).trim();
    const time_ms = parseInt(timeStr, 10);
    if (!Number.isFinite(time_ms) || time_ms < 0) {
      throw new AFSParseError(
        `invalid time cue "${timeStr}"`,
        delimiterIndex + 1 + i + 1,
      );
    }
    if (time_ms < lastTime) {
      throw new AFSParseError(
        `time cue ${time_ms} out of order (previous was ${lastTime})`,
        delimiterIndex + 1 + i + 1,
      );
    }
    lastTime = time_ms;
    fingerprints.push({ time_ms, payload });
  }

  return {
    version: header.afs.version,
    algorithm: header.fingerprint.algorithm,
    metadata: header.metadata || {},
    fingerprints,
  };
}

// For chromaprint specifically, convert the parsed body into a
// Uint32Array of hashes paired with a Float64Array of times in ms.
// This is what the matcher uses.
export function chromaprintArrays(parsed) {
  if (parsed.algorithm !== "chromaprint") {
    throw new Error(
      `chromaprintArrays: expected chromaprint algorithm, got ${parsed.algorithm}`,
    );
  }
  const n = parsed.fingerprints.length;
  const hashes = new Uint32Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fp = parsed.fingerprints[i];
    const h = parseInt(fp.payload, 10);
    if (!Number.isFinite(h) || h < 0 || h > 0xffffffff) {
      throw new Error(
        `invalid chromaprint hash "${fp.payload}" at time ${fp.time_ms}`,
      );
    }
    hashes[i] = h >>> 0; // ensure uint32
    times[i] = fp.time_ms;
  }
  return { hashes, times };
}
