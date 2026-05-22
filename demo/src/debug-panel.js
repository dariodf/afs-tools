// debug-panel.js
// In-browser diagnostic panel for the AFS matcher.
//
// Activated by adding ?debug=1 to the URL. Shows in real-time:
//   - Audio capture buffer level (peak amplitude)
//   - Recently captured fingerprint hashes
//   - Matcher's best position and confidence
//   - Hamming distance histogram between captured and stored hashes
//
// Use when the matcher fails to lock on, to diagnose whether the
// problem is in capture (silent mic), fingerprinting (consistent
// hashes but wrong), or matching (correct hashes but wrong position).

export class DebugPanel {
  constructor() {
    this.enabled = new URLSearchParams(window.location.search).has("debug");
    if (!this.enabled) return;

    this.el = document.createElement("div");
    this.el.id = "debug-panel";
    this.el.innerHTML = `
      <div class="debug-header">debug panel <button id="debug-close">×</button></div>
      <div class="debug-row"><span>peak amplitude:</span><span id="debug-amplitude">—</span></div>
      <div class="debug-row"><span>buffered samples:</span><span id="debug-buffer">—</span></div>
      <div class="debug-row"><span>captured hashes:</span><span id="debug-hashes-count">—</span></div>
      <div class="debug-row"><span>best match position:</span><span id="debug-position">—</span></div>
      <div class="debug-row"><span>match confidence:</span><span id="debug-confidence">—</span></div>
      <div class="debug-row"><span>matcher mode:</span><span id="debug-mode">—</span></div>
      <div class="debug-section">recent captured hashes (hex):</div>
      <div class="debug-hashes" id="debug-recent"></div>
      <div class="debug-section">hamming distance histogram:</div>
      <div class="debug-histogram" id="debug-histogram"></div>
    `;
    document.body.appendChild(this.el);
    document.getElementById("debug-close").addEventListener("click", () => {
      this.el.remove();
      this.enabled = false;
    });

    this.style = document.createElement("style");
    this.style.textContent = `
      #debug-panel {
        position: fixed;
        bottom: 0;
        right: 0;
        width: 320px;
        max-height: 80vh;
        overflow-y: auto;
        background: #1a1a1a;
        color: #0f0;
        font-family: monospace;
        font-size: 11px;
        padding: 8px;
        z-index: 9999;
        border-top-left-radius: 4px;
        opacity: 0.92;
      }
      .debug-header {
        font-weight: bold;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
      }
      #debug-close {
        background: transparent;
        color: #f44;
        border: none;
        font-size: 14px;
        cursor: pointer;
        padding: 0 6px;
      }
      .debug-row {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
      }
      .debug-section {
        margin-top: 8px;
        color: #888;
        font-size: 10px;
        text-transform: uppercase;
      }
      .debug-hashes {
        font-size: 10px;
        line-height: 1.4;
        word-break: break-all;
      }
      .debug-histogram {
        font-size: 10px;
        line-height: 1.2;
        white-space: pre;
      }
    `;
    document.head.appendChild(this.style);
  }

  // Update the panel with the latest capture + match data.
  update(data) {
    if (!this.enabled) return;
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    set("debug-amplitude", data.peakAmplitude?.toFixed(4) ?? "—");
    set("debug-buffer", `${data.bufferedSamples ?? 0} / ${data.bufferNeeded ?? "?"}`);
    set("debug-hashes-count", data.capturedHashes?.length ?? "—");
    set("debug-position", data.position != null ? `${(data.position / 1000).toFixed(2)}s` : "—");
    set("debug-confidence", data.confidence != null ? `${data.confidence.toFixed(1)}%` : "—");
    set("debug-mode", data.matcherMode ?? "—");

    if (data.capturedHashes && data.capturedHashes.length > 0) {
      const recent = Array.from(data.capturedHashes.slice(-8))
        .map((h) => h.toString(16).padStart(8, "0"))
        .join(" ");
      const recentEl = document.getElementById("debug-recent");
      if (recentEl) recentEl.textContent = recent;
    }

    if (data.histogram) {
      const max = Math.max(...data.histogram, 1);
      const lines = [];
      for (let i = 0; i <= 32; i++) {
        if (data.histogram[i] === 0) continue;
        const barLength = Math.round((data.histogram[i] / max) * 20);
        const bar = "█".repeat(barLength);
        lines.push(
          `${String(i).padStart(2)}: ${String(data.histogram[i]).padStart(4)} ${bar}`,
        );
      }
      const histEl = document.getElementById("debug-histogram");
      if (histEl) histEl.textContent = lines.join("\n");
    }
  }
}
