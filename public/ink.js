// "Light ink": three stacked layers behind the app.
//  1. A GPU shader paints a slow, domain-warped aurora (violet, teal, magenta, amber) over ink black,
//     with faint contour lines like a topographic map of the colour field.
//  2. Iridescent calligraphic ribbons, after the Wareef box line-art, twist and fold in additive light.
//  3. Ink motes drift along a flow field and lean away from the pointer.
// Everything renders once and stops for viewers who prefer reduced motion.

const FRAG = `
precision mediump float;
uniform vec2 r; uniform float t; uniform vec2 m;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/r;
  vec2 p=(gl_FragCoord.xy-.5*r)/r.y+m*.06;
  float tt=t*.035;
  vec2 q=vec2(fbm(p*1.5+tt),fbm(p*1.5+vec2(5.2,1.3)-tt));
  vec2 w=vec2(fbm(p*1.5+3.*q+vec2(1.7,9.2)+tt*1.4),fbm(p*1.5+3.*q+vec2(8.3,2.8)-tt));
  float f=fbm(p*1.3+3.*w);
  vec3 c=vec3(.018,.014,.04);
  c=mix(c,vec3(.20,.08,.46),smoothstep(.25,.85,f));
  c=mix(c,vec3(.02,.62,.60),smoothstep(.5,.98,w.x)*.8);
  c=mix(c,vec3(.86,.20,.56),smoothstep(.58,1.,q.y)*.6);
  c=mix(c,vec3(1.,.66,.30),pow(smoothstep(.55,1.,f*w.y*1.7),2.)*.7);
  float line=abs(fract(f*10.-t*.02)-.5);
  c+=vec3(.85,.9,1.)*smoothstep(.035,0.,line)*.06;
  float v=smoothstep(1.3,.2,length((uv-vec2(.62,.6))*vec2(1.25,1.)));
  c*=mix(.28,1.,v);
  gl_FragColor=vec4(c*.62,1.);
}`;

const RIBBONS = [
  { y: 0.24, amp: 0.14, freq: 1.45, speed: 0.045, width: 84, phase: 0.0, twist: 1.25, alpha: 0.16, lines: 22, hue: 170 },
  { y: 0.62, amp: 0.2, freq: 1.0, speed: -0.03, width: 128, phase: 2.1, twist: 0.85, alpha: 0.11, lines: 26, hue: 270 },
  { y: 0.9, amp: 0.1, freq: 2.1, speed: 0.055, width: 56, phase: 4.2, twist: 1.7, alpha: 0.12, lines: 15, hue: 330 },
];

export function startInk() {
  if (document.getElementById('aurora')) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const aurora = document.createElement('canvas');
  aurora.id = 'aurora';
  const ink = document.createElement('canvas');
  ink.id = 'ink';
  for (const c of [ink, aurora]) { c.setAttribute('aria-hidden', 'true'); document.body.prepend(c); }

  const gl = aurora.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  const shader = gl && makeShader(gl);
  if (!shader) aurora.classList.add('fallback');
  const ctx = ink.getContext('2d');

  let W = 0;
  let H = 0;
  let mx = 0;
  let my = 0;
  let px = -1e4;
  let py = -1e4;
  let raf = 0;
  let last = 0;
  let motes = [];

  const resize = () => {
    W = innerWidth;
    H = innerHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    ink.width = W * dpr;
    ink.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The aurora is soft by nature: half resolution, upscaled by CSS.
    aurora.width = Math.ceil(W * 0.5);
    aurora.height = Math.ceil(H * 0.5);
    if (shader) gl.viewport(0, 0, aurora.width, aurora.height);
    const count = Math.round(Math.min(160, (W * H) / 9000));
    motes = Array.from({ length: count }, () => ({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, h: 160 + Math.random() * 200 }));
    if (still) draw(12, 0);
  };

  function draw(t, dt) {
    if (shader) {
      gl.uniform2f(shader.r, aurora.width, aurora.height);
      gl.uniform1f(shader.t, t);
      gl.uniform2f(shader.m, mx, -my);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const steps = W < 600 ? 50 : 90;
    for (const rb of RIBBONS) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      for (let s = 0; s <= 4; s++) grad.addColorStop(s / 4, `hsl(${(rb.hue + s * 55 + t * 12) % 360} 90% 72%)`);
      ctx.strokeStyle = grad;
      for (let i = 0; i < rb.lines; i++) {
        const k = i / (rb.lines - 1) - 0.5;
        ctx.beginPath();
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          const x = -0.1 * W + u * 1.2 * W + mx * 30;
          const th = u * rb.freq * Math.PI * 2 + t * rb.speed * 6 + rb.phase;
          const centre = H * (rb.y + my * 0.03) + Math.sin(th) * rb.amp * H + Math.sin(th * 0.5 + t * 0.2) * 30;
          const w = rb.width * Math.cos(u * rb.twist * Math.PI * 2 + t * rb.speed * 4 + rb.phase);
          const y = centre + k * w;
          if (s) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.globalAlpha = rb.alpha * (0.25 + Math.max(0, 1 - Math.abs(k) * 1.5) * 0.75);
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
    }
    // Ink motes on a slowly turning flow field; they part around the pointer.
    for (const p of motes) {
      const a = Math.sin(p.x * 0.004 + t * 0.15) * 2 + Math.cos(p.y * 0.005 - t * 0.1) * 2;
      p.x += Math.cos(a) * 0.35 * p.z * dt;
      p.y += Math.sin(a) * 0.35 * p.z * dt - 0.08 * dt;
      const dx = p.x - px;
      const dy = p.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 14400) { const f = (1 - d2 / 14400) * 2.2 * dt; const d = Math.sqrt(d2) || 1; p.x += (dx / d) * f; p.y += (dy / d) * f; }
      if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10; else if (p.y > H + 10) p.y = -10;
      ctx.globalAlpha = 0.25 + p.z * 0.45;
      ctx.fillStyle = `hsl(${(p.h + t * 8) % 360} 90% 78%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.6 + p.z * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;
    const dt = last ? Math.min(3, (now - last) / 33) : 1;
    last = now;
    draw(now / 1000, dt);
  }

  addEventListener('resize', resize);
  addEventListener('pointermove', (e) => { mx = e.clientX / W - 0.5; my = e.clientY / H - 0.5; px = e.clientX; py = e.clientY; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (still) return;
    cancelAnimationFrame(raf);
    last = 0;
    if (!document.hidden) raf = requestAnimationFrame(frame);
  });
  resize();
  if (!still) raf = requestAnimationFrame(frame);
}

function makeShader(gl) {
  try {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    return { r: gl.getUniformLocation(prog, 'r'), t: gl.getUniformLocation(prog, 't'), m: gl.getUniformLocation(prog, 'm') };
  } catch {
    return null;
  }
}
