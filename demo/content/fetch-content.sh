#!/usr/bin/env bash
# fetch-content.sh
# Downloads the source media files for the AFS demos from their
# original (CC-licensed or public-domain) sources.
#
# Run from the demo/content/ directory:
#   bash fetch-content.sh
#
# Produces:
#   tearsofsteel-full.mp4       (~400MB, Tears of Steel full film)
#   1812-overture-full.mp3      (~30MB, full overture)
#   tearsofsteel.en.srt         (Tears of Steel English subtitles)
#   cannon-shot-source.ogv      (~1MB, WWI howitzer firing, PD)
#
# After running this script, follow the production steps in
# README.md to trim each source down to the demo-sized clips.

set -euo pipefail

cd "$(dirname "$0")"

echo "fetch-content.sh: downloading source media..."

# Tears of Steel (Blender Foundation, CC-BY 3.0)
# The Blender Foundation hosts multiple resolutions. The 720p version
# is a reasonable middle ground for demo purposes.
if [[ ! -f tearsofsteel-full.mp4 ]]; then
  echo "  fetching Tears of Steel (720p, ~120MB)..."
  curl -L -o tearsofsteel-full.mp4 \
    'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov' \
    || echo "  WARNING: Tears of Steel download failed; check the URL"
else
  echo "  tearsofsteel-full.mp4 already exists"
fi

# Tears of Steel English subtitles (Wikimedia Commons, CC-BY-SA 4.0)
if [[ ! -f tearsofsteel.en.srt ]]; then
  echo "  fetching Tears of Steel SRT..."
  curl -L -o tearsofsteel.en.srt \
    'https://commons.wikimedia.org/w/index.php?title=TimedText:Tears_of_Steel_in_4k_-_Official_Blender_Foundation_release.webm.en.srt&action=raw' \
    || echo "  WARNING: SRT download failed; check the URL"
else
  echo "  tearsofsteel.en.srt already exists"
fi

# 1812 Overture - U.S. Army Band, 2005 (Public Domain).
# Federal government work; OGG container, ~10 MB. Trimmed in README.md
# down to the last ~71 seconds (the finale with cannons), then
# transcoded to MP3 for cross-browser <audio> compatibility.
if [[ ! -f 1812-army.ogg ]]; then
  echo "  fetching 1812 Overture (U.S. Army Band, ~10MB)..."
  curl -L -o 1812-army.ogg \
    'https://archive.org/download/1812Overture/1812_Overture.ogg' \
    || echo "  WARNING: 1812 Overture download failed; check the URL"
else
  echo "  1812-army.ogg already exists"
fi

# Cannon firing video (Public Domain).
# US Army Signal Corps footage from "America Goes Over (Part II)" (1918),
# showing a British BL 9.2-inch howitzer firing on the WWI Western Front.
# 17 seconds at 384×288; we trim to ~1 second of the firing moment in
# README.md. PD-US-Government, no attribution required.
if [[ ! -f cannon-shot-source.ogv ]]; then
  echo "  fetching cannon firing footage (Wikimedia Commons, PD, ~1MB)..."
  curl -L -o cannon-shot-source.ogv \
    'https://commons.wikimedia.org/wiki/Special:FilePath/9.2inchhowitzerfiringWWI.ogv' \
    || echo "  WARNING: cannon clip download failed; check the URL"
else
  echo "  cannon-shot-source.ogv already exists"
fi

echo ""
echo "Done. Next steps:"
echo "  1. Follow the trimming/clipping instructions in README.md."
echo "  2. Run ../../tools/afs-generate on each clip to produce .afs files."
echo "  3. Hand-annotate overture-finale-cannons.json by listening."
