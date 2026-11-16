// The picture work of the fast path, on the graphics card (WebGL 2): turning, cropping, scaling, Ken Burns and Life movement in one
// resampling step, blends, sharpening, colour breathing, trails, the small grey pictures used to study a clip, and "Smooth motion":
// new frames made between two frames by following the movement (a motion field, found coarse to fine, then each picture is pushed
// along it to the moment in between). All pictures are kept with the top row first; only the last copy to the canvas is turned over.

const VS = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
vec3 toYuv(vec3 c) { float y = dot(c, vec3(0.2126, 0.7152, 0.0722)); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
vec3 toRgb(vec3 v) { float r = v.x + 1.5748 * v.z, b = v.x + 1.8556 * v.y; return vec3(r, (v.x - 0.2126 * r - 0.0722 * b) / 0.7152, b); }
`;
// output pixel -> source pixel through a 3x3 matrix; Catch-Mull-Rom (cubic) when enlarging, smooth area sampling when shrinking a lot
const FS_WARP = HEAD + `
uniform sampler2D src; uniform vec2 ss; uniform mat3 H; uniform int flip; uniform float outH; uniform float lod; uniform int bg; uniform mat3 C; uniform vec2 cs;
vec4 fetch(ivec2 p) { return texelFetch(src, clamp(p, ivec2(0), ivec2(ss) - 1), 0); }
vec4 cubic(vec2 u) {
  vec2 f = u - 0.5, i = floor(f), t = f - i;
  vec2 w0 = t * (-0.5 + t * (1.0 - 0.5 * t)), w1 = 1.0 + t * t * (-2.5 + 1.5 * t), w2 = t * (0.5 + t * (2.0 - 1.5 * t)), w3 = t * t * (-0.5 + 0.5 * t);
  vec4 s = vec4(0.0); ivec2 b = ivec2(i);
  float wx[4] = float[4](w0.x, w1.x, w2.x, w3.x), wy[4] = float[4](w0.y, w1.y, w2.y, w3.y);
  for (int y = 0; y < 4; y++) { vec4 r = vec4(0.0); for (int x = 0; x < 4; x++) r += wx[x] * fetch(b + ivec2(x - 1, y - 1)); s += wy[y] * r; }
  return s;
}
void main() {
  vec2 p = gl_FragCoord.xy; if (flip == 1) p.y = outH - p.y;
  vec3 q = H * vec3(p, 1.0); vec2 u = q.xy / q.z;
  vec3 r = C * vec3(p, 1.0); vec2 v = r.xy / r.z;
  if (bg == 1 && (u.x < -0.01 || u.y < -0.01 || u.x > ss.x + 0.01 || u.y > ss.y + 0.01 || v.x < -0.01 || v.y < -0.01 || v.x > cs.x + 0.01 || v.y > cs.y + 0.01)) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 c = lod > 0.0 ? textureLod(src, u / ss, lod) : cubic(u);
  o = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`;
const FS_MIX = HEAD + `
uniform sampler2D a; uniform sampler2D b; uniform float w;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(mix(texelFetch(a, p, 0).rgb, texelFetch(b, p, 0).rgb, w), 1.0); }`;
// sharpening (luma only, like ffmpeg unsharp with no chroma amount) and colour breathing (brightness add, saturation)
const FS_FX = HEAD + `
uniform sampler2D src; uniform float sharp; uniform float bright; uniform float sat; uniform int flip; uniform float outH;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); if (flip == 1) p.y = int(outH) - 1 - p.y;
  ivec2 m = textureSize(src, 0) - 1;
  vec3 c = texelFetch(src, p, 0).rgb, v = toYuv(c);
  if (sharp > 0.0) {
    float s = 0.0, ws = 0.0;
    for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) { float k = exp(-float(x * x + y * y) / 2.5); s += k * toYuv(texelFetch(src, clamp(p + ivec2(x, y), ivec2(0), m), 0).rgb).x; ws += k; }
    v.x += sharp * (v.x - s / ws);
  }
  v.x += bright; v.yz *= sat;
  o = vec4(clamp(toRgb(v), 0.0, 1.0), 1.0);
}`;
const FS_TRAIL = HEAD + `
uniform sampler2D t0; uniform sampler2D t1; uniform sampler2D t2; uniform sampler2D t3; uniform vec4 w;
void main() { ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s = w.x * texelFetch(t0, p, 0).rgb + w.y * texelFetch(t1, p, 0).rgb + w.z * texelFetch(t2, p, 0).rgb + w.w * texelFetch(t3, p, 0).rgb;
  o = vec4(s / max(1e-6, w.x + w.y + w.z + w.w), 1.0); }`;
// area shrink (8 x 8 bilinear taps over the footprint); mode 0 colour, 1 luma in r, 2 grey like ffmpeg's format=gray
const FS_DOWN = HEAD + `
uniform sampler2D src; uniform vec2 ss; uniform vec2 ds; uniform int mode;
void main() {
  vec2 f = ss / ds, b = (gl_FragCoord.xy - 0.5) * f; vec3 s = vec3(0.0);
  float lod = max(0.0, log2(max(f.x, f.y) / 8.0));   // 8 x 8 taps cover the footprint; a coarser picture level only when the footprint is wider
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) s += textureLod(src, (b + (vec2(x, y) + 0.5) * f / 8.0) / ss, lod).rgb;
  s /= 64.0;
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  o = mode == 0 ? vec4(s, 1.0) : mode == 1 ? vec4(l, l, l, 1.0) : vec4(l, l, l, 1.0);   // ffmpeg's format=gray is full range
}`;
// one level of the motion search: flow A->B (in pixels of this level), started from the coarser level's answer
const FS_MATCH = HEAD + `
uniform sampler2D A; uniform sampler2D B; uniform sampler2D prev; uniform int hasPrev; uniform int R;
vec2 sz;
float la(vec2 p) { return texelFetch(A, ivec2(clamp(p, vec2(0.0), sz - 1.0)), 0).r; }
float lb(vec2 p) { return texture(B, (p + 0.5) / sz).r; }
float cost(vec2 p, vec2 d) {
  float s = 0.0;
  // nine points spread over a 5 x 5 patch: as good as all 25 here (measured against real in-between frames), at a third of the work
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 q = p + vec2(x, y) * 2.0; s += abs(la(q) - lb(q + d)); }
  return s * 25.0 / 9.0;
}
void main() {
  sz = vec2(textureSize(A, 0)); vec2 p = floor(gl_FragCoord.xy);
  vec2 init = hasPrev == 1 ? 2.0 * texture(prev, gl_FragCoord.xy / sz).xy : vec2(0.0);
  vec2 best = init; float bc = cost(p, init) * 0.98;
  for (int y = -R; y <= R; y++) for (int x = -R; x <= R; x++) {
    if (x == 0 && y == 0) continue;
    vec2 d = init + vec2(x, y); float c = cost(p, d) + 0.004 * length(vec2(x, y));
    if (c < bc) { bc = c; best = d; }
  }
  float cx0 = cost(p, best - vec2(1, 0)), cx1 = cost(p, best + vec2(1, 0)), cy0 = cost(p, best - vec2(0, 1)), cy1 = cost(p, best + vec2(0, 1));
  float dx = cx0 + cx1 - 2.0 * bc, dy = cy0 + cy1 - 2.0 * bc;
  vec2 sub = vec2(dx > 1e-5 ? clamp(0.5 * (cx0 - cx1) / dx, -0.5, 0.5) : 0.0, dy > 1e-5 ? clamp(0.5 * (cy0 - cy1) / dy, -0.5, 0.5) : 0.0);
  o = vec4(best + sub, bc / 25.0, 1.0);
}`;
// 3 x 3 median of each flow component, which removes stray vectors and keeps edges
const FS_MED = HEAD + `
uniform sampler2D F;
float med9(float v[9]) { for (int i = 0; i < 5; i++) for (int j = i + 1; j < 9; j++) if (v[j] < v[i]) { float t = v[i]; v[i] = v[j]; v[j] = t; } return v[4]; }
void main() { ivec2 p = ivec2(gl_FragCoord.xy), m = textureSize(F, 0) - 1; float xs[9], ys[9], cs[9]; int k = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec4 f = texelFetch(F, clamp(p + ivec2(x, y), ivec2(0), m), 0); xs[k] = f.x; ys[k] = f.y; cs[k] = f.z; k++; }
  o = vec4(med9(xs), med9(ys), med9(cs), 1.0); }`;
// Where following the movement does not make the two pictures agree better than standing still, a plain blend is safer. This is
// worked out on the small pictures of the motion search (cheap), once for every new frame: 1 = blend, 0 = follow the movement.
const FS_CONF = HEAD + `
uniform sampler2D LA; uniform sampler2D LB; uniform sampler2D F01; uniform sampler2D F10; uniform float t;
void main() {
  vec2 sz = vec2(textureSize(LA, 0)), p = gl_FragCoord.xy; ivec2 ip = ivec2(p);
  vec2 f01 = texelFetch(F01, ip, 0).xy, f10 = texelFetch(F10, ip, 0).xy;
  vec2 ft0 = -(1.0 - t) * t * f01 + t * t * f10, ft1 = (1.0 - t) * (1.0 - t) * f01 - t * (1.0 - t) * f10;
  float ew = 0.0, e0 = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 q = p + vec2(x, y);
    ew += abs(texture(LA, (q + ft0) / sz).r - texture(LB, (q + ft1) / sz).r); e0 += abs(texture(LA, q / sz).r - texture(LB, q / sz).r); }
  o = vec4(vec3(smoothstep(-0.025, 0.02, (ew - e0) / 9.0)), 1.0);
}`;
// the frame in between at time t: both pictures pushed along the flow (linear approximation of the flow from time t), then blended
const FS_INTERP = HEAD + `
uniform sampler2D A; uniform sampler2D B; uniform sampler2D F01; uniform sampler2D F10; uniform sampler2D C; uniform float t; uniform float k;
void main() {
  vec2 sz = vec2(textureSize(A, 0)), p = gl_FragCoord.xy, fu = p / sz;
  vec2 f01 = texture(F01, fu).xy * k, f10 = texture(F10, fu).xy * k;
  vec2 ft0 = -(1.0 - t) * t * f01 + t * t * f10, ft1 = (1.0 - t) * (1.0 - t) * f01 - t * (1.0 - t) * f10;
  vec3 a = texture(A, (p + ft0) / sz).rgb, b = texture(B, (p + ft1) / sz).rgb;
  float s = texture(C, fu).r;
  vec3 m = mix(a, b, t);
  o = vec4(s > 0.004 ? mix(m, mix(texture(A, fu).rgb, texture(B, fu).rgb, t), s) : m, 1.0);
}`;

// A picture as BT.709 video (limited range, 4:2:0) for the encoder, all three planes in ONE texture so that one read gets it all:
// rows 0..H-1 hold the luma (four values in each RGBA pixel); below them H/2 rows with U in the left part and V from pixel cw on.
const FS_YUV = HEAD + `
uniform sampler2D src; uniform int H; uniform int cw;
float Y(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float luma(ivec2 q, ivec2 m) { return (16.0 + 219.0 * Y(texelFetch(src, clamp(q, ivec2(0), m), 0).rgb)) / 255.0; }
float chroma(ivec2 q, ivec2 m, bool u) {
  vec3 c = vec3(0.0); for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) c += texelFetch(src, clamp(q * 2 + ivec2(x, y), ivec2(0), m), 0).rgb; c *= 0.25;
  float l = Y(c); return (128.0 + 224.0 * (u ? (c.b - l) / 1.8556 : (c.r - l) / 1.5748)) / 255.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), m = textureSize(src, 0) - 1;
  if (p.y < H) { int x = p.x * 4; o = vec4(luma(ivec2(x, p.y), m), luma(ivec2(x + 1, p.y), m), luma(ivec2(x + 2, p.y), m), luma(ivec2(x + 3, p.y), m)); }
  else { bool u = p.x < cw; int x = (u ? p.x : p.x - cw) * 4, y = p.y - H; o = vec4(chroma(ivec2(x, y), m, u), chroma(ivec2(x + 1, y), m, u), chroma(ivec2(x + 2, y), m, u), chroma(ivec2(x + 3, y), m, u)); }
}`;

// Safari and every browser on an iPhone or iPad (all WebKit) keep the plain, proven way of reading pictures back; the others read
// them back without waiting (see readBegin).
const WEBKIT = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent || '') && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent || '');
const tick = () => new Promise(r => setTimeout(r, 0));

export class Gpu {
  constructor() {
    // a page canvas where there is a page (every browser can make a VideoFrame from one); OffscreenCanvas otherwise
    this.canvas = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 16, height: 16 }) : new OffscreenCanvas(16, 16);
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    // Which graphics card draws? A browser that has no working driver for it draws with the processor instead (SwiftShader, llvmpipe),
    // which is some 30 times slower: then the fast way is not fast.
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    this.software = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|microsoft basic/i.test(this.renderer);
    gl.getExtension('OES_texture_float_linear');
    this.lost = false;
    if (this.canvas.addEventListener) this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    this.vao = gl.createVertexArray(); this.fb = gl.createFramebuffer(); this.progs = {};
    for (const [k, fs] of Object.entries({ yuv: FS_YUV, warp: FS_WARP, mix: FS_MIX, fx: FS_FX, trail: FS_TRAIL, down: FS_DOWN, match: FS_MATCH, med: FS_MED, conf: FS_CONF, interp: FS_INTERP })) this.progs[k] = this.prog(fs);
    this.scratch = new Map(); this.pool = []; this.pbos = [];
    this.issued = 0; this.done = 0;   // pictures asked back from the card, and how many of those have arrived
    this.asyncRead = !(Gpu.syncRead === true || (Gpu.syncRead !== false && WEBKIT));
  }
  prog(fs) {
    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const loc = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); loc[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name); }
    return { p, loc };
  }
  check() { if (this.lost || this.gl.isContextLost()) throw new Error('GPU_LOST'); }
  // a texture; kind 'rgba8' (pictures) or 'f16' (motion fields)
  tex(w, h, kind = 'rgba8', mips = false) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    const lv = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, lv, kind === 'f16' ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { t, w, h, kind, mips };
  }
  free(x) { if (x && x.t) { this.gl.deleteTexture(x.t); x.t = null; } }
  // a reusable texture of this size for temporary work, by name
  tmp(name, w, h, kind = 'rgba8', mips = false) {
    let x = this.scratch.get(name); if (x && x.w === w && x.h === h && x.kind === kind && x.mips === mips) return x;
    if (x) this.free(x); x = this.tex(w, h, kind, mips); this.scratch.set(name, x); return x;
  }
  mipmap(x) { if (x.mips) { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, x.t); gl.generateMipmap(gl.TEXTURE_2D); } }
  // a decoded frame (VideoFrame, or anything WebGL can read) as a texture; mips when it will be shrunk a lot
  upload(frame, w, h, mips = false, into = null) {
    const gl = this.gl; let x = into && into.w === w && into.h === h && into.mips === mips ? into : null;
    if (!x) { if (into) this.free(into); x = this.tex(w, h, 'rgba8', mips); }
    gl.bindTexture(gl.TEXTURE_2D, x.t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, frame); }
    catch (e) {   // some browsers cannot hand a video frame to WebGL directly: through a 2D canvas instead
      const c = this.c2 || (this.c2 = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext('2d'); g.drawImage(frame, 0, 0, w, h); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, c);
    }
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    return x;
  }
  run(name, dst, set) {
    const gl = this.gl, P = this.progs[name]; gl.useProgram(P.p); gl.bindVertexArray(this.vao);
    if (dst) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst.t, 0); gl.viewport(0, 0, dst.w, dst.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    let unit = 0;
    const U = {
      tex: (n, x) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, x.t); gl.uniform1i(P.loc[n], unit); unit++; },
      f: (n, ...v) => P.loc[n] != null && gl[`uniform${v.length}f`](P.loc[n], ...v), i: (n, v) => P.loc[n] != null && gl.uniform1i(P.loc[n], v),
      m3: (n, m) => gl.uniformMatrix3fv(P.loc[n], false, m),
    };
    set(U); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  size(w, h) { if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; } }

  // H: output pixel -> source pixel (row-major 3x3 array). dst null = the canvas. bg: black outside the source.
  // clip: { C (output pixel -> a space where only [0, w] x [0, h] is picture), w, h }: the bars of a letterbox stay black
  warp(dst, src, H, { bg = true, outH = 0, clip = null } = {}) {
    const ow = dst ? dst.w : this.canvas.width, oh = dst ? dst.h : this.canvas.height;
    // how many source pixels one output pixel covers; above 1.6 an area average (mipmaps) is used instead of the cubic
    const sx = Math.hypot(H[0], H[3]) , sy = Math.hypot(H[1], H[4]), sc = Math.max(sx, sy) / Math.max(1e-6, Math.abs(H[6] * ow / 2 + H[7] * oh / 2 + H[8]));
    const lod = src.mips && sc > 1.6 ? Math.log2(sc) - 0.3 : 0;
    this.run('warp', dst, U => { U.tex('src', src); U.f('ss', src.w, src.h); U.m3('H', [H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]]); U.i('flip', dst ? 0 : 1); U.f('outH', outH || oh); U.f('lod', lod); U.i('bg', bg ? 1 : 0);
      const C = clip ? clip.C : [1, 0, 0, 0, 1, 0, 0, 0, 1]; U.m3('C', [C[0], C[3], C[6], C[1], C[4], C[7], C[2], C[5], C[8]]); U.f('cs', clip ? clip.w : 1e9, clip ? clip.h : 1e9); });
  }
  mix(dst, a, b, w) { this.run('mix', dst, U => { U.tex('a', a); U.tex('b', b); U.f('w', w); }); }
  fx(dst, src, { sharp = 0, bright = 0, sat = 1 } = {}) { this.run('fx', dst, U => { U.tex('src', src); U.f('sharp', sharp); U.f('bright', bright); U.f('sat', sat); U.i('flip', dst ? 0 : 1); U.f('outH', dst ? dst.h : this.canvas.height); }); }
  trail(dst, ts, ws) { const t = [0, 1, 2, 3].map(i => ts[Math.min(i, ts.length - 1)]), w = [0, 1, 2, 3].map(i => i < ts.length ? ws[i] : 0); this.run('trail', dst, U => { t.forEach((x, i) => U.tex('t' + i, x)); U.f('w', ...w); }); }
  // ---- handing a finished picture to the encoder: I420 video data (BT.709, limited range), rows packed tight. We convert the colours
  // ourselves, so they come out the same on every device (encoders differ in how they would turn RGB into video colours).
  // Reading a picture back from the graphics card normally makes the page wait until the card has finished everything it was asked
  // to do. readBegin only asks for the copy (into a buffer on the card's side) and returns at once; readEnd collects it when it is
  // ready. In between, the page can already prepare the next frame, so the card and the processor work at the same time.
  yuvPlan(W, H) { const yw = Math.ceil(W / 4), cw = Math.ceil(W / 8), tw = Math.max(yw, 2 * cw), th = H + H / 2; return { cw, tw, th, bytes: tw * th * 4 }; }
  readBegin(src, wantGray = false) {
    const gl = this.gl, W = src.w, H = src.h, P = this.yuvPlan(W, H), t = this.tmp('yuv', P.tw, P.th);
    this.run('yuv', t, U => { U.tex('src', src); U.i('H', H); U.i('cw', P.cw); });
    const g = wantGray ? this.grayTex(src) : null, total = P.bytes + (g ? 9216 : 0), job = { W, H, P, gray: !!g, total };
    const att = x => { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, x.t, 0); };
    if (this.asyncRead) {
      const slot = this.pboI = ((this.pboI || 0) + 1) % 2; let pb = this.pbos[slot];
      if (!pb || pb.size < total) { if (pb) gl.deleteBuffer(pb.b); pb = this.pbos[slot] = { b: gl.createBuffer(), size: total }; gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb.b); gl.bufferData(gl.PIXEL_PACK_BUFFER, total, gl.STREAM_READ); }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb.b);
      att(t); gl.readPixels(0, 0, P.tw, P.th, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      if (g) { att(g); gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.UNSIGNED_BYTE, P.bytes); }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      job.pb = pb; job.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); job.no = ++this.issued;
    } else {
      if (!this.raw || this.raw.length < total) this.raw = new Uint8Array(total);
      att(t); gl.readPixels(0, 0, P.tw, P.th, gl.RGBA, gl.UNSIGNED_BYTE, this.raw, 0);
      if (g) { att(g); gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.UNSIGNED_BYTE, this.raw, P.bytes); }
      this.done = ++this.issued;   // read at once: the card has finished
    }
    return job;
  }
  // -> { pic: { data, layout, w, h } for new VideoFrame(...) or a raw-video pipe, gray: the 64 x 36 grey picture or null }
  async readEnd(job) {
    const gl = this.gl;
    if (job.sync) {
      const t0 = performance.now();
      for (;;) { const s = gl.clientWaitSync(job.sync, 0, 0); if (s !== gl.TIMEOUT_EXPIRED || performance.now() - t0 > 8000) break; await tick(); this.check(); }
      gl.deleteSync(job.sync); job.sync = null;
      if (!this.raw || this.raw.length < job.total) this.raw = new Uint8Array(job.total);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pb.b); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.raw, 0, job.total); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.done = Math.max(this.done, job.no);
    }
    const raw = this.raw, { W, H, P } = job, st = P.tw * 4, cw2 = W / 2, h2 = H / 2, tY = W * H, size = tY + 2 * cw2 * h2;
    // rows packed tight: some encoders ignore the row length they are given (the picture then comes out slanted in stripes)
    if (!this.tight || this.tight.length !== size) this.tight = new Uint8Array(size);
    const d = this.tight;
    if (st === W) d.set(raw.subarray(0, tY), 0); else for (let y = 0; y < H; y++) d.set(raw.subarray(y * st, y * st + W), y * W);
    for (let y = 0; y < h2; y++) { const o = (H + y) * st; d.set(raw.subarray(o, o + cw2), tY + y * cw2); d.set(raw.subarray(o + P.cw * 4, o + P.cw * 4 + cw2), tY + cw2 * h2 + y * cw2); }
    let gray = null; if (job.gray) { gray = new Uint8Array(2304); for (let i = 0; i < 2304; i++) gray[i] = raw[P.bytes + i * 4]; }
    return { pic: { data: d, layout: [{ offset: 0, stride: W }, { offset: tY, stride: cw2 }, { offset: tY + cw2 * h2, stride: cw2 }], w: W, h: H }, gray };
  }
  // copy a picture to the canvas (turned over for it), so a VideoFrame can be made from it
  show(src) { this.size(src.w, src.h); this.fx(null, src, {}); }
  down(dst, src, mode = 0) { this.run('down', dst, U => { U.tex('src', src); U.f('ss', src.w, src.h); U.f('ds', dst.w, dst.h); U.i('mode', mode); }); }
  read(src) {
    const gl = this.gl, out = new Uint8Array(src.w * src.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src.t, 0);
    gl.readPixels(0, 0, src.w, src.h, gl.RGBA, gl.UNSIGNED_BYTE, out); return out;
  }
  // the 64 x 36 grey picture used to study a clip (like ffmpeg's scale=64:36:flags=area,format=gray)
  // A big picture is first shrunk to 512 x 288 (8 x 8 taps per pixel there), then to 64 x 36: no picture levels (mipmaps) need to be
  // made for every frame, which is what made looking at a big clip slow.
  grayTex(src) { const g = this.tmp('gray', 64, 36); let s = src; if (src.w > 1024 || src.h > 576) { s = this.tmp('gray2', 512, 288); this.down(s, src, 0); } this.down(g, s, 2); return g; }
  gray(src) { const px = this.read(this.grayTex(src)), out = new Uint8Array(64 * 36); for (let i = 0; i < out.length; i++) out[i] = px[i * 4]; return out; }

  // ------------------------------------------------------------------------------------------ Smooth motion
  // The motion field between two pictures is worked out once and reused for every frame made between them.
  flowSize(w, h) { const s = Math.min(1, (Gpu.FLOW_MAX || 480) / Math.max(w, h)); return [Math.max(16, Math.round(w * s)), Math.max(16, Math.round(h * s))]; }
  pyramid(name, src) {
    const [fw, fh] = this.flowSize(src.w, src.h), lv = []; let w = fw, h = fh, prev = src;
    for (let i = 0; i < 6 && w >= 16 && h >= 16; i++) { const t = this.tmp(`${name}${i}`, w, h); this.down(t, prev, i ? 0 : 1); lv.push(t); prev = t; w = Math.round(w / 2); h = Math.round(h / 2); }
    return lv;
  }
  flowOne(tag, LA, LB) {
    let prev = null;
    for (let i = LA.length - 1; i >= 0; i--) {
      const a = LA[i], b = LB[i], f = this.tmp(`${tag}f${i}`, a.w, a.h, 'f16'), m = this.tmp(`${tag}m${i}`, a.w, a.h, 'f16');
      this.run('match', f, U => { U.tex('A', a); U.tex('B', b); if (prev) U.tex('prev', prev); else U.tex('prev', a); U.i('hasPrev', prev ? 1 : 0); U.i('R', i === LA.length - 1 ? 4 : 1); });   // wide search on the smallest picture, then one pixel each way per level
      this.run('med', m, U => U.tex('F', f)); prev = m;
    }
    return prev;
  }
  // make the frame between a and b at time t (0..1) into dst; key names the pair, so the field is made only once per pair
  interp(dst, a, b, t, key) {
    if (!this.floatOk) return this.mix(dst, a, b, t);
    if (this.flowKey !== key) {
      const PA = this.pyramid('pa', a), PB = this.pyramid('pb', b);
      this.f01 = this.flowOne('ab', PA, PB); this.f10 = this.flowOne('ba', PB, PA); this.flowKey = key;
    }
    const k = a.w / this.f01.w, c = this.tmp('conf', this.f01.w, this.f01.h);
    this.run('conf', c, U => { U.tex('LA', this.scratch.get('pa0')); U.tex('LB', this.scratch.get('pb0')); U.tex('F01', this.f01); U.tex('F10', this.f10); U.f('t', t); });
    this.run('interp', dst, U => { U.tex('A', a); U.tex('B', b); U.tex('F01', this.f01); U.tex('F10', this.f10); U.tex('C', c); U.f('t', t); U.f('k', k); });
  }
  forget() { this.flowKey = null; }
  destroy() { for (const x of this.scratch.values()) this.free(x); this.scratch.clear(); const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
}
