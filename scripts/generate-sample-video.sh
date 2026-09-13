#!/bin/bash
# Generates the bundled sample MP4 benchmark video:
# 640x480 @ 30 FPS, 20 s — dark scene, moving bright beacon (Lissajous),
# two dim distractors, Gaussian sensor noise. Matches the PS-169 benchmark
# video description (moving beacon spot + noise, 30 FPS).
set -e
OUT="${1:-/home/z/my-project/public/samples/sample_benchmark_01.mp4}"
ffmpeg -y -f lavfi -i "color=c=0x101318:s=640x480:d=20:r=30" -vf "\
drawbox=x=95:y=90:w=12:h=12:color=0x2e2e2e@1:t=fill,\
drawbox=x=530:y=340:w=10:h=10:color=0x2a2a2a@1:t=fill,\
noise=alls=10:allf=t+u,\
drawbox=x='(iw-10)/2+270*sin(2*PI*t/11)':y='(ih-10)/2+160*sin(4*PI*t/11+1.2)':w=10:h=10:color=0xEDEDED@1:t=fill" \
-c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -movflags +faststart "$OUT"
echo "sample video written: $OUT"
