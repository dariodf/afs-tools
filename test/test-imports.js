// test/test-imports.js
// Walks the demo's import graph from app.js and verifies that every
// import resolves to a real file. Catches:
//   - Missing files
//   - Bare specifiers not in the import map
//   - Renamed/moved files
//
// The vendor/ directory must be populated before running this test
// (the deploy workflow does this; see README.md for local setup).
//
// Run with: node test/test-imports.js

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../demo");

// Must match the importmap in demo/index.html exactly.
const IMPORT_MAP = {
  "smol-toml": "./vendor/smol-toml/index.js",
  "qrcode-generator": "./vendor/qrcode-generator/index.mjs",
  "@unimusic/chromaprint/dist/chromaprint.js": "./vendor/@unimusic/chromaprint/chromaprint.js",
};

const visited = new Set();
const errors = [];

async function check(file, importer) {
  const abs = path.resolve(file);
  if (visited.has(abs)) return;
  visited.add(abs);
  try {
    await fs.access(abs);
  } catch {
    errors.push(`${importer} -> ${path.relative(ROOT, abs)} (NOT FOUND)`);
    return;
  }
  const content = await fs.readFile(abs, "utf-8");
  // Strip line and block comments before matching so we don't pick
  // up imports inside comments (the chromaprint.js docs contain
  // example import strings we shouldn't try to resolve).
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Matches: import ... from "spec"  |  import "spec"  |  import("spec")
  const importRegex =
    /(?:^|[^a-zA-Z0-9_$])import\s*(?:[\s\S]+?from\s*)?\(?\s*["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(stripped)) !== null) {
    const spec = match[1];
    let resolved;
    if (spec in IMPORT_MAP) {
      resolved = path.resolve(ROOT, IMPORT_MAP[spec]);
    } else if (spec.startsWith(".") || spec.startsWith("/")) {
      resolved = path.resolve(path.dirname(abs), spec);
    } else {
      errors.push(
        `${path.relative(ROOT, abs)} -> bare specifier "${spec}" not in import map`,
      );
      continue;
    }
    await check(resolved, path.relative(ROOT, abs));
  }
}

// Walk from all four HTML entry points: the main demo, the two
// dedicated mic listen pages, and the browser-side AFS generator.
await check(path.join(ROOT, "app.js"), "(entry: index.html)");
await check(path.join(ROOT, "src/listen.js"), "(entry: listen.html)");
await check(path.join(ROOT, "src/listen-haptics.js"), "(entry: listen-haptics.html)");
await check(path.join(ROOT, "src/generate.js"), "(entry: generate.html)");

if (errors.length > 0) {
  console.error("Import resolution errors:");
  errors.forEach((e) => console.error("  " + e));
  console.error("");
  console.error(
    "If errors are in vendor/, run: mkdir -p demo/vendor/smol-toml demo/vendor/qrcode-generator demo/vendor/@unimusic/chromaprint && cp node_modules/smol-toml/dist/*.js demo/vendor/smol-toml/ && cp node_modules/qrcode-generator/dist/qrcode.mjs demo/vendor/qrcode-generator/index.mjs && cp node_modules/@unimusic/chromaprint/dist/{chromaprint.js,chromaprint.wasm} demo/vendor/@unimusic/chromaprint/",
  );
  process.exit(1);
}
console.log(`Checked ${visited.size} files; all imports resolve.`);
