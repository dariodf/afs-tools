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
#   churchill-full.mp3          (~12MB, full speech)
#   tearsofsteel.en.srt         (Tears of Steel English subtitles)
#   cannon-shot-source.mp4      (placeholder; manual download required)
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
    'https://download.blender.org/durian/movies/tears_of_steel_720p.mov' \
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

# 1812 Overture - Skidmore College Orchestra (Public Domain via musopen.com)
if [[ ! -f 1812-overture-full.mp3 ]]; then
  echo "  fetching 1812 Overture (Skidmore College Orchestra, ~22MB)..."
  # The archive.org URL has a long encoded filename; using the direct
  # download endpoint with the identifier and known filename pattern.
  curl -L -o 1812-overture-full.mp3 \
    'https://archive.org/download/1812Overture_201603/1812%20Overture.mp3' \
    || echo "  WARNING: 1812 Overture download failed; check the URL"
else
  echo "  1812-overture-full.mp3 already exists"
fi

# Cannon firing video: no direct programmatic download. The NCpedia
# video at https://ncpedia.org/media/video/firing-18th-century is the
# recommended source (CC-BY-ND 4.0). Download manually or substitute
# any CC-licensed cannon clip from Wikimedia Commons.
if [[ ! -f cannon-shot-source.mp4 ]]; then
  echo "  NOTE: cannon-shot-source.mp4 must be downloaded manually."
  echo "    Recommended: https://ncpedia.org/media/video/firing-18th-century"
  echo "    Save as cannon-shot-source.mp4 in this directory."
fi

echo ""
echo "Done. Next steps:"
echo "  1. Follow the trimming/clipping instructions in README.md."
echo "  2. Run ../../tools/afs-generate on each clip to produce .afs files."
echo "  3. Hand-annotate overture-finale-cannons.json by listening."
