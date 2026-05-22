// subtitle-renderer.js
// Renders SRT subtitles to a DOM element, with toggleable AFS mode.
//
// In raw mode, the current subtitle is determined by the media
// element's currentTime (or the value passed via setRawTimeMs).
// In AFS mode, the current subtitle is determined by the matcher's
// latest reported position (via setAfsTimeMs).
//
// The renderer is independent of the matcher and the media element;
// the demo wires them together by calling setRawTimeMs from a rAF
// loop and setAfsTimeMs from the matcher's position callback.

import { findActiveCue } from "./srt-parser.js";

export class SubtitleRenderer {
  constructor(element, cues) {
    this.element = element;
    this.cues = cues;
    this.useAfs = false;
    this.rawTimeMs = 0;
    this.afsTimeMs = null;
    this.currentText = "";
  }

  setUseAfs(useAfs) {
    this.useAfs = useAfs;
    this.update();
  }

  setRawTimeMs(ms) {
    this.rawTimeMs = ms;
    if (!this.useAfs) this.update();
  }

  setAfsTimeMs(ms) {
    this.afsTimeMs = ms;
    if (this.useAfs) this.update();
  }

  update() {
    const time =
      this.useAfs && this.afsTimeMs != null ? this.afsTimeMs : this.rawTimeMs;
    const cue = findActiveCue(this.cues, time);
    const text = cue ? cue.text : "";
    if (text !== this.currentText) {
      this.currentText = text;
      this.element.textContent = text;
    }
  }
}
