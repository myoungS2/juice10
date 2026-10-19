#!/usr/bin/env python3
"""마스코트 PNG 의 배경(가장자리와 이어진 피치색)을 투명하게 만들고 여백을 잘라 저장한다."""
import sys
from collections import deque
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
m = Image.open(src).convert('RGBA')
w, h = m.size
px = m.load()
bg = px[2, 2]

def dist(c):
    return abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2])

seen = bytearray(w * h)
q = deque([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] +
          [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])
edge = []
while q:
    x, y = q.popleft()
    if x < 0 or y < 0 or x >= w or y >= h:
        continue
    i = y * w + x
    if seen[i]:
        continue
    seen[i] = 1
    c = px[x, y]
    dd = dist(c)
    if dd >= 60:
        continue
    if dd < 25:
        px[x, y] = (c[0], c[1], c[2], 0)
    else:
        # 경계 부분은 부드럽게 반투명
        px[x, y] = (c[0], c[1], c[2], int(255 * (dd - 25) / 35))
    q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

m = m.crop(m.getbbox())
m.save(out)
print('ok', m.size)
