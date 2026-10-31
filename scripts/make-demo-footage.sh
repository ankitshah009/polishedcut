#!/usr/bin/env bash
# Generates demo clips with real spoken narration (macOS `say`) + distinct visuals.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/footage/demo"
mkdir -p "$OUT"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FONT=/System/Library/Fonts/Supplemental/Arial.ttf

make() { # name voice text visual title
  local name=$1 voice=$2 text=$3 vis=$4 title=$5
  say -v "$voice" -o "$TMP/$name.aiff" "$text"
  local d; d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/$name.aiff")
  d=$(echo "$d + 1.5" | bc)
  ffmpeg -y -v error -f lavfi -i "$vis" -i "$TMP/$name.aiff" -t "$d" \
    -vf "drawtext=fontfile=$FONT:text='$title':fontsize=72:fontcolor=white:borderw=4:x=(w-tw)/2:y=h*0.4" \
    -af "apad" -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 48000 "$OUT/$name.mp4"
}

make 01_intro Samantha "Good morning everyone, and welcome to our launch event. Today, we are going to show you something we have been working on for two years. Um, it is honestly the thing we are most proud of." "gradients=s=1280x720:r=30:speed=0.02" "Welcome"
make 02_reveal Daniel "Introducing Lumen, the first camera that edits your videos for you. Just shoot, and Lumen finds the best moments, adds captions, and cuts the boring parts automatically." "mandelbrot=s=1280x720:r=30" "Introducing Lumen"
make 03_applause Samantha "Lumen ships next month, starting at just two hundred ninety nine dollars. Thank you all so much for being here. Go make something amazing!" "life=s=640x360:r=30:mold=10:ratio=0.3:death_color=#102040:life_color=#ffcc33,scale=1280:720" "Available Next Month"
