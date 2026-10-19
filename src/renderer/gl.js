'use strict';
/* WebGL2 렌더러: 원본 텍스처를 변위장(d) 만큼 밀어서 샘플링한다. */

const VS = `#version 300 es
in vec2 aPos;                 // 0..1 (이미지 공간)
uniform vec2 uOffset;         // 캔버스 px (백킹 버퍼 기준)
uniform vec2 uCanvas;         // 캔버스 크기 px
uniform vec2 uImgSize;        // 이미지 px
uniform float uScale;         // 이미지 px -> 캔버스 px
uniform float uFlip;          // 1: 화면, -1: FBO(readPixels 가 위→아래 순서가 되게)
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 px = uOffset + aPos * uImgSize * uScale;
  vec2 clip = px / uCanvas * 2.0 - 1.0;
  clip.y = -clip.y * uFlip;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImg;
uniform sampler2D uDisp;
uniform sampler2D uMask;
uniform vec2 uGrid;           // 변위 그리드 크기 (d 는 그리드 px 단위)
uniform float uShowOrig;
uniform float uShowMask;
uniform float uExposure;      // EV
uniform float uContrast;      // 배율
uniform float uSaturation;    // 배율
uniform float uTemp;          // -1..1
void main() {
  vec2 d = uShowOrig > 0.5 ? vec2(0.0) : texture(uDisp, vUv).rg;
  vec2 src = vUv + d / uGrid;
  vec3 c = texture(uImg, src).rgb;
  c *= exp2(uExposure);
  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSaturation);
  c += vec3(uTemp * 0.10, uTemp * 0.02, -uTemp * 0.10);
  c = clamp(c, 0.0, 1.0);
  if (uShowMask > 0.5) {
    float m = texture(uMask, vUv).r;
    c = mix(c, vec3(1.0, 0.18, 0.18), clamp(m, 0.0, 1.0) * 0.45);
  }
  outColor = vec4(c, 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('이 환경에서는 WebGL2 를 사용할 수 없습니다.');
    this.gl = gl;

    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);

    this.prog = this._program(VS, FS);
    const u = (n) => gl.getUniformLocation(this.prog, n);
    this.u = {
      offset: u('uOffset'), canvas: u('uCanvas'), imgSize: u('uImgSize'), scale: u('uScale'), flip: u('uFlip'),
      img: u('uImg'), disp: u('uDisp'), mask: u('uMask'), grid: u('uGrid'),
      showOrig: u('uShowOrig'), showMask: u('uShowMask'),
      exposure: u('uExposure'), contrast: u('uContrast'), saturation: u('uSaturation'), temp: u('uTemp'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.imgTex = null; this.dispTex = null; this.maskTex = null;
    this.imgW = 0; this.imgH = 0;
    this.field = null;
    this.dispFormat = this.floatLinear ? 'RG32F' : 'RG16F';
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('셰이더 컴파일 실패: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('프로그램 링크 실패: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  /** 원본 이미지 업로드 (mipmap 포함) */
  setImage(bitmap) {
    const gl = this.gl;
    if (this.imgTex) gl.deleteTexture(this.imgTex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisoExt) {
      const max = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, max));
    }
    this.imgTex = t;
    this.imgW = bitmap.width;
    this.imgH = bitmap.height;
  }

  /** 변위장/마스크 텍스처 생성 */
  setField(field) {
    const gl = this.gl;
    this.field = field;
    if (this.dispTex) gl.deleteTexture(this.dispTex);
    if (this.maskTex) gl.deleteTexture(this.maskTex);

    const mk = (internal, format, data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, field.gw, field.gh, 0, format, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.dispTex = mk(this.floatLinear ? gl.RG32F : gl.RG16F, gl.RG, field.d);
    this.maskTex = mk(this.floatLinear ? gl.R32F : gl.R16F, gl.RED, field.mask);
  }

  _uploadSub(tex, format, data, r) {
    const gl = this.gl;
    const f = this.field;
    const x0 = Math.max(0, r.x0 | 0), y0 = Math.max(0, r.y0 | 0);
    const x1 = Math.min(f.gw, Math.ceil(r.x1)), y1 = Math.min(f.gh, Math.ceil(r.y1));
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.gw);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, format, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  uploadDisp(r) { if (this.field) this._uploadSub(this.dispTex, this.gl.RG, this.field.d, r); }
  uploadMask(r) { if (this.field) this._uploadSub(this.maskTex, this.gl.RED, this.field.mask, r); }

  /** 대기 중인 변경 영역을 모두 업로드 */
  flushField() {
    const f = this.field;
    if (!f) return;
    const dr = f.takeDirty(); if (dr) this.uploadDisp(dr);
    const mr = f.takeMaskDirty(); if (mr) this.uploadMask(mr);
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.957, 0.918, 0.859, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _drawQuad(o) {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.dispTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.u.img, 0);
    gl.uniform1i(this.u.disp, 1);
    gl.uniform1i(this.u.mask, 2);
    gl.uniform2f(this.u.offset, o.offsetX, o.offsetY);
    gl.uniform2f(this.u.canvas, o.canvasW, o.canvasH);
    gl.uniform2f(this.u.imgSize, this.imgW, this.imgH);
    gl.uniform1f(this.u.scale, o.scale);
    gl.uniform1f(this.u.flip, o.flip);
    gl.uniform2f(this.u.grid, this.field.gw, this.field.gh);
    gl.uniform1f(this.u.showOrig, o.showOriginal ? 1 : 0);
    gl.uniform1f(this.u.showMask, o.showMask ? 1 : 0);
    const c = o.color || {};
    gl.uniform1f(this.u.exposure, c.exposure ?? 0);
    gl.uniform1f(this.u.contrast, c.contrast ?? 1);
    gl.uniform1f(this.u.saturation, c.saturation ?? 1);
    gl.uniform1f(this.u.temp, c.temperature ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** 화면에 그리기. offset/scale 은 백킹 버퍼 px 기준 */
  draw(o) {
    const gl = this.gl;
    this.flushField();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.957, 0.918, 0.859, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.imgTex || !this.field) return;
    this._drawQuad({
      offsetX: o.offsetX, offsetY: o.offsetY, scale: o.scale,
      canvasW: this.canvas.width, canvasH: this.canvas.height, flip: 1,
      showOriginal: o.showOriginal, showMask: o.showMask, color: o.color,
    });
  }

  /** 화면 백킹 버퍼의 일부를 읽는다 (위→아래 순서로 정렬해서 반환, RGBA) */
  readScreen(x, y, w, h) {
    const gl = this.gl;
    const H = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // 위아래 뒤집기
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let a = 0, b = h - 1; a < b; a++, b--) {
      tmp.set(buf.subarray(a * row, a * row + row));
      buf.copyWithin(a * row, b * row, b * row + row);
      buf.set(tmp, b * row);
    }
    return buf;
  }

  /** 원본 해상도로 FBO 렌더 → RGBA 픽셀 (위→아래 순서) */
  renderToPixels(color) {
    const gl = this.gl;
    this.flushField();
    const w = this.imgW, h = this.imgH;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      throw new Error('내보내기용 프레임버퍼를 만들 수 없습니다.');
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._drawQuad({
      offsetX: 0, offsetY: 0, scale: 1, canvasW: w, canvasH: h, flip: -1,
      showOriginal: false, showMask: false, color,
    });
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return { width: w, height: h, data };
  }
}

window.Renderer = Renderer;
