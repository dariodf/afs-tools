#!/usr/bin/env python3
"""chroma + DTW spike

Three escalating tests to derisk performance-to-performance audio
alignment via chroma vectors + dynamic time warping:

  1. Controlled self-test: take silent-night.mp3, time-stretch a
     copy by 10 %, DTW them together. Ground truth is known
     exactly — the alignment path should be a ~10 %-stretched
     diagonal. If this fails, the fundamentals are broken.

  2. Cross-performance test: align the 1990 USAF Singing
     Sergeants Silent Night against the 2006 USAF Singing
     Sergeants Silent Night (same ensemble, different year,
     different arrangement length). Tests whether DTW can find
     "the same musical content" inside a recording that's almost
     twice as long.

  3. Transposition test (optional): take silent-night.mp3,
     pitch-shift up a major third (4 semitones), then DTW with
     chroma rotation — try all 12 rotations of the captured
     chroma vector, pick the best. This is the karaoke-Japan
     use case if the machine plays the song in a different key.

Run: ./spike.py [test_number]
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import librosa
import matplotlib
matplotlib.use("Agg")  # no display needed; we write PNGs
import matplotlib.pyplot as plt
import numpy as np


HERE = Path(__file__).parent
REPO_ROOT = HERE.parent.parent
DEMO_CONTENT = REPO_ROOT / "demo" / "content"
WORK = Path("/tmp/afs-chroma-dtw")
WORK.mkdir(exist_ok=True)


def load_chroma(audio_path: Path, hop_length: int = 4096, sr: int = 22050):
    """Return (chroma 12×T, frame_times in seconds).

    librosa's chroma_stft already L2-normalizes by default (norm=inf
    in older versions, max in newer). Manual re-normalization
    introduces NaN for near-silent frames; the library handles
    them gracefully via its internal smoothing.
    """
    y, sr_actual = librosa.load(str(audio_path), sr=sr, mono=True)
    chroma = librosa.feature.chroma_stft(y=y, sr=sr_actual, hop_length=hop_length)
    # Replace any residual NaN/Inf with a uniform distribution so
    # the DTW cosine metric stays well-defined for silent frames.
    chroma = np.nan_to_num(chroma, nan=0.0, posinf=0.0, neginf=0.0)
    # Where a frame's total energy is essentially zero, give it a
    # tiny uniform vector instead of all-zero (cosine of zero is
    # undefined and propagates NaN through the DTW matrix).
    frame_norms = np.linalg.norm(chroma, axis=0)
    silent = frame_norms < 1e-6
    if silent.any():
        chroma[:, silent] = 1.0 / 12.0
    frame_times = librosa.frames_to_time(
        np.arange(chroma.shape[1]), sr=sr_actual, hop_length=hop_length
    )
    return chroma, frame_times


def run_dtw(ref_chroma: np.ndarray, live_chroma: np.ndarray):
    """Cost matrix + warping path between reference and live chroma.

    Returns:
      cost:  T_ref × T_live accumulated cost matrix
      path:  list of (i_ref, j_live) frame indices in alignment order
    """
    t0 = time.time()
    D, wp = librosa.sequence.dtw(
        X=ref_chroma,
        Y=live_chroma,
        metric="cosine",
        # Subseq=False here means we align A entirely against B.
        # For the karaoke use case we'll want subseq=True later (B
        # is the live capture, A is the full reference, and we
        # want to find WHERE B fits inside A).
        subseq=False,
    )
    elapsed_ms = (time.time() - t0) * 1000
    return D, wp, elapsed_ms


def plot_path(cost: np.ndarray, path: np.ndarray, title: str, out: Path):
    fig, ax = plt.subplots(figsize=(8, 8))
    ax.imshow(cost, origin="lower", aspect="auto", cmap="magma", interpolation="nearest")
    # wp is returned as (path_len, 2) of (i, j) pairs in reverse order
    ax.plot(path[:, 1], path[:, 0], color="cyan", linewidth=1.5)
    ax.set_xlabel("live frame (B)")
    ax.set_ylabel("reference frame (A)")
    ax.set_title(title)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)
    print(f"  → wrote alignment plot: {out}")


def stretch_audio(src: Path, dst: Path, factor: float):
    """ffmpeg atempo for time-stretch without pitch change.

    factor > 1.0 → faster; < 1.0 → slower. atempo accepts 0.5..2.0
    per filter, so we don't need chaining for ±10 %.
    """
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-filter:a", f"atempo={factor}",
            str(dst),
        ],
        check=True,
    )


# --------------------------------------------------------------------
# Test 1: controlled time-stretched self-DTW
# --------------------------------------------------------------------

def test1_controlled():
    print("\n=== Test 1: controlled self-DTW (silent-night + 10% slower copy) ===")
    src = DEMO_CONTENT / "silent-night.mp3"
    stretched = WORK / "silent-night.slow.mp3"
    if not stretched.exists():
        print(f"  stretching {src.name} → {stretched.name} (atempo=0.9, 10% slower)")
        stretch_audio(src, stretched, 0.9)

    print("  loading chroma...")
    A, A_times = load_chroma(src)
    B, B_times = load_chroma(stretched)
    print(f"  A: {A.shape[1]} frames, {A_times[-1]:.1f}s")
    print(f"  B: {B.shape[1]} frames, {B_times[-1]:.1f}s")
    print(f"  expected ratio: {B_times[-1] / A_times[-1]:.3f} (≈ 1.111 for 10% slower)")

    print("  running DTW...")
    D, wp, dtw_ms = run_dtw(A, B)
    print(f"  DTW took {dtw_ms:.0f} ms; path has {len(wp)} steps")

    # Path validation: slope. For 10% slower B, each ref frame i
    # should correspond to ≈1.11 live frames j. Sample the path at
    # various points and check.
    print("  spot-checking path slope at known landmarks:")
    samples = [0.2, 0.4, 0.6, 0.8]
    # wp is reverse order (last frame first). Reverse it for easier indexing.
    wp_fwd = wp[::-1]
    for frac in samples:
        target_i = int(A.shape[1] * frac)
        # Find the first path entry where ref index >= target_i
        idx = np.searchsorted(wp_fwd[:, 0], target_i)
        if idx >= len(wp_fwd):
            continue
        i_ref, j_live = wp_fwd[idx]
        ref_time = A_times[i_ref]
        live_time = B_times[j_live]
        ratio = live_time / ref_time if ref_time > 0 else float("nan")
        print(f"    ref t={ref_time:5.1f}s → live t={live_time:5.1f}s   (ratio {ratio:.3f})")

    plot_path(
        D, wp_fwd,
        "Test 1: silent-night ↔ silent-night 10% slower (expect ~1.11 slope)",
        WORK / "test1_controlled.png",
    )


# --------------------------------------------------------------------
# Test 2: cross-performance DTW (1990 vs 2006 Singing Sergeants)
# --------------------------------------------------------------------

def test2_cross_perf():
    print("\n=== Test 2: 1990 vs 2006 USAF Singing Sergeants Silent Night ===")
    src1990 = DEMO_CONTENT / "silent-night.mp3"
    src2006 = WORK / "silent-night-2006.mp3"
    if not src2006.exists():
        print(f"  downloading 2006 recording to {src2006}...")
        subprocess.run([
            "curl", "-fsSL", "-o", str(src2006),
            "https://upload.wikimedia.org/wikipedia/commons/8/8e/Silent_Night_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3"
        ], check=True)
        print(f"  downloaded ({src2006.stat().st_size // 1024} KB)")

    print("  loading chroma...")
    A, A_times = load_chroma(src1990)
    B, B_times = load_chroma(src2006)
    print(f"  A (1990): {A.shape[1]} frames, {A_times[-1]:.1f}s")
    print(f"  B (2006): {B.shape[1]} frames, {B_times[-1]:.1f}s")

    print("  running DTW (subseq=True: find A's content inside B)...")
    t0 = time.time()
    D, wp = librosa.sequence.dtw(X=A, Y=B, metric="cosine", subseq=True)
    elapsed_ms = (time.time() - t0) * 1000
    print(f"  DTW took {elapsed_ms:.0f} ms; path has {len(wp)} steps")

    wp_fwd = wp[::-1]
    # In subseq mode the path tells us where A maps inside B.
    j_start = wp_fwd[0, 1]
    j_end = wp_fwd[-1, 1]
    print(f"  alignment span in B (2006): {B_times[j_start]:.1f}s → {B_times[j_end]:.1f}s")
    print(f"  vs A (1990) full duration: {A_times[-1]:.1f}s")

    # Spot-check known lyric moments in A and see where they land in B.
    # silent-night.srt has these cue starts (from our hand-corrected file):
    landmarks = [
        ("Silent night, holy night",       1.8),
        ("All is calm, all is bright",     15.3),
        ("Round yon Virgin Mother...",     28.5),
        ("Holy Infant, so tender...",      41.0),
        ("Sleep in heavenly peace #1",     53.4),
        ("Sleep in heavenly peace #2",     67.7),
        ("Sleep in heavenly peace #3",     82.0),
    ]
    print("\n  lyric landmarks (1990 reference) → predicted location in 2006:")
    for label, t_1990 in landmarks:
        # Find path entry closest to this reference time
        i_target = np.searchsorted(A_times, t_1990)
        idx = np.searchsorted(wp_fwd[:, 0], i_target)
        if idx >= len(wp_fwd):
            print(f"    {t_1990:5.1f}s '{label}' → (past end of path)")
            continue
        i_ref, j_live = wp_fwd[idx]
        print(f"    {t_1990:5.1f}s '{label[:34]:34}' → {B_times[j_live]:5.1f}s in 2006")

    plot_path(
        D, wp_fwd,
        "Test 2: 1990 (1:56) ↔ 2006 (3:17) Silent Night",
        WORK / "test2_cross_perf.png",
    )


# --------------------------------------------------------------------
# Test 3: real cross-performance on a through-composed aria
# --------------------------------------------------------------------

NESSUN_DORMA_LANDMARKS_LAZZARO = [
    # Approximate timestamps inside Lazzaro 1926 — exact moments
    # are easy to confirm by listening, but the order is fixed
    # because the aria is through-composed: each line of the
    # libretto appears exactly once.
    ("orchestral intro start",      0.0),
    ("'Nessun dorma!' first phrase", 25.0),
    ("'Il nome mio nessun saprà'",   55.0),
    ("middle section / women's chorus", 80.0),
    ("'Dilegua, o notte!'",          135.0),
    ("'All'alba vincerò!'",          160.0),
    ("final 'Vincerò!' climax",      190.0),
]


def test3_nessun_dorma():
    print("\n=== Test 3: Nessun dorma — Lazzaro 1926 vs Cortis 1929 ===")
    lazzaro = WORK / "nessun-dorma-lazzaro-1926.mp3"
    cortis = WORK / "nessun-dorma-cortis-1929.mp3"
    if not lazzaro.exists():
        print(f"  downloading Lazzaro 1926 → {lazzaro.name}")
        subprocess.run([
            "curl", "-fsSL", "-o", str(lazzaro),
            "https://archive.org/download/hipolito-lazzaro-giacomo-puccini-turandot-nessun-dorma-columbia-gqx-10139/"
            "HipolitoLazzaro%2CGiacomoPuccini%2CTurandot%2CNessunDorma%2CColumbiaGQX10139.mp3",
        ], check=True)
    if not cortis.exists():
        print(f"  downloading Cortis 1929 → {cortis.name}")
        subprocess.run([
            "curl", "-fsSL", "-o", str(cortis),
            "https://archive.org/download/antonio-cortis-giacomo-puccini-turandot-nessun-dorma-gramophone-da-1075/"
            "AntonioCortis%2CGiacomoPuccini%2CTurandot%2CNessunDorma%2CGramophoneDA1075.mp3",
        ], check=True)
    print(f"  Lazzaro: {lazzaro.stat().st_size // 1024} KB")
    print(f"  Cortis : {cortis.stat().st_size // 1024} KB")

    print("  loading chroma...")
    A, A_times = load_chroma(lazzaro)
    B, B_times = load_chroma(cortis)
    print(f"  A (Lazzaro 1926): {A.shape[1]} frames, {A_times[-1]:.1f}s")
    print(f"  B (Cortis 1929) : {B.shape[1]} frames, {B_times[-1]:.1f}s")

    print("  running DTW (full alignment, subseq=False)...")
    t0 = time.time()
    D, wp = librosa.sequence.dtw(X=A, Y=B, metric="cosine", subseq=False)
    elapsed_ms = (time.time() - t0) * 1000
    print(f"  DTW took {elapsed_ms:.0f} ms; path has {len(wp)} steps")
    wp_fwd = wp[::-1]

    # Two performances of the same aria: the path should be a
    # roughly diagonal line from (0,0) to (T_A, T_B). Slope tells
    # us relative tempo (Lazzaro is 212s, Cortis is 184s, so
    # expected average slope ≈ 0.87 — Cortis is faster).
    expected_slope = B_times[-1] / A_times[-1]
    print(f"  expected average B/A slope: {expected_slope:.3f}")
    print()
    print("  Lazzaro landmark → predicted Cortis location:")
    for label, t_lazzaro in NESSUN_DORMA_LANDMARKS_LAZZARO:
        if t_lazzaro >= A_times[-1]:
            continue
        i_target = np.searchsorted(A_times, t_lazzaro)
        idx = np.searchsorted(wp_fwd[:, 0], i_target)
        if idx >= len(wp_fwd):
            continue
        i_ref, j_live = wp_fwd[idx]
        t_cortis = B_times[j_live]
        # The naive expectation if tempos were identical:
        t_naive = t_lazzaro * expected_slope
        print(
            f"    {t_lazzaro:5.1f}s '{label[:38]:38}' "
            f"→ {t_cortis:5.1f}s (vs naive linear {t_naive:5.1f}s, Δ {abs(t_cortis - t_naive):4.1f}s)"
        )

    plot_path(
        D, wp_fwd,
        "Test 3: Nessun dorma — Lazzaro 1926 ↔ Cortis 1929",
        WORK / "test3_nessun_dorma.png",
    )


# --------------------------------------------------------------------
# Test 4: Beethoven 5 1st movement — does motif repetition break DTW?
# --------------------------------------------------------------------
#
# The four-note motif (G-G-G-Eb) recurs throughout the movement.
# Hypothesis: full-DTW (subseq=False, both performances are full
# pieces) is robust to motif repetition because the path is
# constrained to be monotonic — it can't jump between motif
# statements. We test this with pure chroma, then again with
# chroma+onset features stacked, to see if onsets meaningfully
# improve disambiguation.


def load_features(audio_path: Path, hop_length: int = 4096, sr: int = 22050):
    """Return chroma (12×T), onset_strength (1×T), times.

    Same hop_length for both so they line up.
    """
    y, sr_actual = librosa.load(str(audio_path), sr=sr, mono=True)
    chroma = librosa.feature.chroma_stft(y=y, sr=sr_actual, hop_length=hop_length)
    chroma = np.nan_to_num(chroma)
    silent = np.linalg.norm(chroma, axis=0) < 1e-6
    if silent.any():
        chroma[:, silent] = 1.0 / 12.0
    onset = librosa.onset.onset_strength(
        y=y, sr=sr_actual, hop_length=hop_length
    )
    # Trim onset to chroma's length (they should match; sometimes
    # off by one due to framing differences).
    n = min(chroma.shape[1], onset.shape[0])
    chroma = chroma[:, :n]
    onset = onset[:n]
    times = librosa.frames_to_time(np.arange(n), sr=sr_actual, hop_length=hop_length)
    return chroma, onset, times


def evaluate_path(wp_fwd: np.ndarray, A_times: np.ndarray, B_times: np.ndarray, label: str):
    """Score the DTW path. A good cross-performance alignment is
    monotonic (both indices strictly nondecreasing), roughly
    diagonal (expected slope = T_B / T_A), and has reasonable local
    smoothness. This function reports the basics so we can compare
    feature variants.
    """
    expected_slope = B_times[-1] / A_times[-1]
    # Per-step deltas in B-index.
    deltas_b = np.diff(wp_fwd[:, 1])
    deltas_a = np.diff(wp_fwd[:, 0])
    # Monotonicity is guaranteed by DTW; sanity-check it.
    assert (deltas_a >= 0).all() and (deltas_b >= 0).all(), "path not monotonic"
    # Average slope.
    total_a = wp_fwd[-1, 0] - wp_fwd[0, 0]
    total_b = wp_fwd[-1, 1] - wp_fwd[0, 1]
    actual_slope = total_b / total_a if total_a > 0 else float("nan")
    # Max single-step horizontal run (a long run of `deltas_a == 0`
    # means the path stalled in A — a sign of motif-repetition
    # confusion). Same for vertical.
    horiz_runs = (deltas_a == 0).astype(int)
    vert_runs = (deltas_b == 0).astype(int)
    # Longest run lengths.
    def longest_run(arr):
        best = run = 0
        for x in arr:
            run = run + 1 if x else 0
            best = max(best, run)
        return best
    print(f"  {label}:")
    print(f"    expected slope: {expected_slope:.3f}")
    print(f"    actual slope:   {actual_slope:.3f}")
    print(f"    path steps:     {len(wp_fwd)}")
    print(f"    longest horiz stall (A frozen): {longest_run(horiz_runs)} steps")
    print(f"    longest vert  stall (B frozen): {longest_run(vert_runs)} steps")


def _localize_test(ref_path: Path, label: str, test_cases, window_sizes=(5, 15, 30)):
    """Generic localization stress test.

    Treats `ref_path` as the reference. For each `(label, t_end,
    note)` in `test_cases`, extracts the window of audio ending
    at `t_end` from the reference itself, then asks subseq-DTW
    to find where in the reference this window came from. The
    "correct" answer is at t_end. Errors > 2 s are marked failed.

    Varying `window_sizes` shows whether longer context resolves
    motif / strophic-verse ambiguity.
    """
    print(f"\n=== {label} ===")
    print("  loading reference chroma...")
    ref_chroma, ref_times = load_chroma(ref_path)
    print(f"  reference: {ref_chroma.shape[1]} frames, {ref_times[-1]:.1f}s")

    for tc_label, t_end, note in test_cases:
        print(f"\n  --- {tc_label} at t={t_end}s  ({note}) ---")
        for win in window_sizes:
            t_start = max(0, t_end - win)
            slice_wav = WORK / f"_slice_{int(t_start)}-{int(t_end)}.wav"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", str(t_start), "-t", str(t_end - t_start),
                "-i", str(ref_path),
                "-ar", "22050", "-ac", "1",
                str(slice_wav),
            ], check=True)
            slice_chroma, _ = load_chroma(slice_wav)
            try:
                D, wp = librosa.sequence.dtw(
                    X=slice_chroma, Y=ref_chroma, metric="cosine", subseq=True
                )
            except Exception as e:
                print(f"    win={win:2}s: DTW failed: {e}")
                continue
            wp_fwd = wp[::-1]
            j_end = wp_fwd[-1, 1]
            j_start = wp_fwd[0, 1]
            predicted_end = ref_times[j_end]
            predicted_start = ref_times[j_start]
            error = abs(predicted_end - t_end)
            ok = "✓" if error < 2.0 else "✗"
            print(
                f"    win={win:2}s: predicted = [{predicted_start:5.1f}..{predicted_end:5.1f}]s   "
                f"(true end {t_end:5.1f}s, err {error:5.1f}s) {ok}"
            )
            slice_wav.unlink(missing_ok=True)


def test5_nessun_dorma_localize():
    """Through-composed positive case: each phrase appears exactly
    once in Nessun dorma. Localization should always succeed.
    """
    ref = WORK / "nessun-dorma-cortis-1929.mp3"
    if not ref.exists():
        print("\n  (need Cortis Nessun dorma from Test 3 first)")
        return
    # Timestamps confirmed from earlier WhisperX transcription
    # of Cortis 1929:
    #   1.3-14.6s : "Nessun dorma, nessun dorma"
    #   16.5-46s  : "tu pure o principessa..."
    #   47-77s    : "Ma il mio mistero / Il nome mio nessun saprà"
    #   83-109s   : "Per il mio bacio..."
    #   146-175s  : "Vincerò! Vincerò! Vincerò!"
    test_cases = [
        ("'Nessun dorma' opening",        13.0,  "first phrase"),
        ("'tu pure o principessa'",       40.0,  "second phrase"),
        ("'Il nome mio nessun saprà'",    70.0,  "middle"),
        ("'Per il mio bacio'",           105.0,  "late middle"),
        ("'Vincerò!' climax",            170.0,  "final climax"),
    ]
    _localize_test(ref, "Test 5a: Nessun dorma (through-composed)", test_cases)


def test5_silent_night_localize():
    """Strophic-verse stress case: Verse 1 and Verse 2 of Silent
    Night share the same melody. The interesting test is whether
    a V2 capture localizes to its true V2 position or gets
    confused with V1.
    """
    ref = WORK / "silent-night-2006.mp3"
    if not ref.exists():
        print("\n  (need silent-night-2006.mp3 from Test 2 first)")
        return
    test_cases = [
        ("V1 'holy night'",                15.0,  "verse 1 opening"),
        ("V1 'all is bright'",             40.0,  "verse 1 middle"),
        ("V1 'Sleep in heavenly peace'",   90.0,  "verse 1 closing"),
        ("V2 'holy night'",               115.0,  "verse 2 — SAME melody as V1 'holy night'"),
        ("V2 'Christ the Savior'",        155.0,  "verse 2 climax"),
    ]
    _localize_test(ref, "Test 5b: Silent Night (strophic verses)", test_cases)


def test5():
    test5_nessun_dorma_localize()
    test5_silent_night_localize()


def test4_beethoven5():
    print("\n=== Test 4: Beethoven 5 1st mvt — motif-repetition stress test ===")
    fate = WORK / "beethoven5-1st-fate.mp3"
    cso = WORK / "beethoven5-1st-cso.mp3"
    if not fate.exists():
        print(f"  downloading 'fate' recording → {fate.name}")
        subprocess.run([
            "curl", "-fsSL", "-o", str(fate),
            "https://archive.org/download/BeethovenSymphonyNo.5InCMinorOp.67fate/1.AllegroConBrio.mp3",
        ], check=True)
    if not cso.exists():
        print(f"  downloading CSO recording → {cso.name}")
        subprocess.run([
            "curl", "-fsSL", "-o", str(cso),
            "https://archive.org/download/CsoBeethovenSymphonyNo.5Fm96-24/07-b5-allegroConBrio.mp3",
        ], check=True)
    print(f"  fate: {fate.stat().st_size // 1024} KB")
    print(f"  CSO : {cso.stat().st_size // 1024} KB")

    print("  loading chroma + onset for both...")
    A_chroma, A_onset, A_times = load_features(fate)
    B_chroma, B_onset, B_times = load_features(cso)
    print(f"  A (fate): {A_chroma.shape[1]} frames, {A_times[-1]:.1f}s")
    print(f"  B (CSO ): {B_chroma.shape[1]} frames, {B_times[-1]:.1f}s")

    # Variant 1: pure chroma.
    print("\n  Variant 1: pure chroma DTW")
    t0 = time.time()
    D1, wp1 = librosa.sequence.dtw(X=A_chroma, Y=B_chroma, metric="cosine", subseq=False)
    print(f"    DTW took {(time.time() - t0)*1000:.0f} ms")
    evaluate_path(wp1[::-1], A_times, B_times, "chroma alone")

    # Variant 2: chroma + onset. Stack them as a 13-dim feature.
    # Normalize onset to roughly chroma's magnitude range so neither
    # dominates the cosine distance.
    A_onset_n = (A_onset - A_onset.mean()) / (A_onset.std() + 1e-9)
    B_onset_n = (B_onset - B_onset.mean()) / (B_onset.std() + 1e-9)
    # Scale onset down so it's comparable to a single chroma row's
    # magnitude (chroma rows are 0..1ish).
    onset_weight = 0.5
    A_feat = np.vstack([A_chroma, A_onset_n[None, :] * onset_weight])
    B_feat = np.vstack([B_chroma, B_onset_n[None, :] * onset_weight])
    print("\n  Variant 2: chroma + onset DTW (13-dim feature)")
    t0 = time.time()
    D2, wp2 = librosa.sequence.dtw(X=A_feat, Y=B_feat, metric="cosine", subseq=False)
    print(f"    DTW took {(time.time() - t0)*1000:.0f} ms")
    evaluate_path(wp2[::-1], A_times, B_times, "chroma + onset")

    # Compare: how different are the two paths?
    wp1f, wp2f = wp1[::-1], wp2[::-1]
    # Sample both paths at equal A-fractions and compute |B difference|.
    samples = np.linspace(0.1, 0.9, 9)
    print("\n  Per-position path divergence (|chroma B - (chroma+onset) B|):")
    for frac in samples:
        i_target = int(A_chroma.shape[1] * frac)
        idx1 = np.searchsorted(wp1f[:, 0], i_target)
        idx2 = np.searchsorted(wp2f[:, 0], i_target)
        if idx1 >= len(wp1f) or idx2 >= len(wp2f):
            continue
        j1 = wp1f[idx1, 1]
        j2 = wp2f[idx2, 1]
        t_a = A_times[i_target]
        t1 = B_times[j1]
        t2 = B_times[j2]
        print(f"    fate t={t_a:6.1f}s  →  chroma:{t1:6.1f}s   chroma+onset:{t2:6.1f}s   Δ {abs(t2-t1):4.1f}s")

    plot_path(D1, wp1f, "Test 4a: Beethoven 5 1st mvt — chroma only", WORK / "test4a_b5_chroma.png")
    plot_path(D2, wp2f, "Test 4b: Beethoven 5 1st mvt — chroma + onset", WORK / "test4b_b5_chroma_onset.png")


# --------------------------------------------------------------------
# main
# --------------------------------------------------------------------

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("1", "all"):
        test1_controlled()
    if which in ("2", "all"):
        test2_cross_perf()
    if which in ("3", "all"):
        test3_nessun_dorma()
    if which in ("4", "all"):
        test4_beethoven5()
    if which in ("5", "all"):
        test5()
    print(f"\nDone. Plots in {WORK}/")
