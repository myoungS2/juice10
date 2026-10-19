#!/usr/bin/env python3
"""마스코트 PNG → macOS 앱 아이콘(1024 PNG + .icns)

배경(피치색)을 투명하게 떼어낸 뒤, 오렌지(#FF9F1C) 둥근 사각형 위에 올린다.
macOS 아이콘 규격: 1024 캔버스, 둥근 사각형 824×824 중앙 배치.
"""
import subprocess, sys, tempfile, os
from PIL import Image, ImageDraw, ImageFilter

src = sys.argv[1]
out_png = sys.argv[2]
out_icns = sys.argv[3]

m = Image.open(src).convert('RGBA')
# 가장자리에서 배경색 플러드필 → 투명
bg = m.getpixel((2, 2))
w, h = m.size
px = m.load()
from collections import deque
seen = bytearray(w * h)
q = deque()
for x in range(w):
    q.append((x, 0)); q.append((x, h - 1))
for y in range(h):
    q.append((0, y)); q.append((w - 1, y))

def near(c):
    return abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) < 60

while q:
    x, y = q.popleft()
    if x < 0 or y < 0 or x >= w or y >= h: continue
    i = y * w + x
    if seen[i]: continue
    seen[i] = 1
    c = px[x, y]
    if not near(c): continue
    px[x, y] = (c[0], c[1], c[2], 0)
    q.append((x + 1, y)); q.append((x - 1, y)); q.append((x, y + 1)); q.append((x, y - 1))

# 여백 잘라내기
bbox = m.getbbox()
m = m.crop(bbox)

S = 1024
R = 824          # 둥근 사각형 변
RAD = 186        # 모서리 반지름
canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
plate = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(plate)
o = (S - R) // 2
d.rounded_rectangle([o, o, o + R, o + R], radius=RAD, fill=(0xFF, 0x9F, 0x1C, 255))
# 살짝 그라디언트 느낌: 아래쪽을 조금 진하게
grad = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for i in range(R):
    a = int(40 * (i / R))
    gd.line([(o, o + i), (o + R, o + i)], fill=(0xF0, 0x44, 0x32, a))
mask = plate.split()[3]
plate = Image.alpha_composite(plate, Image.composite(grad, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))
canvas = Image.alpha_composite(canvas, plate)

# 마스코트 배치 (플레이트의 ~86% 높이)
target_h = int(R * 0.86)
scale = target_h / m.height
m2 = m.resize((int(m.width * scale), target_h), Image.LANCZOS)
mx = (S - m2.width) // 2
my = (S - m2.height) // 2 + 6
canvas.alpha_composite(m2, (mx, my))
canvas.save(out_png)

# .icns
with tempfile.TemporaryDirectory() as tmp:
    iconset = os.path.join(tmp, 'icon.iconset')
    os.mkdir(iconset)
    for size in (16, 32, 128, 256, 512):
        canvas.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
        canvas.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
    subprocess.check_call(['iconutil', '-c', 'icns', iconset, '-o', out_icns])
print('ok', out_png, out_icns)
