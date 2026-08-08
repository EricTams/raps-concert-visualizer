// ---------------------------------------------------------------------------
// Minimal WebGL plumbing: context, programs, textures, framebuffers.
//
// Everything is written against GLSL ES 1.00, which both WebGL1 and WebGL2
// accept, so there is a single shader source path for both contexts.
// ---------------------------------------------------------------------------

export const VERTEX_SHADER = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/** Straight copy of one texture to the bound target. */
export const COPY_FRAGMENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_src;
void main() { gl_FragColor = vec4(texture2D(u_src, v_uv).rgb, 1.0); }
`;

export function createContext(canvas) {
  const opts = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) throw new Error('WebGL is not available in this browser.');
  return gl;
}

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`Failed to compile ${kind} shader:\n${log}`);
  }
  return sh;
}

/**
 * A linked program with lazily-cached uniform locations.
 */
export class Program {
  constructor(gl, fragmentSource, name = 'program') {
    this.gl = gl;
    this.name = name;
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`Failed to link ${name}:\n${log}`);
    }
    this.program = p;
    this._locs = new Map();
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  loc(name) {
    if (!this._locs.has(name)) {
      this._locs.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this._locs.get(name);
  }

  f(name, v)        { const l = this.loc(name); if (l) this.gl.uniform1f(l, v); return this; }
  v2(name, x, y)    { const l = this.loc(name); if (l) this.gl.uniform2f(l, x, y); return this; }
  v3(name, x, y, z) { const l = this.loc(name); if (l) this.gl.uniform3f(l, x, y, z); return this; }
  v4(name, x, y, z, w) { const l = this.loc(name); if (l) this.gl.uniform4f(l, x, y, z, w); return this; }
  i(name, v)        { const l = this.loc(name); if (l) this.gl.uniform1i(l, v); return this; }

  /** Bind a texture to a unit and point the named sampler at it. */
  tex(name, texture, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.i(name, unit);
    return this;
  }

  destroy() {
    this.gl.deleteProgram(this.program);
    this._locs.clear();
  }
}

/** A fullscreen triangle — cheaper and seam-free compared to two triangles. */
export function createScreenQuad(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return buf;
}

export function draw(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/**
 * Upload an ImageBitmap/HTMLImageElement as a clamped, linear-filtered texture.
 * No mipmaps: the sources are non-power-of-two, and every effect samples at
 * roughly 1:1 or magnified, so mips would only cost memory.
 */
export function createTexture(gl, source) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return tex;
}

/** An offscreen color target. Reused across frames; only resized on demand. */
export class Framebuffer {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = 0;
    this.height = 0;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.resize(width, height);
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  destroy() {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.texture);
  }
}

export function bindScreen(gl, width, height) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
}
