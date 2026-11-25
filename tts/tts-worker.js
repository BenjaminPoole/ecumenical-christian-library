// Supertonic 3 text-to-speech in a module worker, so inference never blocks scrolling or the highlight.
// Port of the inference loop in Supertone's own web demo (huggingface.co/spaces/Supertone/supertonic-3, script.js).
// In:  {type:'init', base, voice}  {type:'voice', voice}
//      {type:'synth', id, epoch, text, steps, speed, bg}   bg = MP3 export: runs only when no playback job waits
//      {type:'epoch', epoch}   drops queued playback jobs from older epochs (a seek, or a changed setting)
//      {type:'cancel-bg'}      drops queued export jobs
// Out: {type:'progress', phase:'download'|'prepare', done, total}  {type:'ready', backend}
//      {type:'step', id, frac}   how far the sentence being made has got (0..1), for the progress ring
//      {type:'audio', id, epoch, bg, pcm, rate, ms}   {type:'error', id?, bg?, message}
// Everything that runs (this, onnxruntime, its .wasm) is served with the site. Only the model, which is data, comes from
// elsewhere, at a fixed revision. Its address redirects to one that changes, so the browser's own cache would miss: it is
// kept in Cache Storage instead, and downloaded once.
const MODEL = 'https://huggingface.co/danyalmalik/Supertonic-3-ONNX-WebGPU/resolve/aed039b76a7472220e9d89f3ef537f7e2ff077a7';
const STORE = 'read-aloud-model-aed039b7';
const SIZES = { 'onnx/duration_predictor.onnx': 1058573, 'onnx/text_encoder.onnx': 9518425, 'onnx/vector_estimator.onnx': 70634099, 'onnx/vocoder.onnx': 28762717 };
const store = () => caches.open(STORE).catch(() => null);
const getModel = async (path) => await (await store())?.match(`${MODEL}/${path}`) ||
  fetch(`${MODEL}/${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
const keep = async (path, body) => { try { await (await store()).put(`${MODEL}/${path}`, new Response(body)); } catch {} };
async function modelJson(path) {
  const r = await getModel(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  const text = await r.text();
  keep(path, text);
  return JSON.parse(text);
}

let ort, cfg, indexer, sessions, style, base, backend, modelBufs, switchTo = null;

// Firefox only notices finished GPU work when it polls the device: on a 100 ms timer, or when work is submitted
// (bugzilla.mozilla.org 1870699, 2008103). onnxruntime reads results back ~176 times a sentence (operators it runs
// on the CPU need their inputs), so each sentence waited ~17 s. While a readback is pending we submit empty work,
// which makes Firefox poll at once: 17 s became ~1.5 s. In Chrome readbacks resolve at once and this barely runs.
let gpuDevice = null, waitingMaps = 0, pumping = false;
function pumpLoop() {
  if (!gpuDevice || waitingMaps === 0) { pumping = false; return; }
  gpuDevice.queue.submit([]);
  setTimeout(pumpLoop, 0);
}
if (self.GPUBuffer) {
  const mapAsync = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function (...args) {
    waitingMaps++;
    if (gpuDevice && !pumping) { pumping = true; setTimeout(pumpLoop, 0); }
    return mapAsync.apply(this, args).finally(() => { waitingMaps--; });
  };
}

async function make(ep, quiet = false) {
  const opts = { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const s = [];
  for (const b of modelBufs) { // WebGPU: one session at a time
    if (!quiet) post({ type: 'progress', phase: 'prepare', done: s.length, total: modelBufs.length });
    s.push(await ort.InferenceSession.create(b, opts));
  }
  if (!quiet) post({ type: 'progress', phase: 'prepare', done: s.length, total: modelBufs.length });
  return { dp: s[0], enc: s[1], vec: s[2], voc: s[3] };
}
let epoch = 0;
const fg = [], bgq = [];
let busy = false;
let voicing = null; // a new voice being fetched: sentences wait for it

const post = (m, t) => self.postMessage(m, t || []);

async function fetchAll(urls, onBytes) {
  return Promise.all(urls.map(async (u) => {
    const ofModel = u in SIZES;
    const r = ofModel ? await getModel(u) : await fetch(u);
    if (!r.ok) throw new Error(`${r.status} ${u}`);
    onBytes(0, SIZES[u] || Number(r.headers.get('Content-Length')) || 0);
    const reader = r.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length; onBytes(value.length, 0);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    if (ofModel) keep(u, out.slice());
    return out;
  }));
}

async function loadVoice(name) {
  const j = await modelJson(`voice_styles/${name}.json`);
  const t = (s) => new ort.Tensor(s.type || 'float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
  style = { ttl: t(j.style_ttl), dp: t(j.style_dp) };
}

async function init(msg) {
  base = msg.base;
  ort = await import(`${base}/ort/ort.webgpu.min.mjs`);
  ort.env.logLevel = 'error';
  ort.env.wasm.wasmPaths = `${base}/ort/`;
  ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages cannot give
  const names = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
  let done = 0, total = 0, last = 0;
  const tick = (d, t) => {
    done += d; total += t;
    const now = performance.now();
    if (now - last > 80 || done === total) { last = now; post({ type: 'progress', phase: 'download', done, total }); }
  };
  // The runtime's own .wasm (25 MB) is fetched here too, so the progress bar covers everything that is downloaded.
  const [cfgJson, idx, bufs] = await Promise.all([
    modelJson('onnx/tts.json'),
    modelJson('onnx/unicode_indexer.json'),
    fetchAll([...names.map((n) => `onnx/${n}.onnx`), `${base}/ort/ort-wasm-simd-threaded.asyncify.wasm.gz`], tick),
  ]);
  // (gzipped, to keep the site under GitHub Pages' 1 GB)
  ort.env.wasm.wasmBinary = await new Response(new Blob([bufs.pop()]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  modelBufs = bufs;
  cfg = cfgJson; indexer = idx;
  // WebGPU where it exists; the main thread asks for WASM (msg.ep) only to test, and switches later (a 'backend'
  // message) if the graphics card proves slower than real time.
  // Not done, on purpose: making the first sentences on the CPU while the GPU compiles its shaders. Tried in Firefox
  // (sub-worker with its own onnxruntime): the shader compile and the CPU inference compete for the same cores, so
  // the first sound came later (16 s, against 13 s without).
  backend = 'wasm';
  if (self.navigator.gpu && msg.ep !== 'wasm') {
    try {
      sessions = await make('webgpu'); backend = 'webgpu';
      if (msg.pump !== false) gpuDevice = await ort.env.webgpu.device; // (msg.pump: a prototype test switch)
    } catch (e) { console.warn('WebGPU failed, using WASM', e); }
  }
  if (!sessions) sessions = await make('wasm');
  await loadVoice(msg.voice);
  post({ type: 'ready', backend });
}

// ---- text, as Supertone's preprocessText (English only) ----
function preprocess(text) {
  text = text.normalize('NFKD');
  const rep = { '–': '-', '‑': '-', '—': ', ', '_': ' ', '“': '"', '”': '"', '‘': "'", '’': "'",
    '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ' };
  for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
  text = text.replace(/[♥☆♡©\\]/g, '').replace('@', ' at ').replaceAll('e.g.,', 'for example,').replaceAll('i.e.,', 'that is,');
  text = text.replace(/ ([,.!?;:'])/g, '$1').replace(/""+/g, '"').replace(/''+/g, "'").replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.';
  return `<en>${text}</en>`;
}

function ids(text) {
  const out = [];
  for (const ch of preprocess(text)) {
    const v = indexer[ch.charCodeAt(0)];
    if (v !== undefined && v !== null && v !== -1) out.push(v); // unsupported characters are dropped, not zeroed
  }
  return out;
}

function gauss(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = 1 - Math.random(), v = Math.random(), r = Math.sqrt(-2 * Math.log(u));
    a[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return a;
}

// await onStep(frac) reports real progress: the duration and text passes, each denoising step, then the vocoder.
async function synth(text, steps, speed, onStep = () => {}, S = sessions) {
  const stages = steps + 3;
  const t = ids(text);
  const L = t.length;
  const textIds = new ort.Tensor('int64', BigInt64Array.from(t, BigInt), [1, L]);
  const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  const { duration } = await S.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  await onStep(1 / stages);
  const dur = duration.data[0] / (speed + 0.05); // the demo's speedToDurationFactor
  const { text_emb } = await S.enc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
  await onStep(2 / stages);

  const rate = cfg.ae.sample_rate;
  const chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const wavLen = Math.floor(dur * rate);
  const T = Math.max(1, Math.ceil(wavLen / chunk));
  const D = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  let latent = gauss(D * T);
  const shape = [1, D, T];
  const latentMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
  const total = new ort.Tensor('float32', new Float32Array([steps]), [1]);
  for (let s = 0; s < steps; s++) {
    const r = await S.vec.run({
      noisy_latent: new ort.Tensor('float32', latent, shape), text_emb, style_ttl: style.ttl, text_mask: textMask,
      latent_mask: latentMask, total_step: total, current_step: new ort.Tensor('float32', new Float32Array([s]), [1]),
    });
    latent = new Float32Array(r.denoised_latent.data);
    await onStep((3 + s) / stages);
  }
  const { wav_tts } = await S.voc.run({ latent: new ort.Tensor('float32', latent, shape) });
  await onStep(1);
  return { pcm: wav_tts.data.slice(0, wavLen), rate };
}

const DROPPED = new Error('no longer wanted');
let yielded = null;
const yielder = new MessageChannel();
yielder.port1.onmessage = () => yielded();

async function pump() {
  if (busy) return;
  busy = true;
  for (;;) {
    if (switchTo && switchTo !== backend) { // between sentences: rebuild the sessions on the other backend
      const old = sessions;
      sessions = await make(switchTo, true);
      backend = switchTo;
      for (const s of Object.values(old)) s.release?.();
      post({ type: 'backend', backend });
    }
    switchTo = null;
    const job = fg.length ? fg.shift() : bgq.shift(); // playback always goes first
    if (!job) break;
    if (!job.bg && job.epoch < epoch) continue;
    try {
      await voicing;
      const S = sessions;
      const on = backend;
      const t0 = performance.now();
      let lastStep = 0;
      const slow = job.slow > 1 ? job.slow : 1; // prototype test switch: pretend to be a slower device
      let lastT = t0;
      const { pcm, rate } = await synth(job.text, job.steps, job.speed, async (frac) => {
        // A jump: let its message in (single-threaded WASM never yields by itself), and drop this sentence if it is
        // no longer wanted, or put an MP3 sentence back while the one jumped to is made.
        await new Promise((r) => { yielded = r; yielder.port2.postMessage(0); });
        if (frac < 1 && (job.bg ? fg.some((j) => j.urgent) : job.epoch < epoch)) throw DROPPED;
        if (slow > 1) { const now = performance.now(); await new Promise((r) => setTimeout(r, (now - lastT) * (slow - 1))); lastT = performance.now(); }
        const now = performance.now();
        if (frac === 1 || now - lastStep > 30) { lastStep = now; post({ type: 'step', id: job.id, bg: !!job.bg, frac }); }
      }, S);
      if (!job.bg && job.epoch < epoch) continue;
      post({ type: 'audio', id: job.id, epoch: job.epoch, bg: !!job.bg, steps: job.steps, pcm, rate, ms: performance.now() - t0, on }, [pcm.buffer]);
    } catch (e) {
      if (e === DROPPED) { if (job.bg) bgq.unshift(job); continue; }
      post({ type: 'error', id: job.id, epoch: job.epoch, bg: !!job.bg, message: String(e?.message || e) });
    }
  }
  busy = false;
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'voice') await (voicing = loadVoice(m.voice));
    else if (m.type === 'epoch') { epoch = m.epoch; for (let i = fg.length - 1; i >= 0; i--) if (fg[i].epoch < epoch) fg.splice(i, 1); }
    else if (m.type === 'cancel-bg') bgq.length = 0;
    else if (m.type === 'backend') { switchTo = m.ep; pump(); }
    else if (m.type === 'synth') {
      if (m.bg) bgq.push(m);
      else { epoch = Math.max(epoch, m.epoch); fg.push(m); }
      pump();
    }
  } catch (e) {
    post({ type: 'error', message: String(e?.message || e) });
  }
};
