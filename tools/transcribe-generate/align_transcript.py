#!/usr/bin/env python3
# align_transcript.py: forced-alignment of an existing transcript to
# audio, using WhisperX's wav2vec2 alignment stage only (no ASR).
#
# Invoked internally by the `transcribe-generate` bash script when the
# user passes --transcript. Not meant to be run directly: it expects
# WhisperX to be importable, which the project's `.venv-whisperx`
# Python provides.
#
# Transcript formats accepted:
#   - .srt — segmentation and rough timings are taken from the file;
#           alignment refines the timings.
#   - any other extension — treated as plain text. Sentence-split
#           heuristically; rough segment timings are distributed evenly
#           across the audio. The alignment model is robust to large
#           initial offsets.

import argparse
import re
import sys

import whisperx

SRT_TIMECODE = re.compile(
    r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)"
)


def parse_srt(text):
    blocks = re.split(r"\r?\n\r?\n+", text.strip())
    segments = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        time_idx = 0 if "-->" in lines[0] else 1
        if time_idx >= len(lines):
            continue
        m = SRT_TIMECODE.match(lines[time_idx])
        if not m:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = map(int, m.groups())
        start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
        end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000
        cue_text = " ".join(lines[time_idx + 1 :]).strip()
        if cue_text:
            segments.append({"start": start, "end": end, "text": cue_text})
    return segments


def segment_plain_text(text, audio_duration):
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(\[])", text.strip())
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return []
    span = audio_duration / len(sentences)
    return [
        {"start": i * span, "end": (i + 1) * span, "text": s}
        for i, s in enumerate(sentences)
    ]


def fmt_ts(seconds):
    seconds = max(seconds, 0.0)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, start=1):
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            f.write(f"{i}\n{fmt_ts(seg['start'])} --> {fmt_ts(seg['end'])}\n{text}\n\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--language", default="en")
    ap.add_argument("--output", required=True)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    audio = whisperx.load_audio(args.audio)
    audio_duration = len(audio) / 16000  # whisperx loads 16 kHz mono

    with open(args.transcript, "r", encoding="utf-8") as f:
        transcript_text = f.read()

    if args.transcript.lower().endswith(".srt"):
        segments = parse_srt(transcript_text)
        if not segments:
            print("align_transcript: no segments parsed from SRT", file=sys.stderr)
            sys.exit(1)
    else:
        segments = segment_plain_text(transcript_text, audio_duration)
        if not segments:
            print("align_transcript: transcript appears empty", file=sys.stderr)
            sys.exit(1)

    print(
        f"align_transcript: {len(segments)} segment(s) to align, "
        f"audio {audio_duration:.1f}s, device={args.device}",
        file=sys.stderr,
    )

    align_model, metadata = whisperx.load_align_model(
        language_code=args.language, device=args.device
    )

    aligned = whisperx.align(
        segments,
        align_model,
        metadata,
        audio,
        args.device,
        return_char_alignments=False,
    )

    write_srt(aligned["segments"], args.output)
    print(f"align_transcript: wrote {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
