// vendor/qr-code.js
// Thin wrapper around qrcode-generator (kazuhikoarase/qrcode-generator),
// MIT licensed, ~15KB minified. Has been the canonical JS QR library
// for over a decade.
//
// API exposed here:
//   qrCode(text, options) -> SVG string
//
// Options:
//   size: pixel size of the rendered QR (default 200)
//   margin: quiet zone in modules (default 4)
//   errorCorrection: 'L' | 'M' | 'Q' | 'H' (default 'L')

import qrcode from "qrcode-generator";

export function qrCode(text, options = {}) {
  const size = options.size || 200;
  const margin = options.margin ?? 4;
  const errorCorrection = options.errorCorrection || "L";

  // typeNumber 0 = auto-detect smallest QR version that fits the data.
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();

  // qrcode-generator's createSvgTag emits an SVG fragment with explicit
  // width/height. We replace those with our size and add viewBox so it
  // scales cleanly. cellSize doesn't matter when viewBox + scalable.
  const moduleCount = qr.getModuleCount();
  const totalModules = moduleCount + margin * 2;
  const svg = qr.createSvgTag({
    cellSize: 1,
    margin: margin,
    scalable: true,
  });
  // Inject size attributes.
  return svg
    .replace(
      /^<svg[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${totalModules} ${totalModules}" shape-rendering="crispEdges">`,
    );
}
