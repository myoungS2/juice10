'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const stage = $('#stage');
  const glCanvas = $('#gl');
  const overlay = $('#overlay');
  const emptyEl = $('#empty');
  const octx = overlay.getContext('2d');

  let renderer = null;
  try {
    renderer = new Renderer(glCanvas);
  } catch (err) {
    emptyEl.querySelector('.empty-title').textContent = 'WebGL2 를 초기화할 수 없습니다';
    emptyEl.querySelector('.empty-sub').textContent = err.message;
  }

  // ---------- 도구 정의 ----------
  const ICONS = {
    warp: '<path d="M4 16c3-6 6-6 8-3s5 3 8-3"/><path d="M14 4l3 3-3 3"/>',
    reconstruct: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    smooth: '<path d="M3 15c3-5 6-5 9 0s6 5 9 0"/><path d="M3 9c3-5 6-5 9 0s6 5 9 0" opacity=".5"/>',
    pucker: '<path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5"/><circle cx="12" cy="12" r="2"/>',
    bloat: '<path d="M9 9L4 4M15 9l5-5M9 15l-5 5M15 15l5 5"/><circle cx="12" cy="12" r="3"/>',
    twirl: '<path d="M12 12c0-2 2-3 4-2s2 4 0 6-7 2-9-1-1-9 3-11 10-1 12 4"/>',
    skin: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    freeze: '<path d="M12 3v18M5 7l14 10M5 17L19 7"/><path d="M9 4l3 2 3-2M9 20l3-2 3 2"/>',
    thaw: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
    hand: '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8"/><path d="M8 12l-2.2-2.2a1.6 1.6 0 0 0-2.3 2.3L8 17c1.5 2.5 3.5 4 6.5 4 3.3 0 5.5-2.2 5.5-5.5V14"/>',
  };
  const TOOLS = [
    { id: 'warp', key: 'W', label: '뒤틀기', hint: '드래그해 픽셀을 밀어냅니다' },
    { id: 'reconstruct', key: 'R', label: '재구성', hint: '누르고 있으면 변형이 서서히 원래대로 돌아옵니다' },
    { id: 'smooth', key: 'E', label: '매끄럽게', hint: '변형을 부드럽게 다듬습니다' },
    { id: 'pucker', key: 'S', label: '오목', hint: '중심 쪽으로 모읍니다' },
    { id: 'bloat', key: 'B', label: '볼록', hint: '바깥쪽으로 부풀립니다' },
    { id: 'twirl', key: 'C', label: '돌리기', hint: '시계 방향 회전 · ⌥ 누르면 반시계' },
    null,
    { id: 'skin', key: 'K', label: '피부 보정', hint: '피부를 칠하면 매끄러워집니다 · ⌥ 누르면 지우기' },
    null,
    { id: 'freeze', key: 'F', label: '마스크 고정', hint: '칠한 영역은 변형되지 않습니다' },
    { id: 'thaw', key: 'D', label: '마스크 해제', hint: '고정을 지웁니다' },
    null,
    { id: 'hand', key: 'H', label: '손', hint: '드래그해 화면을 이동합니다 (스페이스+드래그)' },
  ];
  const PATH_TOOLS = new Set(['warp', 'freeze', 'thaw', 'skin']);
  const CONT_TOOLS = new Set(['reconstruct', 'smooth', 'pucker', 'bloat', 'twirl']);

  // ---------- 상태 ----------
  const state = {
    field: null, imgW: 0, imgH: 0, fileName: '', filePath: '',
    view: { x: 0, y: 0, scale: 1 },
    tool: 'warp',
    brush: { size: 300, pressure: 50, density: 50, rate: 50 },
    usePen: true,
    color: { exposure: 0, contrast: 0, saturation: 0, temperature: 0 },
    skin: { amount: 80, grain: 30 },
    showSkinArea: false,
    showOriginal: false, showMask: true,
    space: false, alt: false,
    pointer: { sx: 0, sy: 0, inside: false, pressure: 1, down: false, mode: null, lastT: 0, pan: null, gx: 0, gy: 0 },
    needsRender: false, rafId: 0, dpr: window.devicePixelRatio || 1,
    dragDepth: 0,
  };

  // ---------- 도구 막대 ----------
  const toolbar = $('#toolbar');
  for (const t of TOOLS) {
    if (!t) { const s = document.createElement('div'); s.className = 'tool-sep'; toolbar.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = t.id; b.title = `${t.label} (${t.key})`;
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[t.id]}</svg><span class="key">${t.key}</span>`;
    b.addEventListener('click', () => setTool(t.id));
    toolbar.appendChild(b);
  }

  function setTool(id) {
    state.tool = id;
    for (const b of toolbar.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === id);
    const t = TOOLS.find((x) => x && x.id === id);
    $('#status-tool').textContent = t ? `${t.label} — ${t.hint}` : '';
    updateCursorClass();
    drawOverlay();
  }

  function isHandMode() { return state.tool === 'hand' || state.space; }
  function updateCursorClass() {
    const hand = isHandMode();
    stage.classList.toggle('hand', hand);
    stage.classList.toggle('brush', !hand && !!state.field);
  }

  // ---------- 패널 바인딩 ----------
  function bindRow(row, obj, key, onChange) {
    const range = row.querySelector('input[type=range]');
    const num = row.querySelector('input[type=number]');
    const sync = () => { range.value = obj[key]; num.value = obj[key]; };
    const set = (v) => {
      v = Number(v);
      if (!Number.isFinite(v)) return;
      const lo = Number(num.min), hi = Number(num.max);
      obj[key] = Math.min(hi, Math.max(lo, v));
      sync();
      onChange && onChange();
    };
    range.addEventListener('input', () => set(range.value));
    num.addEventListener('change', () => set(num.value));
    sync();
    return { sync, set };
  }
  const brushCtl = {};
  for (const row of document.querySelectorAll('.row[data-opt]')) {
    const k = row.dataset.opt;
    brushCtl[k] = bindRow(row, state.brush, k, () => drawOverlay());
  }
  for (const row of document.querySelectorAll('.row[data-color]')) {
    bindRow(row, state.color, row.dataset.color, () => requestRender());
  }
  /** 색 보정 값을 설정하고 슬라이더도 맞춘다 */
  function applyColor(c) {
    // 슬라이더가 state.color 객체를 직접 참조하므로 객체를 바꿔 끼우지 않고 값만 바꾼다
    Object.assign(state.color, c);
    for (const row of document.querySelectorAll('.row[data-color]')) {
      const v = state.color[row.dataset.color];
      row.querySelector('input[type=range]').value = v;
      row.querySelector('input[type=number]').value = v;
    }
    requestRender();
  }
  $('#btn-color-reset').addEventListener('click', () => applyColor({ exposure: 0, contrast: 0, saturation: 0, temperature: 0 }));
  $('#chk-pen').addEventListener('change', (e) => { state.usePen = e.target.checked; });
  $('#chk-mask').addEventListener('change', (e) => { state.showMask = e.target.checked; requestRender(); });
  for (const row of document.querySelectorAll('.row[data-skin]')) {
    bindRow(row, state.skin, row.dataset.skin, () => requestRender());
  }
  $('#chk-skin-area').addEventListener('change', (e) => { state.showSkinArea = e.target.checked; requestRender(); });

  function setBrushSize(v) { brushCtl.size.set(Math.round(v)); }

  function skinUniforms() {
    return { amount: state.skin.amount / 100, grain: state.skin.grain / 100 };
  }
  function colorUniforms() {
    const c = state.color;
    return {
      exposure: c.exposure,
      contrast: c.contrast >= 0 ? 1 + c.contrast / 100 : 1 + c.contrast / 100 * 0.9,
      saturation: 1 + c.saturation / 100,
      temperature: c.temperature / 100,
    };
  }

  // ---------- 캔버스 크기 / 뷰 ----------
  function resize() {
    const r = stage.getBoundingClientRect();
    state.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * state.dpr)), h = Math.max(1, Math.round(r.height * state.dpr));
    for (const c of [glCanvas, overlay]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    requestRender();
    drawOverlay();
  }
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  // Retina ↔ 외장 모니터 이동 시 dpr 변경 감지
  (function watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  })();

  function stageSize() { const r = stage.getBoundingClientRect(); return { w: r.width, h: r.height }; }

  function fitView() {
    if (!state.field) return;
    const { w, h } = stageSize();
    const pad = 24;
    const s = Math.min((w - pad * 2) / state.imgW, (h - pad * 2) / state.imgH);
    state.view.scale = Math.max(0.01, s);
    state.view.x = (w - state.imgW * s) / 2;
    state.view.y = (h - state.imgH * s) / 2;
    requestRender(); updateStatus();
  }

  function zoomAt(sx, sy, factor) {
    if (!state.field) return;
    const v = state.view;
    const ns = Math.min(64, Math.max(0.02, v.scale * factor));
    const k = ns / v.scale;
    v.x = sx - (sx - v.x) * k;
    v.y = sy - (sy - v.y) * k;
    v.scale = ns;
    requestRender(); drawOverlay(); updateStatus();
  }
  function zoomCenter(factor) { const { w, h } = stageSize(); zoomAt(w / 2, h / 2, factor); }
  function zoomTo100() {
    if (!state.field) return;
    const { w, h } = stageSize();
    const v = state.view;
    const cx = (w / 2 - v.x) / v.scale, cy = (h / 2 - v.y) / v.scale;  // 중앙에 보이는 이미지 좌표 유지
    v.scale = 1 / state.dpr;  // 이미지 1px = 화면 1px (백킹 버퍼 기준)
    v.x = w / 2 - cx * v.scale; v.y = h / 2 - cy * v.scale;
    requestRender(); drawOverlay(); updateStatus();
  }

  function updateStatus() {
    $('#status-zoom').textContent = state.field ? `${Math.round(state.view.scale * state.dpr * 100)}%` : '';
  }
  function setStatusMsg(msg) { $('#status-msg').textContent = msg || ''; }

  // ---------- 렌더 루프 ----------
  function render() {
    state.needsRender = false;
    if (!renderer) return;
    if (!state.field) { renderer.clear(); return; }
    const v = state.view, dpr = state.dpr;
    renderer.draw({
      offsetX: v.x * dpr, offsetY: v.y * dpr, scale: v.scale * dpr,
      showOriginal: state.showOriginal, showMask: state.showMask, color: colorUniforms(),
      skin: skinUniforms(),
      // '칠한 영역 표시'를 켰을 때만 영역을 보여 준다 (칠하는 동안에는 실제 결과를 그대로 보여 줌)
      showSkin: !state.showOriginal && state.showSkinArea,
    });
  }
  function tick(t) {
    state.rafId = 0;
    const p = state.pointer;
    if (p.down && p.mode === 'cont' && state.field) {
      const dt = p.lastT ? Math.min(0.05, (t - p.lastT) / 1000) : 1 / 60;
      p.lastT = t;
      state.field.applyAt(state.tool, p.gx, p.gy, strokeOpts(), dt);
      state.needsRender = true;
    }
    if (state.needsRender) render();
    if (p.down && p.mode === 'cont') schedule();
  }
  function schedule() { if (!state.rafId) state.rafId = requestAnimationFrame(tick); }
  function requestRender() { state.needsRender = true; schedule(); }

  // ---------- 브러시 커서 오버레이 ----------
  function drawOverlay() {
    const dpr = state.dpr;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);
    const p = state.pointer;
    if (!state.field || !p.inside || isHandMode()) return;
    const r = state.brush.size / 2 * state.view.scale;
    // 어두운 바깥선 + 밝은 안쪽선: 밝은/어두운 사진 모두에서 잘 보이도록
    octx.lineWidth = 3;
    octx.beginPath(); octx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
    octx.strokeStyle = 'rgba(40,24,12,0.55)'; octx.stroke();
    octx.lineWidth = 1.25;
    octx.beginPath(); octx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
    octx.strokeStyle = (state.tool === 'freeze' || state.tool === 'thaw') ? 'rgba(255,90,90,0.95)'
      : state.tool === 'skin' ? (state.alt ? 'rgba(160,160,160,0.95)' : 'rgba(255,191,105,0.98)') : 'rgba(255,255,255,0.95)';
    octx.stroke();
    octx.lineWidth = 1;
    // 중심 십자
    octx.beginPath();
    octx.moveTo(p.sx - 4, p.sy); octx.lineTo(p.sx + 4, p.sy);
    octx.moveTo(p.sx, p.sy - 4); octx.lineTo(p.sx, p.sy + 4);
    octx.strokeStyle = 'rgba(255,255,255,0.8)'; octx.stroke();
    if (state.tool === 'twirl') {
      // 회전 방향 표시
      octx.beginPath();
      const dir = state.alt ? -1 : 1;
      octx.arc(p.sx, p.sy, Math.max(8, r * 0.5), -Math.PI / 2, -Math.PI / 2 + dir * Math.PI * 0.6, dir < 0);
      octx.strokeStyle = 'rgba(255,191,105,0.9)'; octx.stroke();
    }
  }

  // ---------- 포인터 입력 ----------
  function toStage(e) {
    const r = overlay.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }
  function toGrid(sx, sy) {
    const f = state.field, v = state.view;
    const ix = (sx - v.x) / v.scale, iy = (sy - v.y) / v.scale;
    return { gx: ix * f.sx - 0.5, gy: iy * f.sy - 0.5 };
  }
  function pressureOf(e) {
    if (state.usePen && e.pointerType === 'pen') return Math.max(0.03, e.pressure || 0.5);
    return 1;
  }
  function strokeOpts() {
    const f = state.field;
    return {
      radius: Math.max(0.5, state.brush.size / 2 * f.sx),
      pressure: state.brush.pressure / 100 * state.pointer.pressure,
      density: Math.min(0.98, state.brush.density / 100),
      rate: state.brush.rate / 100,
      dir: state.alt ? -1 : 1,
      erase: state.alt,
    };
  }

  overlay.addEventListener('pointerenter', (e) => { state.pointer.inside = true; const s = toStage(e); state.pointer.sx = s.sx; state.pointer.sy = s.sy; drawOverlay(); });
  overlay.addEventListener('pointerleave', () => { if (!state.pointer.down) { state.pointer.inside = false; drawOverlay(); } });

  overlay.addEventListener('pointerdown', (e) => {
    const p = state.pointer;
    const s = toStage(e);
    p.sx = s.sx; p.sy = s.sy; p.inside = true;
    state.alt = e.altKey;
    if (!state.field) return;
    overlay.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && isHandMode())) {
      p.down = true; p.mode = 'pan';
      p.pan = { sx: s.sx, sy: s.sy, vx: state.view.x, vy: state.view.y };
      stage.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    p.down = true;
    p.pressure = pressureOf(e);
    const g = toGrid(s.sx, s.sy);
    p.gx = g.gx; p.gy = g.gy; p.lastT = 0;
    state.field.beginStroke();
    if (PATH_TOOLS.has(state.tool)) {
      p.mode = 'path';
      state.field.strokeStart(state.tool, g.gx, g.gy, strokeOpts());
      requestRender();
    } else if (CONT_TOOLS.has(state.tool)) {
      p.mode = 'cont';
      schedule();
    }
    drawOverlay();
  });

  overlay.addEventListener('pointermove', (e) => {
    const p = state.pointer;
    const s = toStage(e);
    p.sx = s.sx; p.sy = s.sy; p.inside = true;
    if (e.altKey !== state.alt) state.alt = e.altKey;
    if (p.down && p.mode === 'pan') {
      state.view.x = p.pan.vx + (s.sx - p.pan.sx);
      state.view.y = p.pan.vy + (s.sy - p.pan.sy);
      requestRender();
    } else if (p.down && p.mode === 'path' && state.field) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of (events.length ? events : [e])) {
        const cs = toStage(ce);
        p.pressure = pressureOf(ce);
        const g = toGrid(cs.sx, cs.sy);
        state.field.strokeTo(state.tool, g.gx, g.gy, strokeOpts());
      }
      requestRender();
    } else if (p.down && p.mode === 'cont' && state.field) {
      p.pressure = pressureOf(e);
      const g = toGrid(s.sx, s.sy);
      p.gx = g.gx; p.gy = g.gy;
    }
    drawOverlay();
  });

  function endPointer(e) {
    const p = state.pointer;
    if (!p.down) return;
    if (e && overlay.hasPointerCapture && overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
    if (p.mode === 'pan') stage.classList.remove('panning');
    else if (state.field) { state.field.endStroke(); updateHistoryUI(); }
    p.down = false; p.mode = null; p.pan = null;
    requestRender(); drawOverlay();
  }
  overlay.addEventListener('pointerup', endPointer);
  overlay.addEventListener('pointercancel', endPointer);
  window.addEventListener('blur', () => { endPointer(null); state.space = false; state.showOriginal = false; updateCursorClass(); requestRender(); });
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  // 트랙패드: 핀치(ctrlKey) = 확대/축소, 두 손가락 스크롤 = 이동
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.field) return;
    const s = toStage(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(s.sx, s.sy, Math.exp(-e.deltaY * 0.01));
    } else {
      state.view.x -= e.deltaX;
      state.view.y -= e.deltaY;
      state.pointer.sx = s.sx; state.pointer.sy = s.sy;
      requestRender(); drawOverlay();
    }
  }, { passive: false });

  // ---------- 키보드 ----------
  // 키 판별은 e.code(물리 키 위치)로 한다 → 한글 입력 상태(ㅈ/ㄱ/ㄷ…)에서도 단축키가 동작
  const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'number'));

  // 슬라이더·체크박스·버튼을 클릭한 뒤 포커스가 남아 단축키를 가로채지 않도록 포커스를 해제
  document.addEventListener('pointerup', (e) => {
    const el = e.target && e.target.closest && e.target.closest('button, input[type=range], input[type=checkbox], label');
    if (el) requestAnimationFrame(() => { const a = document.activeElement; if (a && !isTextField(a)) a.blur(); });
  }, true);
  overlay.addEventListener('pointerdown', () => { const a = document.activeElement; if (a && a !== document.body) a.blur(); }, true);

  /** 단축키 keydown 공통 처리. 처리했으면 true. (페이지 keydown 과 메인 프로세스 전달 모두 여기로) */
  function shortcutDown(code, shift, alt, repeat) {
    if (helpOpen()) {
      if (code === 'Escape' || code === 'Slash') { toggleHelp(false); return true; }
      return false;
    }
    switch (code) {
      case 'Space':
        if (!state.space) { state.space = true; updateCursorClass(); drawOverlay(); }
        return true;
      case 'Backslash':
        if (!state.showOriginal) { state.showOriginal = true; requestRender(); }
        return true;
      case 'BracketLeft': setBrushSize(Math.max(1, state.brush.size / 1.1 - 1)); return true;
      case 'BracketRight': setBrushSize(state.brush.size * 1.1 + 1); return true;
      case 'AltLeft': case 'AltRight': state.alt = true; drawOverlay(); return true;
      case 'Slash': if (shift) { toggleHelp(true); return true; } return false;
      case 'Escape': return false;
    }
    if (!code.startsWith('Key')) return false;
    if (repeat || alt) return true;
    const letter = code.slice(3);   // 'KeyW' → 'W'
    const t = TOOLS.find((x) => x && x.key === letter);
    if (t) { setTool(t.id); return true; }
    return false;
  }
  function shortcutUp(code) {
    if (code === 'Space') { state.space = false; if (state.pointer.mode === 'pan' && state.tool !== 'hand') endPointer(null); updateCursorClass(); drawOverlay(); }
    else if (code === 'Backslash') { state.showOriginal = false; requestRender(); }
    else if (code === 'AltLeft' || code === 'AltRight') { state.alt = false; drawOverlay(); }
  }

  // 메인 프로세스(before-input-event)가 입력기보다 먼저 가로채 보내 주는 단축키
  if (window.api && window.api.onShortcut) {
    window.api.onShortcut((k) => {
      if (k.type === 'down') shortcutDown(k.code, k.shift, k.alt, k.repeat);
      else shortcutUp(k.code);
    });
  }
  // 숫자 입력칸에 포커스가 있는 동안은 메인 프로세스가 키를 가로채지 않게 알려 준다
  const syncTextFocus = () => window.api && window.api.setTextFocus && window.api.setTextFocus(isTextField(document.activeElement));
  document.addEventListener('focusin', syncTextFocus);
  document.addEventListener('focusout', () => setTimeout(syncTextFocus, 0));

  // 페이지 keydown: 메인 프로세스가 가로채지 않은 키(⌥, ⌘ 조합 등)와 브라우저 단독 실행용
  document.addEventListener('keydown', (e) => {
    if (isTextField(e.target)) {
      if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
      return;
    }
    // ⌘ 조합은 메인 프로세스(before-input-event)가 처리한다. 여기서 preventDefault 하면 메뉴 단축키가 막히므로 건드리지 않는다.
    if (e.metaKey || e.ctrlKey) return;
    if (shortcutDown(e.code, e.shiftKey, e.altKey, e.repeat)) e.preventDefault();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') e.preventDefault();
    shortcutUp(e.code);
  });

  // ---------- 단축키 안내 ----------
  const helpEl = $('#help');
  const helpOpen = () => !helpEl.hidden;
  function toggleHelp(show) {
    helpEl.hidden = !(show ?? helpEl.hidden);
  }
  helpEl.addEventListener('pointerdown', (e) => { if (e.target === helpEl) toggleHelp(false); });
  $('#btn-help').addEventListener('click', () => toggleHelp(true));
  $('#btn-help-close').addEventListener('click', () => toggleHelp(false));

  // ---------- 상단 버튼 ----------
  $('#btn-open').addEventListener('click', openViaDialog);
  $('#btn-open-empty').addEventListener('click', openViaDialog);
  $('#btn-save').addEventListener('click', save);
  $('#btn-restore').addEventListener('click', restoreAll);
  $('#btn-thaw-all').addEventListener('click', thawAll);
  $('#btn-skin-clear').addEventListener('click', clearSkin);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  const cmp = $('#btn-compare');
  const cmpOn = () => { if (!state.showOriginal) { state.showOriginal = true; requestRender(); } };
  const cmpOff = () => { if (state.showOriginal) { state.showOriginal = false; requestRender(); } };
  cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); cmpOn(); });
  cmp.addEventListener('pointerup', cmpOff);
  cmp.addEventListener('pointerleave', cmpOff);
  window.addEventListener('pointerup', cmpOff);

  function updateHistoryUI() {
    const f = state.field;
    $('#btn-undo').disabled = !(f && f.canUndo);
    $('#btn-redo').disabled = !(f && f.canRedo);
    $('#history-info').textContent = f ? `실행 취소 ${f.history.length}단계 · 다시 실행 ${f.redoStack.length}단계 (최대 ${f.maxHistory})` : '획 단위 30단계';
  }
  function undo() {
    const e = state.field && state.field.undo();
    if (!e) return;
    if (e.colorBefore) applyColor(e.colorBefore);
    requestRender(); updateHistoryUI();
  }
  function redo() {
    const e = state.field && state.field.redo();
    if (!e) return;
    if (e.colorAfter) applyColor(e.colorAfter);
    requestRender(); updateHistoryUI();
  }
  /** 모두 복원: 변형·피부 보정·색 보정을 한 번에 원래대로 (⌘Z 한 번으로 되돌릴 수 있음) */
  function restoreAll() {
    if (!state.field) return;
    const colorBefore = { ...state.color };
    const e = state.field.restoreAll();
    if (e) { e.colorBefore = colorBefore; e.colorAfter = { exposure: 0, contrast: 0, saturation: 0, temperature: 0 }; }
    applyColor({ exposure: 0, contrast: 0, saturation: 0, temperature: 0 });
    requestRender(); updateHistoryUI();
    setStatusMsg('모두 원래대로 되돌렸습니다 · ⌘Z 로 다시 살릴 수 있어요');
  }
  function thawAll() { if (state.field) { state.field.thawAll(); requestRender(); updateHistoryUI(); } }
  function clearSkin() { if (state.field) { state.field.clearSkin(); requestRender(); updateHistoryUI(); } }

  // ---------- 메뉴 IPC ----------
  if (window.api) {
    window.api.onMenu((action) => {
      switch (action) {
        case 'open': openViaDialog(); break;
        case 'help': toggleHelp(true); break;
        case 'save': save(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'restore': restoreAll(); break;
        case 'thaw-all': thawAll(); break;
        case 'skin-clear': clearSkin(); break;
        case 'zoom-in': zoomCenter(1.25); break;
        case 'zoom-out': zoomCenter(0.8); break;
        case 'zoom-fit': fitView(); break;
        case 'zoom-100': zoomTo100(); break;
        case 'mask-show': state.showMask = true; $('#chk-mask').checked = true; requestRender(); break;
        case 'mask-hide': state.showMask = false; $('#chk-mask').checked = false; requestRender(); break;
      }
    });
    window.api.onOpenFile((p) => loadPath(p));
  }

  // ---------- 열기 ----------
  async function openViaDialog() {
    if (!window.api) return;
    const res = await window.api.openDialog();
    if (res) await loadResult(res);
  }
  async function loadPath(p, force) {
    try {
      const res = await window.api.loadPath(p, force);
      await loadResult(res);
    } catch (err) {
      window.api.showError('열기 실패', String(err && err.message || err));
    }
  }
  async function loadResult(res) {
    setStatusMsg('불러오는 중…');
    try {
      await decodeAndSet(new Blob([res.data]), res.name, res.path);
    } catch (err) {
      if (!res.converted && res.path) {
        // Chromium 이 디코드하지 못하는 포맷 → sips 로 변환해 재시도
        try {
          const r2 = await window.api.loadPath(res.path, true);
          await decodeAndSet(new Blob([r2.data]), r2.name, r2.path);
          return;
        } catch (err2) { err = err2; }
      }
      setStatusMsg('');
      window.api.showError('열기 실패', String(err && err.message || err));
    }
  }
  async function decodeAndSet(blob, name, path) {
    let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const max = renderer.maxTex;
    if (bmp.width > max || bmp.height > max) {
      const s = max / Math.max(bmp.width, bmp.height);
      const b2 = await createImageBitmap(bmp, {
        resizeWidth: Math.floor(bmp.width * s), resizeHeight: Math.floor(bmp.height * s), resizeQuality: 'high',
      });
      bmp.close(); bmp = b2;
    }
    setImageBitmap(bmp, name, path);
  }
  function setImageBitmap(bmp, name, path) {
    renderer.setImage(bmp);
    state.imgW = bmp.width; state.imgH = bmp.height;
    state.field = new LiquifyField(bmp.width, bmp.height, 2048);
    renderer.setField(state.field);
    bmp.close();
    state.fileName = name || ''; state.filePath = path || '';
    $('#file-name').textContent = state.fileName;
    document.title = state.fileName ? `${state.fileName} — 과즙 10%` : '과즙 10%';
    emptyEl.hidden = true;
    for (const id of ['#btn-save', '#btn-compare', '#btn-restore', '#btn-thaw-all', '#btn-skin-clear']) $(id).disabled = false;
    $('#info-size').textContent = `${state.imgW} × ${state.imgH} px`;
    $('#info-grid').textContent = `변위 그리드 ${state.field.gw} × ${state.field.gh} · ${renderer.dispFormat}`;
    // 브러시 기본 크기: 이미지 긴 변의 8%
    setBrushSize(Math.max(5, Math.round(Math.max(state.imgW, state.imgH) * 0.08)));
    updateCursorClass();
    updateHistoryUI();
    setStatusMsg('');
    fitView();
  }

  // 드래그 앤 드롭
  document.addEventListener('dragenter', (e) => { e.preventDefault(); state.dragDepth++; stage.classList.add('dragging'); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--state.dragDepth <= 0) { state.dragDepth = 0; stage.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    state.dragDepth = 0; stage.classList.remove('dragging');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const p = window.api ? window.api.pathForFile(file) : '';
    if (p) await loadPath(p);
    else {
      try { await decodeAndSet(file, file.name, ''); }
      catch (err) { window.api && window.api.showError('열기 실패', String(err && err.message || err)); }
    }
  });

  // ---------- 저장 ----------
  async function encodeCurrent(kind) {
    const { width, height, data } = renderer.renderToPixels(colorUniforms(), skinUniforms());
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height), 0, 0);
    const blob = await new Promise((res, rej) => cv.toBlob((b) => b ? res(b) : rej(new Error('이미지 인코딩 실패')), kind === 'png' ? 'image/png' : 'image/jpeg', 0.95));
    return new Uint8Array(await blob.arrayBuffer());
  }
  async function save() {
    if (!state.field || !window.api) return;
    const base = (state.fileName || 'image').replace(/\.[^.]+$/, '');
    const p = await window.api.saveDialog(`${base}-liquify.jpg`);
    if (!p) return;
    setStatusMsg('저장 중…');
    try {
      const buf = await encodeCurrent(/\.png$/i.test(p) ? 'png' : 'jpeg');
      await window.api.writeFile(p, buf);
      setStatusMsg(`저장됨: ${p}`);
    } catch (err) {
      setStatusMsg('');
      window.api.showError('저장 실패', String(err && err.message || err));
    }
  }

  // ---------- 초기화 ----------
  setTool('warp');
  updateStatus();
  resize();
  if (window.api) window.api.ready();

  // ---------- 셀프 테스트 (electron . --selftest=<dir>) ----------
  window.__probeState = () => {
    const f = state.field;
    let maxD = 0, maxSkin = 0;
    for (let i = 0; i < f.d.length; i += 3) { const v = Math.abs(f.d[i]); if (v > maxD) maxD = v; }
    for (let i = 0; i < f.skin.length; i += 3) if (f.skin[i] > maxSkin) maxSkin = f.skin[i];
    return { maxD, maxSkin, exposure: state.color.exposure,
      exposureSlider: Number(document.querySelector('.row[data-color=exposure] input[type=number]').value),
      undo: f.history.length };
  };
  window.__selftest = async function (outDir) {
    const report = { ok: true, steps: [] };
    const step = (name, data) => { report.steps.push({ name, ...data }); };
    const fail = (name, msg) => { report.ok = false; step(name, { fail: msg }); };
    try {
      // 1) 4000×3000 합성 이미지
      const W = 4000, H = 3000;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#ff9f1c'); g.addColorStop(0.5, '#fff7e8'); g.addColorStop(1, '#242b7a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 6;
      for (let x = 0; x <= W; x += 200) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y <= H; y += 200) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
      ctx.fillStyle = '#f04432'; ctx.beginPath(); ctx.arc(W / 2, H / 2, 400, 0, Math.PI * 2); ctx.fill();
      // 피부 보정 검사용: 잡티가 있는 피부색 영역 + 눈썹 같은 진한 선 (변형이 닿지 않는 오른쪽 위)
      const SK = { x0: 3100, y0: 200, x1: 3700, y1: 700, lineY: 450 };
      ctx.fillStyle = '#e2b093'; ctx.fillRect(SK.x0, SK.y0, SK.x1 - SK.x0, SK.y1 - SK.y0);
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 2600; i++) {
        const r = 1.5 + rnd() * 4, v = rnd();
        ctx.fillStyle = v < 0.5 ? `rgba(150,80,60,${0.35 + v})` : `rgba(255,225,205,${v - 0.2})`;
        ctx.beginPath(); ctx.arc(SK.x0 + rnd() * (SK.x1 - SK.x0), SK.y0 + rnd() * (SK.y1 - SK.y0), r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#3a2418'; ctx.fillRect(SK.x0 + 60, SK.lineY - 6, SK.x1 - SK.x0 - 120, 12);
      const bmp = await createImageBitmap(cv);
      setImageBitmap(bmp, 'selftest.png', '');
      step('load', { imgW: state.imgW, imgH: state.imgH, grid: [state.field.gw, state.field.gh], dispFormat: renderer.dispFormat });

      const f = state.field;
      // 2) 뒤틀기 획 성능 (브러시 400px, 2000px 이동, 좌표 이벤트 100개)
      const runStroke = (sizePx, x0, y0, x1, y1, n) => {
        state.brush.size = sizePx; state.pointer.pressure = 1;
        f.stats = { stamps: 0, stampMs: 0 };
        const t0 = performance.now();
        f.beginStroke();
        f.strokeStart('warp', x0 * f.sx, y0 * f.sy, strokeOpts());
        for (let i = 1; i <= n; i++) {
          const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
          f.strokeTo('warp', x * f.sx, y * f.sy, strokeOpts());
        }
        f.endStroke();
        renderer.flushField();
        return { totalMs: +(performance.now() - t0).toFixed(1), stamps: f.stats.stamps, msPerStamp: +(f.stats.stampMs / Math.max(1, f.stats.stamps)).toFixed(3) };
      };
      const s1 = runStroke(400, 1000, 1500, 3000, 1500, 100);
      step('warp-400px', s1);
      const s2 = runStroke(1500, 1200, 800, 2800, 2200, 60);
      step('warp-1500px', s2);
      // 60fps 기준 한 프레임에 들어오는 이동량(브러시 400px, 빠른 드래그 40px/frame) 체감 비용
      step('frame-budget', { note: '400px 브러시 1프레임(40px 이동≈2 stamps) 예상 ms', ms: +(s1.msPerStamp * 2).toFixed(2) });

      // 뒤틀기 방향: 오른쪽으로 드래그 → 경로 중간의 d.x 는 음수(왼쪽 원본을 보여줌)
      const gi = (Math.round(1500 * f.sy) * f.gw + Math.round(2000 * f.sx)) * 2;
      const dxMid = f.d[gi];
      if (!(dxMid < 0)) fail('warp-direction', `d.x at path mid = ${dxMid}`); else step('warp-direction', { dx: +dxMid.toFixed(3) });

      // 3) 연속 도구 한 프레임 비용 (브러시 400px, JIT 워밍업 후 측정)
      state.brush.size = 400;
      for (const tool of ['pucker', 'bloat', 'twirl', 'smooth', 'reconstruct']) {
        f.beginStroke();
        for (let i = 0; i < 10; i++) f.applyAt(tool, 2000 * f.sx, 1500 * f.sy, strokeOpts(), 1 / 60);
        f.stats = { stamps: 0, stampMs: 0 };
        for (let i = 0; i < 20; i++) f.applyAt(tool, 2000 * f.sx, 1500 * f.sy, strokeOpts(), 1 / 60);
        f.endStroke();
        step(`cont-${tool}-400px`, { msPerFrame: +(f.stats.stampMs / 20).toFixed(2) });
      }
      // 마스크 고정 후 뒤틀기 시 고정 영역 불변 확인 (브러시 400px 로 400→600 드래그)
      f.beginStroke(); f.strokeStart('freeze', 400 * f.sx, 500 * f.sy, { ...strokeOpts(), radius: 200 * f.sx, pressure: 1 });
      for (let i = 1; i <= 20; i++) f.strokeTo('freeze', (400 + i * 10) * f.sx, 500 * f.sy, { ...strokeOpts(), radius: 200 * f.sx, pressure: 1 });
      f.endStroke();
      const mi = Math.round(500 * f.sy) * f.gw + Math.round(500 * f.sx);
      const before = f.d[mi * 2];
      f.beginStroke(); f.strokeStart('warp', 450 * f.sx, 500 * f.sy, strokeOpts()); f.strokeTo('warp', 700 * f.sx, 500 * f.sy, strokeOpts()); f.endStroke();
      if (f.mask[mi] < 0.99) fail('freeze', `mask=${f.mask[mi]}`);
      else if (Math.abs(f.d[mi * 2] - before) > 1e-6) fail('freeze-protect', `d changed ${before}→${f.d[mi * 2]}`);
      else step('freeze-protect', { mask: f.mask[mi] });

      // 4) 실행취소/다시실행
      const hist = f.history.length;
      const snap = f.d.slice();
      f.undo(); f.undo();
      const undone = f.history.length;
      f.redo(); f.redo();
      let maxDiff = 0; for (let i = 0; i < snap.length; i += 997) maxDiff = Math.max(maxDiff, Math.abs(snap[i] - f.d[i]));
      if (undone !== hist - 2 || maxDiff > 1e-6) fail('undo-redo', `hist ${hist}→${undone}, maxDiff ${maxDiff}`);
      else step('undo-redo', { history: hist, maxDiffAfterRedo: maxDiff });

      // 4.5) 피부 보정: 잡티는 줄고 진한 선(경계)은 유지되어야 함
      {
        const lumStats = (px, w, x0, y0, x1, y1) => {
          let s = 0, s2 = 0, n = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4; const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            s += l; s2 += l * l; n++;
          }
          const m = s / n; return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
        };
        const measure = () => {
          const ex = renderer.renderToPixels(colorUniforms(), skinUniforms());
          const noise = lumStats(ex.data, ex.width, SK.x0 + 40, SK.y0 + 30, SK.x1 - 40, SK.lineY - 40);
          const line = lumStats(ex.data, ex.width, SK.x0 + 100, SK.lineY - 3, SK.x1 - 100, SK.lineY + 3);
          return { noiseStd: noise.std, contrast: noise.mean - line.mean };
        };
        const savedColor = { ...state.color };
        applyColor({ exposure: 0, contrast: 0, saturation: 0, temperature: 0 });
        const before = measure();
        // 피부 칠하기 (브러시 300px 로 영역을 지그재그)
        const so = () => ({ ...strokeOpts(), radius: 150 * f.sx, pressure: 1, density: 0.6, erase: false });
        f.beginStroke();
        for (let yy = SK.y0 + 60; yy <= SK.y1 - 60; yy += 120) {
          f.strokeStart('skin', (SK.x0 + 40) * f.sx, yy * f.sy, so());
          for (let xx = SK.x0 + 40; xx <= SK.x1 - 40; xx += 20) f.strokeTo('skin', xx * f.sx, yy * f.sy, so());
        }
        f.endStroke();
        // 화면 비교 영역(가운데)에도 조금 칠해 둔다
        f.beginStroke();
        f.strokeStart('skin', 1700 * f.sx, 1300 * f.sy, so());
        for (let xx = 1700; xx <= 2100; xx += 20) f.strokeTo('skin', xx * f.sx, 1300 * f.sy, so());
        f.endStroke();
        state.skin = { amount: 80, grain: 30 };
        const after = measure();
        const noiseRatio = after.noiseStd / before.noiseStd;
        const edgeRatio = after.contrast / before.contrast;
        // 지우기(⌥) 동작
        const si = (Math.round(450 * f.sy) * f.gw + Math.round(3400 * f.sx));
        const mBefore = f.skin[si];
        f.beginStroke(); f.strokeStart('skin', 3400 * f.sx, 450 * f.sy, { ...so(), erase: true }); f.strokeTo('skin', 3420 * f.sx, 450 * f.sy, { ...so(), erase: true }); f.endStroke();
        const mErased = f.skin[si];
        f.undo();
        const mUndo = f.skin[si];
        applyColor(savedColor);
        const res = {
          smoothMs: +renderer.smoothMs.toFixed(1),
          noiseStd: [+before.noiseStd.toFixed(2), +after.noiseStd.toFixed(2)], noiseRatio: +noiseRatio.toFixed(3),
          edgeContrast: [+before.contrast.toFixed(1), +after.contrast.toFixed(1)], edgeRatio: +edgeRatio.toFixed(3),
          mask: { painted: +mBefore.toFixed(2), erased: +mErased.toFixed(2), undo: +mUndo.toFixed(2) },
        };
        if (noiseRatio < 0.6 && edgeRatio > 0.8 && mBefore > 0.9 && mErased < mBefore && Math.abs(mUndo - mBefore) < 1e-6) step('skin-smooth', res);
        else fail('skin-smooth', JSON.stringify(res));
        // 수동 확인용 잘라낸 이미지
        const ex = renderer.renderToPixels(colorUniforms(), skinUniforms());
        const cw = SK.x1 - SK.x0, chh = SK.y1 - SK.y0;
        const crop = new Uint8ClampedArray(cw * chh * 4);
        for (let y = 0; y < chh; y++) crop.set(ex.data.subarray(((SK.y0 + y) * ex.width + SK.x0) * 4, ((SK.y0 + y) * ex.width + SK.x1) * 4), y * cw * 4);
        const cc = document.createElement('canvas'); cc.width = cw; cc.height = chh;
        cc.getContext('2d').putImageData(new ImageData(crop, cw, chh), 0, 0);
        const cb = await new Promise((r) => cc.toBlob(r, 'image/png'));
        await window.api.writeFile(outDir + '/skin-after.png', new Uint8Array(await cb.arrayBuffer()));
        state.skin = { amount: 0, grain: 35 };
        const ex0 = renderer.renderToPixels(colorUniforms(), skinUniforms());
        for (let y = 0; y < chh; y++) crop.set(ex0.data.subarray(((SK.y0 + y) * ex0.width + SK.x0) * 4, ((SK.y0 + y) * ex0.width + SK.x1) * 4), y * cw * 4);
        cc.getContext('2d').putImageData(new ImageData(crop, cw, chh), 0, 0);
        const cb0 = await new Promise((r) => cc.toBlob(r, 'image/png'));
        await window.api.writeFile(outDir + '/skin-before.png', new Uint8Array(await cb0.arrayBuffer()));
        state.skin = { amount: 80, grain: 30 };
      }

      // 5) 화면 vs 내보내기 비교 (이미지 1px = 백킹 1px 로 맞춤)
      applyColor({ exposure: 0.3, contrast: 15, saturation: 10, temperature: 20 });
      state.showMask = false;
      state.view.scale = 1 / state.dpr;
      state.view.x = -(1200 / state.dpr); state.view.y = -(900 / state.dpr);   // 변형 영역이 보이게 이동
      render();
      const exp = renderer.renderToPixels(colorUniforms(), skinUniforms());
      const rw = Math.min(glCanvas.width, 1200), rh = Math.min(glCanvas.height, 900);
      const scr = renderer.readScreen(0, 0, rw, rh);
      let sum = 0, mx = 0, cnt = 0;
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const si = (y * rw + x) * 4, ei = ((y + 900) * exp.width + (x + 1200)) * 4;
          for (let c = 0; c < 3; c++) { const dd = Math.abs(scr[si + c] - exp.data[ei + c]); sum += dd; if (dd > mx) mx = dd; cnt++; }
        }
      }
      const meanDiff = sum / cnt;
      if (meanDiff > 1.0 || mx > 48) fail('screen-vs-export', `mean ${meanDiff.toFixed(3)} max ${mx}`);
      else step('screen-vs-export', { region: [rw, rh], meanDiff: +meanDiff.toFixed(4), maxDiff: mx });

      // 6) 파일로 저장 (PNG + JPG)
      const tEnc = performance.now();
      const jpg = await encodeCurrent('jpeg');
      await window.api.writeFile(outDir + '/export.jpg', jpg);
      const png = await encodeCurrent('png');
      await window.api.writeFile(outDir + '/export.png', png);
      step('save', { jpgBytes: jpg.length, pngBytes: png.length, ms: +(performance.now() - tEnc).toFixed(0) });
      // 화면 캡처도 저장 (수동 확인용)
      const sc = document.createElement('canvas'); sc.width = rw; sc.height = rh;
      sc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(scr.buffer), rw, rh), 0, 0);
      const sb = await new Promise((r) => sc.toBlob(r, 'image/png'));
      await window.api.writeFile(outDir + '/screen.png', new Uint8Array(await sb.arrayBuffer()));
    } catch (err) {
      fail('exception', String(err && err.stack || err));
    }
    // 7) 단축키: 한글 입력 상태(e.key='ㄱ', code='KeyR') + 슬라이더 포커스 상태에서도 동작해야 함
    try {
      const key = (target, code, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, ...extra }));
      const results = {};
      setTool('warp');
      key(document.body, 'KeyR', 'ㄱ'); results.korean_R = state.tool;
      key(document.body, 'KeyK', 'ㅏ'); results.korean_K = state.tool;
      const range = document.querySelector('.row[data-opt=size] input[type=range]');
      range.focus();
      key(range, 'KeyC', 'ㅊ'); results.rangeFocus_C = state.tool;
      const s0 = state.brush.size;
      key(range, 'BracketRight', ']'); results.bracket_grow = state.brush.size > s0;
      const num = document.querySelector('.row[data-opt=size] input[type=number]');
      num.focus();
      key(num, 'KeyB', 'ㅠ'); results.numberField_ignored = state.tool === 'twirl';
      num.blur();
      key(document.body, 'Slash', '?', { shiftKey: true }); results.help_open = !$('#help').hidden;
      key(document.body, 'Escape', 'Escape'); results.help_close = $('#help').hidden;
      setTool('warp');
      const ok = results.korean_R === 'reconstruct' && results.korean_K === 'skin' && results.rangeFocus_C === 'twirl' && results.bracket_grow
        && results.numberField_ignored && results.help_open && results.help_close;
      if (ok) step('shortcuts', results); else fail('shortcuts', JSON.stringify(results));
    } catch (err) { fail('shortcuts', String(err)); }

    // UI 캡처용으로 보기 좋게 정리
    state.showMask = true; setBrushSize(400); fitView(); updateHistoryUI(); render();
    state.pointer.inside = true; state.pointer.sx = 520; state.pointer.sy = 360; drawOverlay();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return report;
  };
})();
