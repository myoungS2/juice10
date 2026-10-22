'use strict';
/*
 * 변위장(displacement field) 엔진.
 *  - 출력 픽셀 p 는 원본의 p + d(p) 를 샘플링한다. d 는 그리드 px 단위 Float32Array(RG).
 *  - 그리드는 긴 변 최대 2048 로 다운스케일.
 *  - 모든 도구는 "원본→출력 매핑 합성" 으로 구현: q = f(p) 일 때 d'(p) = d(q) + (q − p)
 *    (뒤틀기: q = p − wδ  →  d'(p) = d(p − wδ) − wδ)
 */

function unionRect(r, x0, y0, x1, y1) {
  if (!r) return { x0, y0, x1, y1 };
  if (x0 < r.x0) r.x0 = x0;
  if (y0 < r.y0) r.y0 = y0;
  if (x1 > r.x1) r.x1 = x1;
  if (y1 > r.y1) r.y1 = y1;
  return r;
}

class LiquifyField {
  constructor(imgW, imgH, maxGrid = 2048) {
    const s = Math.min(1, maxGrid / Math.max(imgW, imgH));
    this.imgW = imgW; this.imgH = imgH;
    this.gw = Math.max(2, Math.round(imgW * s));
    this.gh = Math.max(2, Math.round(imgH * s));
    this.sx = this.gw / imgW;   // 이미지 px → 그리드 px
    this.sy = this.gh / imgH;
    const n = this.gw * this.gh;
    this.d = new Float32Array(n * 2);
    this.mask = new Float32Array(n);     // 1 = 고정(frozen)  — 출력(화면) 공간
    this.skin = new Float32Array(n);     // 1 = 피부 보정 적용 — 원본 사진 공간 (변형을 따라 움직임)
    this.backupD = new Float32Array(n * 2);
    this.backupM = new Float32Array(n);
    this.backupS = new Float32Array(n);
    this.frameSkinDirty = null; this.strokeSkinDirty = null;
    this.scratch = new Float32Array(1024 * 2);
    this.frameDirty = null; this.frameMaskDirty = null;
    this.strokeDirty = null; this.strokeMaskDirty = null;
    this.history = []; this.redoStack = [];
    this.maxHistory = 30;
    this.maxHistoryBytes = 600 * 1024 * 1024;
    this.inStroke = false;
    this.last = null;
    this.stats = { stamps: 0, stampMs: 0 };
  }

  // ---------- 변경 영역 추적 ----------
  markDirty(x0, y0, x1, y1) {
    this.frameDirty = unionRect(this.frameDirty, x0, y0, x1, y1);
    this.strokeDirty = unionRect(this.strokeDirty, x0, y0, x1, y1);
  }
  markMaskDirty(x0, y0, x1, y1) {
    this.frameMaskDirty = unionRect(this.frameMaskDirty, x0, y0, x1, y1);
    this.strokeMaskDirty = unionRect(this.strokeMaskDirty, x0, y0, x1, y1);
  }
  markSkinDirty(x0, y0, x1, y1) {
    this.frameSkinDirty = unionRect(this.frameSkinDirty, x0, y0, x1, y1);
    this.strokeSkinDirty = unionRect(this.strokeSkinDirty, x0, y0, x1, y1);
  }
  takeDirty() { const r = this.frameDirty; this.frameDirty = null; return r; }
  takeMaskDirty() { const r = this.frameMaskDirty; this.frameMaskDirty = null; return r; }
  takeSkinDirty() { const r = this.frameSkinDirty; this.frameSkinDirty = null; return r; }

  // ---------- 획(stroke) / 실행취소 ----------
  beginStroke() {
    if (this.inStroke) return;
    this.inStroke = true;
    this.backupD.set(this.d);
    this.backupM.set(this.mask);
    this.backupS.set(this.skin);
    this.strokeDirty = null; this.strokeMaskDirty = null; this.strokeSkinDirty = null;
    this.last = null;
  }

  /** 획을 끝내고 실행 취소 항목을 만든다. 만든 항목(없으면 null)을 돌려준다. */
  endStroke() {
    if (!this.inStroke) return null;
    this.inStroke = false;
    const e = {};
    if (this.strokeDirty) { e.rect = this.strokeDirty; e.before = this._extract(this.backupD, e.rect, 2); }
    if (this.strokeMaskDirty) { e.mrect = this.strokeMaskDirty; e.mbefore = this._extract(this.backupM, e.mrect, 1); }
    if (this.strokeSkinDirty) { e.srect = this.strokeSkinDirty; e.sbefore = this._extract(this.backupS, e.srect, 1); }
    this.strokeDirty = null; this.strokeMaskDirty = null; this.strokeSkinDirty = null;
    if (!e.rect && !e.mrect && !e.srect) return null;
    this.history.push(e);
    this.redoStack.length = 0;
    this._trimHistory();
    return e;
  }

  _entryBytes(e) {
    let b = 0;
    for (const k of ['before', 'after', 'mbefore', 'mafter', 'sbefore', 'safter']) if (e[k]) b += e[k].byteLength;
    return b;
  }
  _trimHistory() {
    while (this.history.length > this.maxHistory) this.history.shift();
    let total = 0;
    for (const e of this.history) total += this._entryBytes(e);
    while (this.history.length > 1 && total > this.maxHistoryBytes) {
      total -= this._entryBytes(this.history.shift());
    }
  }

  _extract(buf, r, ch) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const out = new Float32Array(w * h * ch);
    const gw = this.gw;
    for (let y = 0; y < h; y++) {
      const s = ((r.y0 + y) * gw + r.x0) * ch;
      out.set(buf.subarray(s, s + w * ch), y * w * ch);
    }
    return out;
  }
  _inject(buf, r, ch, data) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const gw = this.gw;
    for (let y = 0; y < h; y++) {
      const s = ((r.y0 + y) * gw + r.x0) * ch;
      buf.set(data.subarray(y * w * ch, (y + 1) * w * ch), s);
    }
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.history.pop();
    if (!e) return false;
    if (e.rect) {
      e.after = this._extract(this.d, e.rect, 2);
      this._inject(this.d, e.rect, 2, e.before);
      this.markDirty(e.rect.x0, e.rect.y0, e.rect.x1, e.rect.y1);
    }
    if (e.mrect) {
      e.mafter = this._extract(this.mask, e.mrect, 1);
      this._inject(this.mask, e.mrect, 1, e.mbefore);
      this.markMaskDirty(e.mrect.x0, e.mrect.y0, e.mrect.x1, e.mrect.y1);
    }
    if (e.srect) {
      e.safter = this._extract(this.skin, e.srect, 1);
      this._inject(this.skin, e.srect, 1, e.sbefore);
      this.markSkinDirty(e.srect.x0, e.srect.y0, e.srect.x1, e.srect.y1);
    }
    this.redoStack.push(e);
    return e;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    if (e.rect) {
      this._inject(this.d, e.rect, 2, e.after);
      this.markDirty(e.rect.x0, e.rect.y0, e.rect.x1, e.rect.y1);
    }
    if (e.mrect) {
      this._inject(this.mask, e.mrect, 1, e.mafter);
      this.markMaskDirty(e.mrect.x0, e.mrect.y0, e.mrect.x1, e.mrect.y1);
    }
    if (e.srect) {
      this._inject(this.skin, e.srect, 1, e.safter);
      this.markSkinDirty(e.srect.x0, e.srect.y0, e.srect.x1, e.srect.y1);
    }
    this.history.push(e);
    return e;
  }

  /** 모두 복원: 변형을 0 으로 (마스크는 유지) */
  /**
   * 모두 복원: 변형과 피부 보정을 한 번에 원래대로 (고정 마스크는 보호용이라 유지).
   * 실행 취소 한 번으로 되살릴 수 있다. 반환한 항목에 앱이 색 보정 값을 덧붙인다.
   */
  restoreAll() {
    this.beginStroke();
    this.d.fill(0);
    this.skin.fill(0);
    this.markDirty(0, 0, this.gw, this.gh);
    this.markSkinDirty(0, 0, this.gw, this.gh);
    return this.endStroke();
  }

  /** 피부 보정 영역 모두 지우기 */
  clearSkin() {
    this.beginStroke();
    this.skin.fill(0);
    this.markSkinDirty(0, 0, this.gw, this.gh);
    return this.endStroke();
  }

  /** 마스크 모두 해제 */
  thawAll() {
    this.beginStroke();
    this.mask.fill(0);
    this.markMaskDirty(0, 0, this.gw, this.gh);
    return this.endStroke();
  }

  // ---------- 브러시 공통 ----------
  /** 브러시 가중치: t = dist/r, inner = 밀도(0..1). 밀도가 높을수록 가장자리가 단단하다. */
  static weight(t, inner) {
    if (t >= 1) return 0;
    if (t <= inner) return 1;
    const u = (t - inner) / (1 - inner);
    return 1 - u * u * (3 - 2 * u);
  }

  _bbox(cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.gw, Math.ceil(cx + r) + 1), y1 = Math.min(this.gh, Math.ceil(cy + r) + 1);
    return (x1 <= x0 || y1 <= y0) ? null : { x0, y0, x1, y1 };
  }

  /** d 의 일부(여백 포함)를 scratch 로 복사. 반환: {sx0, sy0, sw, sh} */
  _copyToScratch(b, margin) {
    const sx0 = Math.max(0, b.x0 - margin), sy0 = Math.max(0, b.y0 - margin);
    const sx1 = Math.min(this.gw, b.x1 + margin), sy1 = Math.min(this.gh, b.y1 + margin);
    const sw = sx1 - sx0, sh = sy1 - sy0;
    const need = sw * sh * 2;
    if (this.scratch.length < need) this.scratch = new Float32Array(Math.ceil(need * 1.3));
    const d = this.d, sc = this.scratch, gw = this.gw;
    for (let y = 0; y < sh; y++) {
      const s = ((sy0 + y) * gw + sx0) * 2;
      sc.set(d.subarray(s, s + sw * 2), y * sw * 2);
    }
    return { sx0, sy0, sw, sh };
  }

  // ---------- 경로 기반 도구 (뒤틀기 / 고정 / 해제 / 피부) ----------
  strokeStart(tool, x, y, o) {
    this.last = { x, y };
    this._stampPath(tool, x, y, 0, 0, o);
  }

  _stampPath(tool, x, y, stx, sty, o) {
    if (tool === 'warp') { if (stx || sty) this.warpStamp(x, y, stx, sty, o); }
    else if (tool === 'freeze' || tool === 'thaw') this.maskStamp(x, y, tool === 'freeze' ? 1 : -1, o);
    else if (tool === 'skin') this.skinStamp(x, y, o.erase ? -1 : 1, o);
  }

  /** 출력 좌표 p 에서 원본 좌표 p + d(p) (이중선형) */
  sourceOf(x, y) {
    const gw = this.gw, gh = this.gh, d = this.d;
    const fx = Math.min(gw - 1, Math.max(0, x)), fy = Math.min(gh - 1, Math.max(0, y));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const ix1 = Math.min(gw - 1, ix + 1), iy1 = Math.min(gh - 1, iy + 1);
    const a = (iy * gw + ix) * 2, b = (iy * gw + ix1) * 2, c = (iy1 * gw + ix) * 2, e = (iy1 * gw + ix1) * 2;
    const dx = (d[a] * (1 - tx) + d[b] * tx) * (1 - ty) + (d[c] * (1 - tx) + d[e] * tx) * ty;
    const dy = (d[a + 1] * (1 - tx) + d[b + 1] * tx) * (1 - ty) + (d[c + 1] * (1 - tx) + d[e + 1] * tx) * ty;
    return { x: x + dx, y: y + dy };
  }

  /**
   * 피부 보정 칠하기(+1)/지우기(−1).
   * 화면(출력) 좌표로 받은 브러시 중심을 원본 좌표로 옮겨서 칠한다 → 이후 변형을 따라 움직인다.
   */
  skinStamp(cx, cy, sign, o) {
    const s = this.sourceOf(cx, cy);
    const r = o.radius;
    const b = this._bbox(s.x, s.y, r);
    if (!b) return;
    const skin = this.skin, gw = this.gw;
    // 겹쳐 쌓지 않고 '가장 진한 값'을 유지 → 한 번 칠하면 고르게 덮이고, 겹친 곳이 얼룩지지 않는다
    // 압력 50 → 80% 덮임, 100 → 100%
    const inner = o.density, cov = 0.6 + 0.4 * o.pressure, invR = 1 / r;
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - s.y;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - s.x;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        const w = LiquifyField.weight(t, inner) * cov;
        if (sign > 0) { if (w > skin[i]) skin[i] = w; }
        else skin[i] *= 1 - w;
      }
    }
    this.markSkinDirty(b.x0, b.y0, b.x1, b.y1);
  }

  /**
   * 이동 경로를 브러시 크기(지름)의 6% 간격으로 쪼개 적용.
   * o = { radius, pressure, density, rate, dir }
   */
  strokeTo(tool, x, y, o) {
    if (!this.last) { this.strokeStart(tool, x, y, o); return; }
    const spacing = Math.max(0.5, o.radius * 2 * 0.06);
    let lx = this.last.x, ly = this.last.y;
    const dx = x - lx, dy = y - ly;
    const dist = Math.hypot(dx, dy);
    if (dist < spacing) return;
    const n = Math.floor(dist / spacing);
    const stx = dx / dist * spacing, sty = dy / dist * spacing;
    const t0 = performance.now();
    for (let i = 1; i <= n; i++) {
      this._stampPath(tool, lx + stx * i, ly + sty * i, stx, sty, o);
    }
    this.stats.stamps += n;
    this.stats.stampMs += performance.now() - t0;
    this.last = { x: lx + stx * n, y: ly + sty * n };
  }

  /** 뒤틀기 한 번: d'(p) = d(p − wδ) − wδ */
  warpStamp(cx, cy, ddx, ddy, o) {
    const r = o.radius;
    const b = this._bbox(cx, cy, r);
    if (!b) return;
    const margin = Math.ceil(Math.hypot(ddx, ddy)) + 2;
    const { sx0, sy0, sw, sh } = this._copyToScratch(b, margin);
    const sc = this.scratch, d = this.d, mask = this.mask, gw = this.gw;
    // 민감도: 압력에 곡선(1.5제곱)과 감쇠(0.6)를 적용해 한 번에 덜 밀리게 한다.
    // 압력 50 → 커서 이동량의 약 21%, 100 → 60%
    const inner = o.density, pr = Math.pow(o.pressure, 1.5) * LiquifyField.WARP_GAIN, invR = 1 / r;
    const maxX = sw - 1, maxY = sh - 1;
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - cy;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - cx;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        const w = LiquifyField.weight(t, inner) * pr * (1 - mask[i]);
        if (w <= 1e-4) continue;
        const wx = w * ddx, wy = w * ddy;
        // 이중선형 샘플 (scratch 좌표)
        let fx = x - wx - sx0, fy = y - wy - sy0;
        if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
        if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
        const ix = fx | 0, iy = fy | 0;
        const tx = fx - ix, ty = fy - iy;
        const ix1 = ix < maxX ? ix + 1 : ix, iy1 = iy < maxY ? iy + 1 : iy;
        const i00 = (iy * sw + ix) * 2, i10 = (iy * sw + ix1) * 2;
        const i01 = (iy1 * sw + ix) * 2, i11 = (iy1 * sw + ix1) * 2;
        const ox = (sc[i00] * (1 - tx) + sc[i10] * tx) * (1 - ty) + (sc[i01] * (1 - tx) + sc[i11] * tx) * ty;
        const oy = (sc[i00 + 1] * (1 - tx) + sc[i10 + 1] * tx) * (1 - ty) + (sc[i01 + 1] * (1 - tx) + sc[i11 + 1] * tx) * ty;
        d[i * 2] = ox - wx;
        d[i * 2 + 1] = oy - wy;
      }
    }
    this.markDirty(b.x0, b.y0, b.x1, b.y1);
  }

  /** 마스크 고정(+1)/해제(−1) */
  maskStamp(cx, cy, sign, o) {
    const r = o.radius;
    const b = this._bbox(cx, cy, r);
    if (!b) return;
    const mask = this.mask, gw = this.gw;
    const inner = o.density, k = o.pressure * 0.5 * sign, invR = 1 / r;
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - cy;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - cx;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        let m = mask[i] + LiquifyField.weight(t, inner) * k;
        mask[i] = m < 0 ? 0 : (m > 1 ? 1 : m);
      }
    }
    this.markMaskDirty(b.x0, b.y0, b.x1, b.y1);
  }

  // ---------- 연속 도구 (누르는 동안 매 프레임) ----------
  /**
   * tool: reconstruct | smooth | pucker | bloat | twirl
   * dt: 초 단위 프레임 간격 (60fps 기준으로 정규화)
   */
  applyAt(tool, cx, cy, o, dt) {
    const k = o.rate * o.pressure * Math.min(3, (dt || 1 / 60) * 60);
    if (k <= 0) return;
    const t0 = performance.now();
    switch (tool) {
      case 'reconstruct': this._reconstruct(cx, cy, o, k); break;
      case 'smooth': this._smooth(cx, cy, o, k); break;
      case 'pucker': this._scale(cx, cy, o, +0.012 * k); break;
      case 'bloat': this._scale(cx, cy, o, -0.012 * k); break;
      case 'twirl': this._twirl(cx, cy, o, 0.035 * k * (o.dir || 1)); break;
      default: return;
    }
    this.stats.stamps += 1;
    this.stats.stampMs += performance.now() - t0;
  }

  _reconstruct(cx, cy, o, k) {
    const r = o.radius;
    const b = this._bbox(cx, cy, r);
    if (!b) return;
    const d = this.d, mask = this.mask, gw = this.gw;
    const inner = o.density, invR = 1 / r, kk = 0.08 * k;
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - cy;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - cx;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        let f = LiquifyField.weight(t, inner) * (1 - mask[i]) * kk;
        if (f <= 0) continue;
        if (f > 1) f = 1;
        d[i * 2] *= 1 - f;
        d[i * 2 + 1] *= 1 - f;
      }
    }
    this.markDirty(b.x0, b.y0, b.x1, b.y1);
  }

  _smooth(cx, cy, o, k) {
    const r = o.radius;
    const b = this._bbox(cx, cy, r);
    if (!b) return;
    const { sx0, sy0, sw, sh } = this._copyToScratch(b, 1);
    const sc = this.scratch, d = this.d, mask = this.mask, gw = this.gw;
    const inner = o.density, invR = 1 / r, kk = 0.35 * k;
    const sw2 = sw * 2;
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - cy;
      const ly = y - sy0;
      const rowC = ly * sw2;
      const rowM = (ly > 0 ? ly - 1 : ly) * sw2, rowP = (ly < sh - 1 ? ly + 1 : ly) * sw2;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - cx;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        let f = LiquifyField.weight(t, inner) * (1 - mask[i]) * kk;
        if (f <= 0) continue;
        if (f > 1) f = 1;
        const lx = x - sx0;
        const cm = (lx > 0 ? lx - 1 : lx) * 2, cc = lx * 2, cp = (lx < sw - 1 ? lx + 1 : lx) * 2;
        const ax = (sc[rowM + cm] + sc[rowM + cc] + sc[rowM + cp]
                  + sc[rowC + cm] + sc[rowC + cc] + sc[rowC + cp]
                  + sc[rowP + cm] + sc[rowP + cc] + sc[rowP + cp]) / 9;
        const ay = (sc[rowM + cm + 1] + sc[rowM + cc + 1] + sc[rowM + cp + 1]
                  + sc[rowC + cm + 1] + sc[rowC + cc + 1] + sc[rowC + cp + 1]
                  + sc[rowP + cm + 1] + sc[rowP + cc + 1] + sc[rowP + cp + 1]) / 9;
        const ci = rowC + cc;
        d[i * 2] = sc[ci] + (ax - sc[ci]) * f;
        d[i * 2 + 1] = sc[ci + 1] + (ay - sc[ci + 1]) * f;
      }
    }
    this.markDirty(b.x0, b.y0, b.x1, b.y1);
  }

  /** 중심 기준 스케일 샘플링. a>0 오목(안으로 모임), a<0 볼록(바깥으로 퍼짐) */
  _scale(cx, cy, o, a) {
    this._remap(cx, cy, o, Math.ceil(o.radius * Math.abs(a)) + 2, 0, a);
  }

  /** 돌리기: 콘텐츠를 시계 방향(theta>0)으로 회전 → 샘플 좌표는 반대 방향으로 회전 */
  _twirl(cx, cy, o, theta) {
    this._remap(cx, cy, o, Math.ceil(o.radius * Math.abs(theta)) + 2, 1, theta);
  }

  /**
   * 공통 재매핑: q = c + map(p − c, w) 일 때 d'(p) = d(q) + (q − p)
   * mode 0: 스케일 q−c = (p−c)(1 + w·a)
   * mode 1: 회전   q−c = R(−w·a)(p−c)   (cos/sin 은 w 에 대한 LUT 사용)
   */
  _remap(cx, cy, o, margin, mode, a) {
    const r = o.radius;
    const b = this._bbox(cx, cy, r);
    if (!b) return;
    const { sx0, sy0, sw, sh } = this._copyToScratch(b, margin);
    const sc = this.scratch, d = this.d, mask = this.mask, gw = this.gw;
    const inner = o.density, invR = 1 / r;
    const maxX = sw - 1, maxY = sh - 1;
    let lutC = null, lutS = null;
    const LUT_N = 512;
    if (mode === 1) {
      lutC = this._lutC || (this._lutC = new Float32Array(LUT_N + 1));
      lutS = this._lutS || (this._lutS = new Float32Array(LUT_N + 1));
      for (let i = 0; i <= LUT_N; i++) { const th = -a * i / LUT_N; lutC[i] = Math.cos(th); lutS[i] = Math.sin(th); }
    }
    for (let y = b.y0; y < b.y1; y++) {
      const py = y - cy;
      for (let x = b.x0; x < b.x1; x++) {
        const px = x - cx;
        const t = Math.sqrt(px * px + py * py) * invR;
        if (t >= 1) continue;
        const i = y * gw + x;
        const w = LiquifyField.weight(t, inner) * (1 - mask[i]);
        if (w <= 1e-4) continue;
        let qx, qy;
        if (mode === 0) {
          const s = 1 + w * a;
          qx = cx + px * s; qy = cy + py * s;
        } else {
          const li = (w * LUT_N + 0.5) | 0;
          const c = lutC[li], s = lutS[li];
          qx = cx + px * c - py * s; qy = cy + px * s + py * c;
        }
        let fx = qx - sx0, fy = qy - sy0;
        if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
        if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
        const ix = fx | 0, iy = fy | 0;
        const tx = fx - ix, ty = fy - iy;
        const ix1 = ix < maxX ? ix + 1 : ix, iy1 = iy < maxY ? iy + 1 : iy;
        const i00 = (iy * sw + ix) * 2, i10 = (iy * sw + ix1) * 2;
        const i01 = (iy1 * sw + ix) * 2, i11 = (iy1 * sw + ix1) * 2;
        const ox = (sc[i00] * (1 - tx) + sc[i10] * tx) * (1 - ty) + (sc[i01] * (1 - tx) + sc[i11] * tx) * ty;
        const oy = (sc[i00 + 1] * (1 - tx) + sc[i10 + 1] * tx) * (1 - ty) + (sc[i01 + 1] * (1 - tx) + sc[i11 + 1] * tx) * ty;
        d[i * 2] = ox + (qx - x);
        d[i * 2 + 1] = oy + (qy - y);
      }
    }
    this.markDirty(b.x0, b.y0, b.x1, b.y1);
  }
}

LiquifyField.WARP_GAIN = 0.6;

window.LiquifyField = LiquifyField;
