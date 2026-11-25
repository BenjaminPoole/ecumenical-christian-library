// Read aloud: loaded only when the reader presses "Listen". Nothing here, nor the runtime or the model, is fetched
// with the page. The worker (tts-worker.js) owns onnxruntime-web and the Supertonic 3 model; mp3/ is loaded only
// for an MP3 export.
const BASE = new URL('.', import.meta.url).href.replace(/\/$/, '');
const VOICES = [
  ['M2', 'James'], ['M1', 'Alex'], ['M3', 'Robert'], ['M4', 'Sam'], ['M5', 'Daniel'],
  ['F1', 'Sarah'], ['F2', 'Lily'], ['F3', 'Jessica'], ['F4', 'Olivia'], ['F5', 'Emily'],
];
const AHEAD_SECONDS = 60; // keep about a minute of speech made ahead of the listener...
const AHEAD_MAX = 12;     // ...but never more than this many sentences
const AUTO_MIN = 4, AUTO_MAX = 16; // the slider's own range: below 4 the AI sounds worse than the browser's voice
const MP3_KBPS = 64;
const CHARS_PER_SECOND = 14.5; // James at 1.0x, measured; used only for estimates

const store = {
  get(k, d) { try { const v = localStorage.getItem('tts-' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tts-' + k, JSON.stringify(v)); } catch {} },
};
const settings = {
  voice: store.get('voice-2', 'M2'), speed: store.get('speed', 1), steps: Math.max(AUTO_MIN, store.get('steps', 4)), auto: store.get('auto', true),
};
const AUTO_START = 4;
// The quality in use: with auto on, every session starts at 4 and moves from there; with it off, the slider's value.
let q = settings.auto ? AUTO_START : settings.steps;

// ---------------------------------------------------------------- text: blocks, sentences, ranges
const BLOCK = 'p, li, dd, dt, blockquote, figcaption, td, th';
const SKIP = 'h1, h2, h3, h4, h5, h6, section[data-footnotes], .note-continues, .note-part-nav, pre, code, sup, ' +
  '.katex, script, style, svg, button, [aria-hidden="true"], a[role="anchor"], .tts-ui, [hidden]';
// Numbers the page shows for reference but that are no use read out: "(11)", "[3]", "§ 4." at a paragraph's start,
// "(12)" / "[12]" inside it.
const LEAD_NUM = /^\s*(?:\(\d{1,4}\)|\[\d{1,4}\]|§+\s*\d+\.?|\d{1,4}\.(?=\s))\s*/;
const INLINE_NUM = /\s?(?:\(\d{1,4}\)|\[\d{1,4}\])(?=\s|$|[,.;:])/g;
const ABBREV = /(?:^|[\s(])(?:[A-Z]|St|Sts|Mr|Mrs|Dr|cf|Cf|ch|Ch|chap|vol|Vol|p|pp|ver|vv|viz|No|Bk|lib|c|ca|ibid|op|cit|etc|Rev|Gen|Ex|Lev|Num|Deut|Matt|Ps|Prov|Isa|Jer|Ezek|Dan|Rom|Cor|Gal|Eph|Phil|Col|Thess|Tim|Heb|Jas|Pet)\.$/;

let root = null, pageRoot = null;
const moreToCome = () => [...document.querySelectorAll('.note-continues')].find((h) => !h.closest('.popover')); // the rest is still to come
// A very long book keeps only the text near the screen on the page (split-long-pages.js): the chunk being read and the
// one after it are held there, wherever the reader has scrolled to.
const W = () => window.__noteChunks;
const windowed = () => !!W()?.windowed();
let held = [];
const chunkOf = (el) => { const c = el?.closest('.note-chunk'); return c && W()?.has(c) ? c : null; };
function chunkAfter(c, dir = 1) {
  let n = c ? (dir > 0 ? c.nextElementSibling : c.previousElementSibling) : dir > 0 ? root.querySelector('.note-chunk') : null;
  return n && W().has(n) ? n : null;
}
function keepHeld(want) {
  const fresh = want.filter((d) => !held.includes(d)), gone = held.filter((d) => !want.includes(d));
  held = want;
  fresh.forEach((d) => W().hold(d));
  gone.forEach((d) => W().release(d));
  if (fresh.length || gone.length) refresh();
}
function holdChunks() {
  if (!windowed() || !segs[cur]) return;
  const c = chunkOf(segs[cur].rec.el);
  keepHeld([c, chunkAfter(c)].filter(Boolean));
}
function extendWindow() { // past the last sentence on the page: is there another chunk with one?
  if (!windowed()) return false;
  const before = segs.length;
  for (let c = chunkAfter(held.at(-1) || null); c; c = chunkAfter(c)) {
    keepHeld([...held.slice(-1), c]);
    if (segs.length > before) return true;
    if (cur < segs.length) return true;
  }
  return false;
}
function reachHeadings(dir) { // the chapters either side of this one may be off the page
  if (!windowed()) return;
  const want = [...held];
  let found = 0;
  for (let c = chunkAfter(chunkOf(segs[cur]?.rec.el), dir); c && found < (dir > 0 ? 1 : 2); c = chunkAfter(c, dir)) {
    if (!/<h[2-4]\b/.test(W().html(c))) continue;
    found++;
    want.push(c, chunkAfter(c));
  }
  keepHeld([...new Set(want.filter(Boolean))]);
}
// Every sentence of the text, whether or not it is on the page.
function wholeText() {
  if (!windowed()) return segs;
  const out = [];
  for (const el of root.children) {
    out.push(...collect(W().has(el) ? new DOMParser().parseFromString(W().html(el), 'text/html').body : el));
  }
  return out;
}
let segs = [];
const blockIds = new WeakMap();
let nextBlockId = 1;
const nodeBlock = new WeakMap(); // text node -> block record (for click-to-read)

function collect(root = pageRoot) {
  const blocks = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n; (n = walker.nextNode());) {
    const b = n.parentElement.closest(BLOCK);
    if (!b || !root.contains(b)) continue;
    let rec = blocks.get(b);
    if (!rec) {
      if (!blockIds.has(b)) blockIds.set(b, nextBlockId++);
      rec = { el: b, id: blockIds.get(b), text: '', nodes: [] };
      blocks.set(b, rec);
    }
    rec.nodes.push({ node: n, start: rec.text.length });
    rec.text += n.data;
    nodeBlock.set(n, rec);
  }
  const out = [];
  for (const rec of blocks.values()) out.push(...sentences(rec));
  return out;
}

function sentences(rec) {
  const t = rec.text;
  // characters not spoken (reference numbers); they stay highlighted with their sentence
  const muted = new Uint8Array(t.length);
  const lead = t.match(LEAD_NUM);
  if (lead) muted.fill(1, 0, lead[0].length);
  for (const m of t.matchAll(INLINE_NUM)) muted.fill(1, m.index, m.index + m[0].length);

  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  const parts = [...seg.segment(t)].map((s) => [s.index, s.index + s.segment.length]);
  // the segmenter breaks after "St." and "C. S." — join those back up
  const joined = [];
  for (const p of parts) {
    const prev = joined[joined.length - 1];
    if (prev && ABBREV.test(t.slice(prev[0], prev[1]).trimEnd())) prev[1] = p[1];
    else joined.push(p);
  }
  // very short pieces ride with the next one; very long ones are split at a pause
  const spoken = (a, b) => { let s = ''; for (let i = a; i < b; i++) if (!muted[i]) s += t[i]; return s.replace(/\s+/g, ' ').trim(); };
  const merged = [];
  for (const p of joined) {
    const prev = merged[merged.length - 1];
    if (prev && spoken(prev[0], prev[1]).length < 24 && spoken(prev[0], p[1]).length < 320) prev[1] = p[1];
    else merged.push(p);
  }
  const final = [];
  const split = (a, b) => {
    if (spoken(a, b).length <= 320) return final.push([a, b]);
    const mid = (a + b) / 2;
    let best = -1;
    for (const re of [/[;:]\s/g, /,\s/g, /\s/g]) {
      for (const m of t.slice(a, b).matchAll(re)) {
        const at = a + m.index + 1;
        if (at - a < 60 || b - at < 60) continue;
        if (best < 0 || Math.abs(at - mid) < Math.abs(best - mid)) best = at;
      }
      if (best > 0) break;
    }
    if (best < 0) return final.push([a, b]);
    split(a, best); split(best, b);
  };
  for (const [a, b] of merged) split(a, b);

  const out = [];
  for (let [a, b] of final) {
    while (a < b && /\s/.test(t[a])) a++;
    while (b > a && /\s/.test(t[b - 1])) b--;
    const text = spoken(a, b);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    out.push({ rec, a, b, text, muted, key: rec.id + ':' + a });
  }
  return out;
}

function pointAt(rec, off) {
  const ns = rec.nodes;
  let lo = 0, hi = ns.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ns[m].start <= off) lo = m; else hi = m - 1; }
  const n = ns[lo];
  return [n.node, Math.min(off - n.start, n.node.length)];
}
function rangeOf(rec, a, b) {
  const r = new Range();
  r.setStart(...pointAt(rec, a));
  r.setEnd(...pointAt(rec, b));
  return r;
}
function words(s) {
  const t = s.rec.text, out = [];
  const re = /\S+/g;
  re.lastIndex = s.a;
  let total = 0;
  for (let m; (m = re.exec(t)) && m.index < s.b;) {
    const w = m[0];
    if (/^(?:\(\d+\)|\[\d+\])[,.;:]?$/.test(w)) continue; // muted reference numbers take no time
    let weight = w.length + 1;
    if (/[,;:]$/.test(w)) weight += 3; else if (/[.!?]["”’)]*$/.test(w)) weight += 5;
    out.push({ a: m.index, b: Math.min(m.index + w.length, s.b), at: total, weight });
    total += weight;
  }
  for (const w of out) { w.at /= total; w.end = w.at + w.weight / total; }
  return out;
}
function headingBefore(el) {
  for (let c = chunkOf(el), first = true; c; c = chunkAfter(c, -1), first = false) { // a windowed book: chunk by chunk back
    if (first) {
      const hs = [...c.querySelectorAll('h2, h3, h4')].filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (hs.length) return hs.at(-1).textContent.trim();
    } else {
      const h = [...W().html(c).matchAll(/<h[2-4]\b[^>]*>(.*?)<\/h[2-4]>/gs)].at(-1);
      if (h) return new DOMParser().parseFromString(h[1], 'text/html').body.textContent.trim();
    }
  }
  let last = null;
  for (const h of root.querySelectorAll('h2, h3, h4')) if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = h; else break;
  return last ? last.textContent.trim() : document.querySelector('.article-title')?.textContent.trim() || '';
}
// Asked to go faster the model swallows words of short sentences (at 1.6x); past 1.2x what it makes is stretched the rest of the way (atSpeed).
const synthSpeed = () => Math.min(1.2, settings.speed);
const secsNow = (b) => b.duration * (b.speed + 0.05) / (settings.speed + 0.05); // how long it will take at the speed now set
let cps = CHARS_PER_SECOND; // learned from the sentences made
const estSeconds = (s) => s.text.length / cps / settings.speed;

// ---------------------------------------------------------------- highlight (CSS Custom Highlight API: no DOM changes)
const HL = typeof CSS !== 'undefined' && CSS.highlights;
const hl = { sentence: HL ? new Highlight() : null, word: HL ? new Highlight() : null, hover: HL ? new Highlight() : null };
if (HL) { CSS.highlights.set('tts-sentence', hl.sentence); CSS.highlights.set('tts-word', hl.word); CSS.highlights.set('tts-hover', hl.hover); }
const setHL = (h, r) => { if (!h) return; h.clear(); if (r) h.add(r); };

// ---------------------------------------------------------------- the browser's own voices (an experiment)
// Chosen as a voice like any other ("b:" + its voiceURI; plain "b:" is the browser's default). No model is loaded and
// nothing is made ahead: each sentence is handed to speechSynthesis. The browser gives no audio, so no MP3 and no quality.
const SS = window.speechSynthesis;
const isB = () => settings.voice.startsWith('b:');
const bVoices = () => {
  const all = SS ? SS.getVoices() : [], en = all.filter((v) => /^en/i.test(v.lang));
  return en.length ? en : all;
};
// "Browser default" is Microsoft David where the device has him, otherwise whatever the browser picks.
const bVoice = () => bVoices().find((v) => 'b:' + v.voiceURI === settings.voice) || bVoices().find((v) => /^(Microsoft )?David\b/.test(v.name));
const bName = (v) => v.name.replace(/^Microsoft /, '').replace(/ - English.*$/, '') + ` (${v.lang}${v.localService ? '' : ', online'})`;
let bUtter = null, bKey = '', bFrom = 0, bRaf = 0, bTimer = 0, bCps = CHARS_PER_SECOND;
// With an AI voice, the sentence jumped to is spoken by the browser's voice, which starts at once, while the AI makes
// the next one. The same at the start, while the AI voice loads: the browser reads on, sentence after sentence, until
// the AI has the next one ready. bridge: the key of the sentence the browser is speaking; bridgeOn: until the AI takes over.
let bridge = '', bridgeOn = false, loadText = '', loadFrac = 0; // loadFrac: real progress of the stage the AI voice is at
const bridgeLeft = () => bridge ? (segs[cur].b - (bKey === bridge ? bFrom : segs[cur].a)) / bCps / settings.speed : 0;
function bStop() {
  clearTimeout(bTimer); clearTimeout(tailTimer); cancelAnimationFrame(bRaf);
  if (!bUtter) return;
  bUtter = null;
  SS.cancel();
}
// ---- handing over inside the sentence
// While the browser speaks a sentence, the AI makes the rest of it from a word the browser will reach once that is ready:
// after a comma or the like if one comes soon, else where a phrase begins, else any word. The browser says when it
// reaches each word, so it is stopped there and the AI goes on from exactly that word. (Making the whole sentence and
// cutting into it would mean guessing where the words are in the sound: some would be said twice, or not at all.)
let tail = null, tailTimer = 0, tailTries = 0, tellsWords = true; // tellsWords: whether the voice reports its words
const PHRASE = /^["“‘(]?(?:and|but|or|nor|for|that|which|who|whom|whose|when|where|while|because|since|if|as|than|so|yet|in|of|to|by|with|from|into|through|upon|on|at|after|before|without|not)$/i;
const tailNow = () => tail && tail.epoch === epoch && tail.key === bridge ? tail : null;
function planTail() {
  if (!bridge || !bUtter || !tellsWords || !model.n || tailNow() || tailTries > 2) return false;
  const s = segs[cur], steps = settings.auto ? START : settings.steps, here = Math.max(0, wordIdx);
  const pace = bCps * settings.speed, at = (i) => (segWords[i].a - bFrom) / pace;
  let first = -1, soft = -1, hard = -1;
  for (let i = here + 2; i < segWords.length && s.b - segWords[i].a >= 20; i++) {
    const when = at(i), make = cost((s.b - segWords[i].a) / cps / settings.speed, steps) * model.err + 0.25;
    if (when < make) continue;
    if (first < 0) first = i;
    if (when - at(first) > 2.5) break;
    const before = s.rec.text.slice(segWords[i - 1].a, segWords[i - 1].b), word = s.rec.text.slice(segWords[i].a, segWords[i].b);
    if (hard < 0 && /[,;:.!?—–][”"’)]*$/.test(before)) hard = i;
    if (soft < 0 && PHRASE.test(word)) soft = i;
  }
  const w = hard >= 0 ? hard : soft >= 0 ? soft : first;
  if (w < 0) return false;
  // not at the cost of the sentence after
  const secs = (s.b - segWords[w].a) / cps / settings.speed;
  if (!sustains(cur + 1, bridgeLeft(), cost(secs, steps))) return false;
  let text = '';
  for (let i = segWords[w].a; i < s.b; i++) if (!s.muted[i]) text += s.rec.text[i];
  tailTries++;
  tail = { id: s.key + '@' + segWords[w].a, key: s.key, epoch, w, pause: w === hard, buf: null };
  pending.add(tail.id);
  worker.postMessage({ type: 'synth', id: tail.id, epoch, text: text.replace(/\s+/g, ' ').trim(), steps, urgent: true, speed: synthSpeed(), slow: window.__ttsSlow || 1 });
  return true;
}
function tailAt(i) { // the browser has begun word i
  const x = tailNow();
  if (!x) return;
  if (i >= x.w) {
    if (x.buf && i === x.w) return handOver(x);
    // too late for that word: give it up and choose a later one
    if (!x.buf) { pending.delete(x.id); dropWork(); model.err = Math.min(1.6, model.err * 1.1); }
    tail = null;
    return ensureAhead();
  }
  // in the pause before it, rather than when the word has begun to sound
  if (i === x.w - 1 && x.buf && x.pause) {
    const word = segWords[i], u = bUtter;
    clearTimeout(tailTimer);
    tailTimer = setTimeout(() => { if (u === bUtter && tailNow() === x) handOver(x); }, ((word.b - word.a) / (bCps * 1.25) / settings.speed + 0.12) * 1000);
  }
}
function handOver(x) {
  if (settings.auto && !sustains(cur + 1, x.buf.duration, 0)) { tail = null; return; } // it could not go on: the browser does
  const s = segs[cur], d = x.buf.getChannelData(0);
  bStop();
  bridge = bKey = ''; bridgeOn = false; tail = null;
  log.push({ handOver: x.id, word: x.w, of: segWords.length, pause: x.pause });
  segWords = words({ rec: s.rec, a: segWords[x.w].a, b: s.b });
  wordIdx = -1;
  let i = 0;
  while (i < d.length / 4 && Math.abs(d[i]) < 0.015) i++; // its opening silence is not waited for
  startSource(s, x.buf, Math.max(0, i / x.buf.sampleRate - 0.02));
  setState('playing');
  tick();
  ensureAhead();
}
function bMark(off) { // off: a place in the block's text
  const i = segWords.findIndex((w) => off < w.b);
  if (i < 0 || i === wordIdx) return;
  wordIdx = i;
  bFrom = segWords[i].a;
  setHL(hl.word, rangeOf(segs[cur].rec, segWords[i].a, segWords[i].b));
  return i;
}
// Speaks the sentence from bFrom, so a pause (which browsers do unreliably) or a new speed restarts at the word reached.
function bSpeak(s) {
  bStop();
  if (bKey !== s.key) { bKey = s.key; bFrom = s.a; }
  const v = bVoice();
  // what is said, and where each character of it is on the page
  const max = v && !v.localService ? 180 : Infinity; // Chrome cuts its online voices off after about 15 s
  const t = s.rec.text, map = [];
  let say = '', i = bFrom;
  for (; i < s.b; i++) {
    const space = /\s/.test(t[i]);
    if (space && say.length > max) break;
    if (s.muted[i] || (space && (!say || say.endsWith(' ')))) continue;
    say += space ? ' ' : t[i]; map.push(i);
  }
  const end = i;
  const done = () => {
    if (end < s.b) { bFrom = end; return bSpeak(s); }
    const next = segs[cur + 1];
    if (!isB()) cache.delete(s.key);
    cur++; bKey = bridge = '';
    gapTimer = setTimeout(() => playCurrent(true), (next && next.rec !== s.rec ? 175 : 0) / settings.speed ** 1.5);
  };
  setState('playing');
  if (!say.trim()) return done();
  const u = new SpeechSynthesisUtterance(say);
  if (v) u.voice = v;
  u.lang = v?.lang || 'en';
  u.rate = settings.speed;
  // Microsoft David is 4.65 dB louder than the AI voices. Windows takes 0.25 dB off for each 1% of volume (measured).
  u.volume = 0.81;
  bUtter = u; // (also keeps it from being garbage-collected, which would lose its events)
  let t0 = 0, bounds = 0;
  const fail = (why) => {
    bStop();
    if (bridge) { bridge = ''; bridgeOn = false; return playCurrent(); } // the AI makes this one after all
    setState('paused'); ui.flash('The browser voice stopped: ' + why, 'warn', 0); };
  u.onstart = () => {
    if (u !== bUtter) return;
    clearTimeout(bTimer);
    t0 = performance.now();
    log.push({ br: cur, t: Math.round(t0), err: +model.err.toFixed(2), waiting: [...pending].join() });
    log.push({ browser: v?.name || 'default', local: v?.localService, startMs: Math.round(t0 - asked) });
    ui.status();
    const guess = () => { // voices that do not report words: estimate, from the pace of the sentences before
      if (u !== bUtter) return;
      const ms = performance.now() - t0;
      if (!bounds && ms > 700) bMark(map[Math.min(map.length - 1, Math.floor(ms / 1000 * bCps * settings.speed))]);
      bRaf = requestAnimationFrame(guess);
    };
    guess();
  };
  u.onboundary = (e) => { if (u === bUtter && e.name !== 'sentence' && e.charIndex < map.length) { bounds++; tellsWords = true; const w = bMark(map[e.charIndex]); if (w >= 0 && bridge) tailAt(w); } };
  u.onend = () => {
    if (u !== bUtter) return;
    clearTimeout(bTimer); cancelAnimationFrame(bRaf);
    bUtter = null;
    const secs = (performance.now() - t0) / 1000;
    if (t0 && secs > 1) bCps = bCps * 0.6 + say.length / secs / settings.speed * 0.4;
    if (!bounds && say.length > 30) tellsWords = false;
    log.push({ browserSaid: say.length, seconds: secs, bounds });
    if (state === 'playing') done();
  };
  u.onerror = (e) => { if (u === bUtter) fail(e.error || 'unknown error'); };
  const asked = performance.now();
  bTimer = setTimeout(() => { // a moment after cancel(), or some browsers lose the new one
    if (u !== bUtter) return;
    SS.resume();
    SS.speak(u);
    bTimer = setTimeout(() => { if (u === bUtter && !t0) fail('it did not start'); }, bridge ? 2000 : 8000);
  }, 30);
}
addEventListener('pagehide', bStop);

// ---------------------------------------------------------------- engine (worker) and audio
let worker, ready, ctx, backend = '';
let engineReady = false;
const cache = new Map(); // key -> AudioBuffer
const pending = new Set();
let epoch = 0;
let curFrac = 0; // how far the sentence now playing-or-awaited has got in the worker

function startEngine() {
  if (ready) return ready;
  worker = new Worker(`${BASE}/tts-worker.js`, { type: 'module' });
  const firstVoice = settings.voice;
  ready = new Promise((resolve, reject) => {
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') isB() || ui.loading(m.phase, m.done, m.total);
      else if (m.type === 'ready') { backend = m.backend; engineReady = true; if (!isB() && settings.voice !== firstVoice) worker.postMessage({ type: 'voice', voice: settings.voice }); resolve(); }
      else if (m.type === 'step') onStep(m);
      else if (m.type === 'backend') { backend = m.backend; ui.status(); }
      else if (m.type === 'warm') log.push({ warm: m.ms, bridged: m.bridged, at: performance.now() });
      else if (m.type === 'audio') (m.bg ? onExportAudio(m) : onAudio(m));
      else if (m.type === 'error') {
        if (m.bg) onExportAudio({ ...m, pcm: new Float32Array(0), rate: 44100 });
        else if (m.id) { pending.delete(m.id); console.warn('read aloud: skipped a sentence:', m.message); skipBroken(m.id); }
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || 'worker failed'));
  });
  // WebGPU wherever it exists (Firefox included, with the poll pump in the worker); adapt() moves to WASM if the
  // graphics card turns out slower than real time.
  worker.postMessage({ type: 'init', base: BASE, voice: settings.voice, ep: 'webgpu', pump: true });
  return ready;
}

function request(i, steps, again = false) {
  const s = segs[i];
  if (!s || (cache.has(s.key) && !again) || pending.has(s.key)) return;
  pending.add(s.key);
  worker.postMessage({ type: 'synth', id: s.key, epoch, text: s.text, steps, urgent: sinceSeek === 0, speed: synthSpeed(), slow: window.__ttsSlow || 1 });
}
// Make speech ahead until about a minute is ready or on its way.
// One sentence at a time, so that each is decided on what the one before has shown. A sentence already made at other
// settings (or, with automatic quality, a lower quality than there is now time for) is made again if that can be done
// before it is needed; until then the earlier one stands.
function ensureAhead() {
  if (isB() || !engineReady || pending.size) return;
  if (tooSlow()) return;
  if (planTail()) return;
  // what the listener has of the sentence being spoken, when it is not one to make (again): the browser's, or the AI's rest of it
  const part = bridge || src?.buffer.tail, left = src ? Math.max(0, src.buffer.duration - (ctx.currentTime - segStart)) : bridgeLeft();
  const lead = part ? left : 0;
  const usable = 0.92 / model.err, from = cur + (part ? 1 : 0);
  const have = (i) => cache.get(segs[i].key) || stale.get(segs[i].key);
  const playing = (i) => i === cur && src;
  const secsOf = (i) => playing(i) ? Math.max(0, src.buffer.duration - (ctx.currentTime - segStart)) : secsNow(have(i));
  let total = lead, end = from;
  for (; end < segs.length && end < cur + AHEAD_MAX && total < AHEAD_SECONDS; end++) {
    if (have(end)) total += secsOf(end);
    // one that cannot be ready in time is left to the browser, which is reading anyway
    else if (bridge && settings.auto && model.n && end < cur + 4 && cost(estSeconds(segs[end]), AUTO_MIN) > total * usable) total += estSeconds(segs[end]);
    else break;
  }
  const spare = total * usable - (end < segs.length && model.n ? cost(estSeconds(segs[end]), AUTO_MIN) : 0);
  let secs = lead;
  for (let i = from; i < end && model.n; i++) {
    const b = have(i);
    if (!b) { secs += estSeconds(segs[i]); continue; }
    const est = secsNow(b);
    // the one being spoken is changed over part-way, if enough of it is left; any other must be ready when it starts
    const room = Math.min(spare, settings.auto ? (total - RESERVE) * 0.4 : Infinity, (playing(i) ? secsOf(i) - 2 : secs) * usable);
    let v = settings.auto ? AUTO_MAX : settings.steps;
    if (settings.auto) while (v >= AUTO_MIN && cost(est, v) > room) v--;
    const old = (b.orig || b).speed !== synthSpeed();
    const want = settings.auto ? v >= AUTO_MIN && (old ? v >= Math.min(b.q, 4) : v >= b.q + 2) : (old || v !== b.q) && cost(est, v) <= room;
    if (want && (playing(i) || i > cur)) return plan(i, v);
    secs += secsOf(i);
  }
  if (end < segs.length && end < cur + AHEAD_MAX && total < AHEAD_SECONDS) plan(end, settings.auto ? bestQuality(end, total) : settings.steps);
}
// With automatic quality, a device that cannot make speech as fast as it is spoken even at the lowest quality reads with
// the browser's voice. Once a minute a sentence is made and thrown away, to see whether that is still so.
let slow = false, probed = 0;
function tooSlow() {
  if (!SS || !settings.auto || !model.n) return false;
  const rtf = cost(8, AUTO_MIN) * model.err / 8;
  slow = rtf > (slow ? 0.75 : 0.95);
  if (slow && performance.now() - probed > 60000 && segs[cur + 1]) {
    probed = performance.now();
    pending.add('probe@');
    worker.postMessage({ type: 'synth', id: 'probe@', epoch, text: segs[cur + 1].text, steps: AUTO_MIN, speed: synthSpeed(), slow: window.__ttsSlow || 1 });
  }
  return slow;
}
function plan(i, v) {
  q = v;
  ui.syncQuality();
  request(i, v, true);
}
// ---- automatic quality: the best each sentence can have without keeping the listener waiting
// Making a sentence takes (quality + 3) stages (duration, text, the steps, vocoder), and a stage takes a fixed time plus
// a time that grows with the sentence: fitted here to the sentences made so far, the recent ones counting most.
const START = 5; // until anything has been measured, and for a sentence the listener is already waiting for
const model = { n: 0, w: 0, x: 0, y: 0, xx: 0, xy: 0, err: 1 };
function learn(secs, steps, time) {
  const m = model, y = time / (steps + 3);
  if (m.n) m.err = Math.min(1.6, Math.max(1, m.err * 0.85 + 0.15, time / costMade(secs, steps)));
  const d = 0.85;
  m.n++; m.w = m.w * d + 1; m.x = m.x * d + secs; m.y = m.y * d + y; m.xx = m.xx * d + secs * secs; m.xy = m.xy * d + secs * y;
}
function cost(secs, steps) { // seconds to make a sentence that lasts secs at the speed set
  return costMade(secs * (settings.speed + 0.05) / (synthSpeed() + 0.05), steps);
}
function costMade(secs, steps) {
  const m = model, mx = m.x / m.w, my = m.y / m.w;
  const varx = m.xx / m.w - mx * mx;
  // too few, or all alike: suppose half the time is fixed
  let slope = m.n >= 3 && varx > 1 ? (m.xy / m.w - mx * my) / varx : my / 2 / mx;
  slope = Math.max(0, Math.min(my / mx, slope));
  return (my + slope * (secs - mx)) * (steps + 3);
}
// hand: seconds of speech the listener has before sentence i is needed. The quality is the highest that has i ready in
// time and still leaves the sentences after it time to be made (at the lowest quality, if need be).
// Raising the quality comes after having RESERVE seconds in hand: until then a sentence may take only a part of what
// there is, and less time than it lasts, so that the hand grows with every one.
const RESERVE = 15;
const allowed = (secs, hand) => hand < RESERVE ? Math.min(0.4 * hand, 0.5 * secs) : (hand - RESERVE) * 0.4 + 0.8 * secs;
// Would the AI, going on from sentence i with hand seconds in hand and need seconds of work to do first, keep up?
function sustains(i, hand, need) {
  if (!model.n) return false;
  for (let j = i; j < segs.length && j < i + 6; j++) {
    const b = cache.get(segs[j].key) || stale.get(segs[j].key);
    if (b) { hand += secsNow(b); continue; }
    need += cost(estSeconds(segs[j]), AUTO_MIN);
    if (need + 0.5 > hand * 0.85 / model.err) return false;
    hand += estSeconds(segs[j]);
  }
  return true;
}
function bestQuality(i, hand) {
  if (hand <= 0 || !model.n) return START;
  const usable = 0.92 / model.err;
  const inTime = (v) => {
    if (cost(estSeconds(segs[i]), v) > allowed(estSeconds(segs[i]), hand)) return false;
    let need = cost(estSeconds(segs[i]), v), have = hand;
    if (need > have * usable) return false;
    for (let j = i + 1; j < segs.length && j < i + 5; j++) {
      have += estSeconds(segs[j - 1]);
      need += cost(estSeconds(segs[j]), AUTO_MIN);
      if (need > have * usable) return false;
    }
    return true;
  };
  let v = AUTO_MAX;
  while (v > AUTO_MIN && !inTime(v)) v--;
  return v;
}
// Seconds of speech made and waiting, counted from the listener's position.
function readyAhead() {
  let secs = src ? Math.max(0, src.buffer.duration - (ctx.currentTime - segStart)) : bridgeLeft();
  for (let i = cur + (src || bridge ? 1 : 0); i < segs.length; i++) {
    const b = cache.get(segs[i].key) || stale.get(segs[i].key);
    if (!b) break;
    secs += secsNow(b);
  }
  return secs;
}
let awaiting = null, gated = false;
let stepFrac = {}; // how far the sentence being made has got
function onStep(m) {
  if (!m.bg) stepFrac = { [m.id]: m.frac };
  if (m.bg) return;
  if (bridge && !gpuSeen && !model.n) { loadFrac = m.frac; ui.status(); } // the first sentence also sets up the graphics card
  if (awaiting === m.id) { curFrac = m.frac; if (state === 'buffering') ui.ring(curFrac); }
}
function onAudio(m) {
  if (m.epoch !== epoch) return;
  pending.delete(m.id);
  const pcm = trim(m.pcm, m.rate);
  const raw = ctx.createBuffer(1, pcm.length, m.rate);
  raw.copyToChannel(pcm, 0);
  raw.speed = synthSpeed();
  raw.q = m.steps;
  const buf = atSpeed(raw);
  if (m.id.includes('@')) {
    raw.tail = buf.tail = true;
    if (tailNow()?.id === m.id) tail.buf = buf;
  } else { stale.delete(m.id); cache.set(m.id, buf); }
  log.push({ key: m.id, at: performance.now(), seconds: buf.duration, ms: m.ms, q: m.steps, on: m.on });
  const gpuFirst = m.on === 'webgpu' && !gpuSeen; // the first sentence made on the GPU also paid for its shaders
  if (m.on === 'webgpu') gpuSeen = true;
  sinceSeek++;
  const said = segs.find((s) => s.key === m.id);
  if (said && buf.duration > 1) cps = cps * 0.8 + said.text.length / buf.duration / settings.speed * 0.2;
  if (!gpuFirst) {
    learn(raw.duration, m.steps, m.ms / 1000);
    checkBackend(m.on);
  }
  if (state === 'buffering' && awaiting === m.id) playCurrent();
  else {
    if (src && segs[cur]?.key === m.id) changeOver(segs[cur], buf);
    ensureAhead();
  }
  ui.status();
  if (exp) ui.exportState();
}
// The silence the model leaves before and after a sentence is taken off: the gaps are ours, and scale with the speed.
function trim(pcm, rate) {
  const w = Math.round(rate * 0.01), loud = (i) => { for (let k = i; k < i + w; k += 2) if (Math.abs(pcm[k]) > 0.012) return true; return false; };
  let a = 0, b = pcm.length;
  while (a + w < b && !loud(a)) a += w;
  while (b - w > a && !loud(b - w)) b -= w;
  if (b - a < rate * 0.1) return pcm;
  return pcm.slice(Math.max(0, a - 2 * w), Math.min(pcm.length, b + 4 * w));
}
// The sentence being spoken has been made again: go over to it at the same place, in the quietest moment of the next
// second and a half (the two have the same words at the same times, give or take a little).
function changeOver(s, buf) {
  const old = src, now = ctx.currentTime, k = buf.duration / old.buffer.duration;
  const at = (now - segStart + 0.05) * k, until = Math.min(at + 1.5, buf.duration - 0.3);
  if (until <= at) return;
  const d = buf.getChannelData(0), r = buf.sampleRate, w = Math.round(r * 0.04);
  let best = Infinity, off = at;
  for (let x = Math.floor(at * r); x + w < until * r; x += w >> 2) {
    let e = 0;
    for (let i = 0; i < w; i += 4) e += d[x + i] * d[x + i];
    if (e < best) { best = e; off = (x + w / 2) / r; }
  }
  const when = segStart + off / k;
  startSource(s, buf, off, when);
  try { old.stop(when); } catch {}
}
function skipBroken(key) { if (segs[cur]?.key === key && state === 'buffering') { cur++; playCurrent(); } }
// A new speed or quality: nothing stops for it. What is made already is kept to play until it has been made again, at
// the new speed by stretching it (WSOLA: overlapping frames, each slid to where it matches the last; the pitch stays).
const stale = new Map(); // key -> AudioBuffer made with earlier settings
function atSpeed(buf) {
  const from = buf.orig || buf;
  const f = (settings.speed + 0.05) / (from.speed + 0.05); // (the model's own 0.05, see the worker)
  const N = 1324, H = N / 2, R = 440, inp = from.getChannelData(0);
  if (Math.abs(f - 1) < 0.005 || inp.length < N * 4) return from;
  const len = Math.floor(inp.length / f), out = new Float32Array(len + N);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  let prev = -1;
  for (let o = 0; o < len; o += H) {
    const want = Math.min(Math.round(o * f), inp.length - N);
    let at = want;
    if (prev >= 0 && prev + H + N <= inp.length) {
      let best = -Infinity;
      for (let c = Math.max(0, want - R); c <= Math.min(inp.length - N, want + R); c += 2) {
        let sum = 0;
        for (let i = 0; i < H; i += 4) sum += inp[prev + H + i] * inp[c + i];
        if (sum > best) { best = sum; at = c; }
      }
    }
    for (let i = 0; i < N; i++) out[o + i] += inp[at + i] * (prev < 0 && i < H ? 1 : win[i]);
    prev = at;
  }
  const b = ctx.createBuffer(1, len, from.sampleRate);
  b.copyToChannel(out.subarray(0, len), 0);
  b.orig = from;
  b.speed = settings.speed;
  b.q = from.q;
  b.tail = from.tail;
  return b;
}
function dropWork() { epoch++; pending.clear(); worker?.postMessage({ type: 'epoch', epoch }); }
function settingChanged() {
  dropWork();
  for (const [k, b] of cache) stale.set(k, b.orig || b);
  cache.clear();
  if (src) {
    const s = segs[cur], done = (ctx.currentTime - segStart) / src.buffer.duration;
    const old = src.buffer, buf = atSpeed(old);
    if (!buf.tail) cache.set(s.key, buf);
    stale.delete(s.key);
    if (buf !== old && done < 1) { stopSource(); startSource(s, buf, Math.max(0, done) * buf.duration); if (state === 'playing') tick(); }
    ensureAhead();
  } else if (state === 'playing' || state === 'buffering') { stopSource(); playCurrent(); }
  ui.status();
}
function invalidate() { // a setting changed: everything made so far is stale
  epoch++; cache.clear(); stale.clear(); pending.clear(); worker?.postMessage({ type: 'epoch', epoch });
}

let sinceSeek = 0; // sentences made since the last start or jump: the buffer is empty then by definition
let gpuSeen = false, gpuJobs = 0, switching = false;
// A graphics card (or browser) whose WebGPU is slower than real time: the processor will do better.
function checkBackend(on) {
  gpuJobs += on === 'webgpu' ? 1 : 0;
  if (backend !== 'webgpu' || gpuJobs < 2 || switching || cost(8, START) < 8 * 1.2) return;
  switching = true;
  worker.postMessage({ type: 'backend', ep: 'wasm' });
  ui.flash('Graphics card too slow here · switching to the processor', 'warn', 6000);
  Object.assign(model, { n: 0, w: 0, x: 0, y: 0, xx: 0, xy: 0, err: 1 });
}
function stalled() { // the listener is waiting: the estimate was wrong, so leave more room
  model.err = Math.min(1.6, model.err * 1.2);
  ui.flash(settings.auto ? 'Buffering · this device is struggling to keep up' : 'Buffering · a lower quality would keep up', 'warn', 6000);
}

// ---------------------------------------------------------------- playback
let state = 'idle'; // idle | loading | buffering | playing | paused
let cur = 0, src = null, segStart = 0, segWords = [], wordIdx = -1, raf = 0, gapTimer = 0;

async function playCurrent(natural = false) {
  clearTimeout(gapTimer);
  if (cur >= segs.length) {
    if (extendWindow() || await morePartsArrived()) return playCurrent();
    return finish();
  }
  holdChunks();
  const s = segs[cur];
  if (!s.rec.el.isConnected) { refresh(); return playCurrent(); }
  if (!isB() && !cache.has(s.key) && stale.has(s.key)) { // not made again in time: the earlier one will do
    cache.set(s.key, atSpeed(stale.get(s.key)));
    stale.delete(s.key);
  }
  // not ready (or this device is too slow for the AI voice): the browser reads it, rather than keep the listener waiting
  // (but a moment's wait for one nearly made is better than another voice)
  const nearly = !bridgeOn && pending.has(s.key) && model.n && cost(estSeconds(s), q) * (1 - (stepFrac[s.key] || 0)) < 1;
  if (natural && SS && settings.auto && !isB() && !cache.has(s.key) && !nearly) bridgeOn = true;
  // and once the browser is reading, the AI takes over only when it will be able to go on
  if (bridgeOn && !bridge && !isB() && (!cache.has(s.key) || (settings.auto && !sustains(cur, 0, 0)))) {
    bridge = s.key;
    // the AI was too late with this one: on to the next, unless it is still setting itself up, which must be finished
    if (pending.has(s.key) && (gpuSeen || model.n)) { epoch++; pending.clear(); worker?.postMessage({ type: 'epoch', epoch }); }
  }
  tailTries = 0; tail = null;
  if (bridge !== s.key) ensureAhead();
  showSentence(s);
  if (isB()) return bSpeak(s);
  if (bridge === s.key) { awaiting = null; gated = false; bSpeak(s); return ensureAhead(); }
  const buf = cache.get(s.key);
  if (!buf) {
    awaiting = s.key; gated = false; curFrac = 0;
    setState('buffering');
    if (natural && sinceSeek > 2) stalled();
    return;
  }
  // Starting (or restarting after a jump or a stall): if the next sentence will not be made before this one has
  // been spoken, wait for it now rather than stop a few seconds in. On a fast device this never waits.
  const next = segs[cur + 1];
  if (!natural && !(SS && settings.auto) && next && !cache.has(next.key) && !stale.has(next.key) && model.n && cost(estSeconds(next), q) > buf.duration + 0.4) {
    if (awaiting !== next.key) curFrac = 0;
    awaiting = next.key; gated = true;
    setState('buffering');
    return;
  }
  gated = false; awaiting = null;
  stopSource();
  startSource(s, buf);
  bridgeOn = false;
  setState('playing');
  tick();
}
function startSource(s, buf, from = 0, when = ctx.currentTime) {
  src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const me = src;
  src.onended = () => {
    if (me !== src || state !== 'playing') return;
    src = null;
    cache.delete(s.key);
    const next = segs[cur + 1];
    const gap = next && next.rec !== s.rec ? 224 : 77; // a breath between sentences, a longer one between paragraphs
    cur++;
    gapTimer = setTimeout(() => playCurrent(true), gap / settings.speed ** 1.5);
  };
  segStart = when - from;
  log.push({ ai: cur, q: buf.q, t: Math.round(performance.now()), ahead: +readyAhead().toFixed(1), tail: !!buf.tail });
  src.start(when, from);
}
function stopSource() { bStop(); if (src) { const s = src; src = null; try { s.stop(); } catch {} } }

function showSentence(s) {
  const r = rangeOf(s.rec, s.a, s.b);
  setHL(hl.sentence, r);
  setHL(hl.word, null);
  segWords = words(s);
  wordIdx = -1;
  follow(r);
  ui.where(headingBefore(s.rec.el));
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: document.querySelector('.article-title')?.textContent || document.title, artist: ui.whereText });
}
let lastStatus = 0;
function tick() {
  cancelAnimationFrame(raf);
  if (state !== 'playing' || !src) return;
  const s = segs[cur];
  const dur = src.buffer.duration;
  // speech starts a moment into the clip and ends a moment before it; stretch the word timeline to match
  const p = Math.min(1, Math.max(0, ((ctx.currentTime - segStart) - 0.02) / Math.max(0.2, dur - 0.06)));
  let i = segWords.findIndex((w) => p < w.end);
  if (i < 0) i = segWords.length - 1;
  if (i !== wordIdx && segWords[i]) { wordIdx = i; setHL(hl.word, rangeOf(s.rec, segWords[i].a, segWords[i].b)); }
  const now = performance.now();
  if (now - lastStatus > 1000) { lastStatus = now; ui.status(); }
  raf = requestAnimationFrame(tick);
}

let userScrolledAt = 0;
function follow(r) {
  if (performance.now() - userScrolledAt < 4000) return; // the reader is looking elsewhere: do not drag them back
  const rect = r.getBoundingClientRect();
  const bottom = innerHeight - (ui.el?.offsetHeight || 0) - 48;
  if (rect.top >= 72 && rect.bottom <= bottom) return;
  scrollBy({ top: rect.top - innerHeight * 0.3, behavior: 'smooth' });
}

function setState(s) { state = s; ui.state(s); }

let playGen = 0;
async function play(from) {
  const gen = ++playGen;
  if (from != null) seek(from, null); // (null: about to play)
  if (!segs.length) refresh();
  if (SS && !SS.getVoices().length) { // listed a moment after they are first asked for
    await new Promise((r) => { SS.addEventListener?.('voiceschanged', r, { once: true }); setTimeout(r, 1000); });
    if (gen !== playGen) return;
  }
  if (isB()) return playCurrent();
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  if (gen !== playGen) return;
  if (state === 'paused' && src) { setState('playing'); tick(); return; }
  const started = startEngine();
  if (SS) { // the browser's voice starts at once; the AI voice takes over when it has a sentence ready
    if (!bridge && !cache.has(segs[cur]?.key)) bridgeOn = true;
    started.then(() => { loadText = ''; loadFrac = 0; if (state !== 'idle') { ensureAhead(); ui.status(); } }, (e) => {
      if (ready === started) { worker?.terminate(); ready = null; } // Play tries again
      loadText = 'Browser voice · the AI voice could not start'; loadFrac = -1;
      console.warn('read aloud:', e);
      if (state === 'buffering') { ui.flash('Read aloud could not start: ' + (e.message || e), 'warn', 0); setState('idle'); } else ui.status();
    });
    return playCurrent();
  }
  if (!engineReady) setState('loading');
  try { await started; } catch (e) { if (gen !== playGen) return; ui.flash('Read aloud could not start: ' + (e.message || e), 'warn', 0); setState('idle'); return; }
  if (gen !== playGen) return; // something else was asked for meanwhile
  playCurrent();
}
function pause() {
  clearTimeout(gapTimer);
  if (isB() || bridge) { bStop(); if (state !== 'idle') setState('paused'); return; }
  if (state === 'playing') { ctx.suspend(); setState('paused'); cancelAnimationFrame(raf); }
  else if (state === 'buffering') setState('paused');
}
function toggle() {
  if (state === 'loading') return;
  state === 'playing' || state === 'buffering' ? pause() : play();
}
function seek(i, andPlay = true) {
  clearTimeout(gapTimer);
  stopSource();
  bKey = bridge = '';
  bridgeOn = false;
  cur = Math.max(0, Math.min(segs.length - 1, i));
  sinceSeek = 0;
  // drop queued sentences that are no longer ahead (but keep any audio already made that still is); the worker also
  // gives up the one it is making. A jump to a sentence already made leaves the work ahead of it alone.
  const made = cache.has(segs[cur]?.key) || stale.has(segs[cur]?.key);
  if (!made || segs.slice(0, cur).some((s) => pending.has(s.key))) {
    epoch++; pending.clear(); worker?.postMessage({ type: 'epoch', epoch });
  }
  if (!made && andPlay !== false && SS && !isB()) bridgeOn = true;
  const keep = new Set(segs.slice(cur, cur + AHEAD_MAX).map((s) => s.key));
  for (const m of [cache, stale]) for (const k of [...m.keys()]) if (!keep.has(k)) m.delete(k);
  userScrolledAt = 0;
  if (andPlay) {
    if (isB()) return play();
    if (ctx?.state === 'suspended') ctx.resume();
    if (engineReady) { state = 'buffering'; playCurrent(); } else play();
  } else if (andPlay === false && (engineReady || isB())) { showSentence(segs[cur]); ensureAhead(); }
}
// Chapters are the headings the bar shows: one starts at the first sentence after a heading (and at the first sentence
// of all, for what comes before any heading).
function chapters() {
  const heads = [...root.querySelectorAll('h2, h3, h4')].filter((h) => !h.closest('section[data-footnotes], [hidden]'));
  const out = [];
  let j = -1, last = null;
  segs.forEach((s, i) => {
    while (heads[j + 1] && heads[j + 1].compareDocumentPosition(s.rec.el) & Node.DOCUMENT_POSITION_FOLLOWING) j++;
    if (j !== last) { out.push({ i, head: heads[j] }); last = j; }
  });
  return out;
}
async function chapter(dir) {
  refresh();
  reachHeadings(dir);
  let list = chapters();
  let now = list.findLastIndex((c) => c.i <= cur);
  // back: to the start of this chapter, or, from its first two sentences, to the one before
  let to = dir > 0 ? now + 1 : cur - list[now]?.i > 1 ? now : now - 1;
  if (dir > 0 && !list[to] && moreToCome()) {
    ui.flash('Getting the rest of the text…');
    if (windowed()) { while (moreToCome() && chapters().at(-1)?.i <= cur) { await new Promise((r) => setTimeout(r, 300)); reachHeadings(1); } }
    else await morePartsArrived();
    list = chapters();
    now = list.findLastIndex((c) => c.i <= cur);
    to = now + 1;
  }
  const c = list[Math.max(0, to)];
  if (!c) { ui.flash(dir > 0 ? 'This is the last chapter' : 'This is the first chapter'); return; }
  seek(c.i, state !== 'paused' && state !== 'idle');
  // at once, not smoothly: it may be a long way, and the heights in between are estimates until they are drawn
  const el = c.head || segs[c.i].rec.el;
  for (let k = 0; k < 4; k++) {
    scrollTo({ top: scrollY + el.getBoundingClientRect().top - 90, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(r));
  }
}
function finish() {
  stopSource(); setState('idle'); cur = 0;
  setHL(hl.sentence, null); setHL(hl.word, null);
  ui.where('Finished');
}

function refresh() {
  const curSeg = segs[cur];
  segs = collect();
  if (curSeg) {
    const at = segs.findIndex((s) => s.key === curSeg.key);
    if (at >= 0) cur = at;
  }
  ui.syncChapters();
}
// Long books arrive in parts after the page loads; wait for the rest before calling the book finished.
function morePartsArrived() {
  if (!moreToCome()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const before = segs.length;
    const mo = new MutationObserver(() => {
      refresh();
      if (windowed() && extendWindow()) { mo.disconnect(); return resolve(true); }
      if (segs.length > before || !moreToCome()) { mo.disconnect(); resolve(segs.length > before); }
    });
    mo.observe(root, { childList: true, subtree: true });
  });
}
async function allParts() { while (moreToCome()) await new Promise((r) => setTimeout(r, 300)); refresh(); }

// ---------------------------------------------------------------- MP3 export of the whole text
// Runs in the same worker as playback but only when playback has nothing waiting, and is encoded as it goes, so
// memory holds the MP3 (about 0.5 MB a minute), never the raw audio.
let exp = null;
async function startExport() {
  if (exp || isB()) return;
  exp = { list: [], next: 0, written: 0, results: new Map(), t0: 0, mp3: null, steps: q };
  ui.exportState();
  ui.flash('Getting the whole text ready for the MP3…');
  if (!ctx) ctx = new AudioContext();
  try { await startEngine(); } catch (e) { ui.flash('MP3 could not start: ' + (e.message || e), 'warn', 0); exp = null; ui.exportState(); return; }
  await allParts();
  if (!exp) return;
  exp.list = wholeText().slice(0, window.__ttsExportLimit || Infinity); // (the limit is a prototype test switch)
  exp.t0 = performance.now();
  exp.mp3 = new Worker(`${BASE}/mp3/mp3-worker.js`);
  exp.mp3.onmessage = ({ data }) => { if (data.type === 'done') saveExport(data.blob); };
  fillExport();
  ui.exportState();
}
function fillExport() {
  while (exp && exp.next < exp.list.length && exp.next - exp.written < 3) {
    const i = exp.next++;
    worker.postMessage({ type: 'synth', bg: true, id: 'x:' + i, text: exp.list[i].text, steps: exp.steps, speed: synthSpeed() });
  }
}
function onExportAudio(m) {
  if (!exp?.mp3) return;
  if (!exp.rate && m.pcm.length) { exp.rate = m.rate; exp.mp3.postMessage({ type: 'init', rate: m.rate, kbps: MP3_KBPS }); }
  let pcm = trim(m.pcm, m.rate);
  if (pcm.length && settings.speed > synthSpeed()) {
    const b = ctx.createBuffer(1, pcm.length, m.rate);
    b.copyToChannel(pcm, 0);
    b.speed = synthSpeed();
    pcm = atSpeed(b).getChannelData(0).slice();
  }
  exp.results.set(Number(m.id.slice(2)), pcm);
  while (exp.rate && exp.results.has(exp.written)) {
    const i = exp.written, pcm = exp.results.get(i);
    exp.results.delete(i);
    const next = exp.list[i + 1];
    const gap = next ? Math.round(exp.rate * (next.rec !== exp.list[i].rec ? 0.45 : 0.16) / settings.speed) : 0;
    const out = new Float32Array(pcm.length + gap);
    out.set(pcm);
    exp.mp3.postMessage({ type: 'pcm', pcm: out }, [out.buffer]);
    exp.written++;
  }
  if (exp.written === exp.list.length) exp.mp3.postMessage({ type: 'end' });
  else fillExport();
  ui.exportState();
}
function saveExport(blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.querySelector('.article-title')?.textContent.trim() || 'Reading') + '.mp3';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  ui.flash(`MP3 saved · ${(blob.size / 1048576).toFixed(1)} MB`, 'info', 8000);
  exp.mp3.terminate();
  exp = null;
  ui.exportState();
}
function cancelExport() {
  if (!exp) return;
  worker?.postMessage({ type: 'cancel-bg' });
  exp.mp3?.terminate();
  exp = null;
  ui.exportState();
  ui.flash('MP3 cancelled');
}

// ---------------------------------------------------------------- click (or tap) any sentence to read from there
function segAtPoint(x, y) {
  let node, off;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (!node || node.nodeType !== 3) return -1;
  const rec = nodeBlock.get(node);
  if (!rec) return -1;
  // the caret lands in the nearest text, even in the margin: require the point to be on (or between) the lines
  const r = new Range(); r.selectNodeContents(node);
  if (![...r.getClientRects()].some((q) => x >= q.left - 8 && x <= q.right + 8 && y >= q.top - 7 && y <= q.bottom + 7)) return -1;
  const at = rec.nodes.find((n) => n.node === node).start + off;
  let i = segs.findIndex((s) => s.rec === rec && at < s.b);
  if (i < 0) i = segs.findLastIndex((s) => s.rec === rec);
  return i;
}
function onClick(e) {
  if (!ui.open || e.button !== 0 || !root.contains(e.target) || e.target.closest('a, button, input, select, sup, .tts-ui')) return;
  if (!getSelection().isCollapsed) return; // selecting text, not asking to listen
  if (!segs.length) refresh();
  const i = segAtPoint(e.clientX, e.clientY);
  if (i >= 0) seek(i);
}
// Space or K: pause and play, while the bar is open. Left alone: typing, menus and checkboxes, and a link or button the
// reader has moved to with the keyboard.
function onKey(e) {
  if (!ui.open || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.key !== ' ' && e.key.toLowerCase() !== 'k')) return;
  const t = e.target;
  if (t.isContentEditable || t.closest?.('textarea, select, input:not([type=range])')) return;
  if (e.key === ' ' && t.closest?.('button, summary, [role=button], input[type=checkbox]')) return;
  e.preventDefault();
  if (!e.repeat) toggle();
}
let hoverRaf = 0;
function onMove(e) {
  if (!ui.open || e.pointerType === 'touch') return;
  if (!root.contains(e.target)) { cancelAnimationFrame(hoverRaf); setHL(hl.hover, null); root.classList.remove('tts-pointing'); return; }
  cancelAnimationFrame(hoverRaf);
  hoverRaf = requestAnimationFrame(() => {
    const i = e.target.closest?.('a, button, sup, .tts-ui') ? -1 : segAtPoint(e.clientX, e.clientY);
    const s = segs[i];
    setHL(hl.hover, s && i !== cur ? rangeOf(s.rec, s.a, s.b) : null);
    root.classList.toggle('tts-pointing', !!s);
  });
}

// ---------------------------------------------------------------- the player bar
const ICON = {
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  prev: '<path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/>',
  next: '<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>',
  prevCh: '<path d="M4 6h2v12H4zM13 6v12l-6.5-6zM20.5 6v12L14 12z"/>',
  nextCh: '<path d="M18 6h2v12h-2zM11 6v12l6.5-6zM3.5 6v12l6.5-6z"/>',
  close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/>',
  tune: '<path d="M4 7h9.2a2.5 2.5 0 0 0 4.6 0H20V5h-2.2a2.5 2.5 0 0 0-4.6 0H4zm0 12h4.2a2.5 2.5 0 0 0 4.6 0H20v-2h-7.2a2.5 2.5 0 0 0-4.6 0H4zm0-6h1.2a2.5 2.5 0 0 0 4.6 0H20v-2H9.8a2.5 2.5 0 0 0-4.6 0H4z"/>',
  down: '<path d="M11 4h2v9.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4 3.6 3.6zM5 18h14v2H5z"/>',
  chev: '<path d="M7.4 9 12 13.6 16.6 9 18 10.4l-6 6-6-6z"/>',
};
const svg = (k, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" aria-hidden="true">${ICON[k]}</svg>`;

const CSS_TEXT = `
::highlight(tts-sentence){background-color:color-mix(in srgb,var(--secondary) 11%,transparent)}
::highlight(tts-word){background-color:color-mix(in srgb,var(--secondary) 30%,transparent);color:var(--dark)}
::highlight(tts-hover){text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--secondary) 55%,transparent);text-decoration-thickness:2px;text-underline-offset:3px}
.tts-pointing{cursor:pointer}
.tts-ui{--warn:#c62828;position:fixed;z-index:900;left:50%;bottom:16px;transform:translateX(-50%);width:min(680px,calc(100vw - 24px));
 background:var(--light);color:var(--darkgray);border:1px solid var(--lightgray);border-radius:16px;
 box-shadow:0 8px 28px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);font-family:var(--bodyFont),sans-serif;font-size:14.5px;overflow:hidden}
:root[saved-theme=dark] .tts-ui{--warn:#ff8a80}
.tts-ui[hidden]{display:none}
.tts-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer}
.tts-ui button{all:unset;box-sizing:border-box;cursor:pointer;display:inline-grid;place-items:center;border-radius:999px;color:var(--darkgray)}
.tts-ui button:focus-visible{outline:2px solid var(--secondary);outline-offset:2px}
.tts-ui .tts-ic{width:36px;height:36px;flex:none}
.tts-ui button[hidden]{display:none}
.tts-ui :disabled{opacity:.45;cursor:default}
.tts-ui .tts-ic:hover{background:var(--lightgray)}
.tts-ui .tts-main{position:relative;flex:none;width:46px;height:46px;background:var(--secondary);color:var(--light)}
.tts-ui .tts-main:hover{filter:brightness(1.12)}
.tts-ui .tts-main svg{position:relative;z-index:1;width:24px;height:24px}
/* progress ring: real progress of what the machine is doing (download, or the sentence being made) */
.tts-ui .tts-main.ring{background:conic-gradient(var(--secondary) var(--p,0%),color-mix(in srgb,var(--secondary) 22%,var(--light)) 0)}
.tts-ui .tts-main.ring::before{content:"";position:absolute;inset:4px;border-radius:50%;background:color-mix(in srgb,var(--secondary) 80%,var(--light))}
.tts-info{flex:1;min-width:0;padding:0 6px;line-height:1.3}
.tts-where{font-weight:600;color:var(--dark);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tts-sub{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--gray);white-space:nowrap;overflow:hidden}
.tts-sub span{overflow:hidden;text-overflow:ellipsis}
.tts-sub.warn{color:var(--warn);font-weight:600}
.tts-meter{flex:1;min-width:60px;max-width:240px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--secondary) 18%,transparent);overflow:hidden}
.tts-meter>i{display:block;height:100%;width:0;background:var(--secondary);border-radius:3px;transition:width .15s}
.tts-chip{height:32px;padding:0 10px !important;gap:6px;display:inline-flex !important;align-items:center;font-size:13.5px;font-weight:600;border:1px solid var(--lightgray)}
.tts-chip:hover,.tts-chip[aria-expanded="true"]{background:var(--lightgray)}
.tts-chip svg{width:18px;height:18px}
.tts-chip .tts-chev{transition:transform .2s}
.tts-chip[aria-expanded="true"] .tts-chev{transform:rotate(180deg)}
.tts-panel{display:grid;grid-template-columns:auto 1fr auto;gap:10px 14px;align-items:center;padding:12px 16px 14px;border-top:1px solid var(--lightgray)}
.tts-panel[hidden]{display:none}
.tts-panel label{font-weight:600;color:var(--dark)}
.tts-panel output{font-variant-numeric:tabular-nums;min-width:5.5em;text-align:right;color:var(--darkgray)}
.tts-panel select{font:inherit;color:var(--dark);background:var(--light);border:1px solid var(--lightgray);border-radius:8px;padding:4px 8px;grid-column:2/4}
.tts-panel input[type=range]{width:100%;accent-color:var(--secondary)}
.tts-panel .tts-row{grid-column:2/4;display:flex;align-items:center;gap:12px;color:var(--darkgray);font-size:13.5px}
.tts-panel .tts-row input[type=checkbox]{accent-color:var(--secondary);width:16px;height:16px;margin:0}
.tts-panel .tts-check{font-weight:400;color:var(--darkgray);display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.tts-panel .tts-hint{grid-column:1/4;font-size:12.5px;color:var(--gray);margin-top:-4px}
.tts-panel .tts-sep{grid-column:1/4;border-top:1px solid var(--lightgray);margin:2px 0}
.tts-ui .tts-btn{flex:none;white-space:nowrap;height:32px;padding:0 12px 0 10px;gap:6px;display:inline-flex;align-items:center;font-weight:600;font-size:13.5px;border:1.5px solid color-mix(in srgb,var(--secondary) 45%,transparent);color:var(--secondary)}
.tts-ui .tts-btn:hover{background:color-mix(in srgb,var(--secondary) 9%,transparent);border-color:var(--secondary)}
.tts-ui .tts-btn svg{width:18px;height:18px}
.tts-export-info{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.tts-export-info .tts-meter{max-width:none}
@media (max-width:560px){.tts-sub .tts-meter{min-width:32px;max-width:40px;flex:none}.tts-info{padding:0 2px}.tts-bar{gap:2px;padding:8px 6px}.tts-ui{bottom:8px;border-radius:14px}.tts-hide-sm{display:none !important}.tts-chip span{display:none}.tts-chip{padding:0 8px !important}
 .tts-panel{grid-template-columns:auto 1fr auto;padding:12px}.tts-panel .tts-row{flex-wrap:wrap}}
`;

const mb = (b) => (b / 1048576).toFixed(0);
const mins = (s) => s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;

const ui = {
  el: null, open: false, whereText: '', flashUntil: 0, flashTimer: 0,
  build() {
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    this.style = style;
    const el = document.createElement('div');
    el.className = 'tts-ui';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Read aloud');
    el.innerHTML = `
      <div class="tts-bar">
        <button class="tts-ic tts-ch" data-act="prevCh" aria-label="Previous chapter" title="Previous chapter">${svg('prevCh')}</button>
        <button class="tts-ic tts-hide-sm" data-act="prev" aria-label="Previous sentence" title="Previous sentence">${svg('prev')}</button>
        <button class="tts-main" data-act="toggle" aria-label="Play" title="Play or pause (Space or K)">${svg('play')}</button>
        <button class="tts-ic tts-hide-sm" data-act="next" aria-label="Next sentence" title="Next sentence">${svg('next')}</button>
        <button class="tts-ic tts-ch" data-act="nextCh" aria-label="Next chapter" title="Next chapter">${svg('nextCh')}</button>
        <div class="tts-info"><div class="tts-where"></div><div class="tts-sub" aria-live="polite"></div></div>
        <button class="tts-chip" data-act="settings" aria-expanded="false" aria-controls="tts-panel" aria-label="Voice and settings">${svg('tune')}<span class="tts-voice-name"></span><svg class="tts-chev" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${ICON.chev}</svg></button>
        <button class="tts-ic" data-act="close" aria-label="Close read aloud">${svg('close')}</button>
      </div>
      <div class="tts-panel" id="tts-panel" hidden>
        <label for="tts-voice">Voice</label>
        <select id="tts-voice"></select>
        <label for="tts-speed">Speed</label><input id="tts-speed" type="range" min="0.8" max="3" step="0.05"><output for="tts-speed"></output>
        <label for="tts-steps">Quality</label><input id="tts-steps" type="range" min="${AUTO_MIN}" max="${AUTO_MAX}" step="1"><output for="tts-steps"></output>
        <span></span><div class="tts-row"><label class="tts-check"><input type="checkbox" id="tts-auto"> Adjust automatically to keep up</label></div>
        <div class="tts-hint">Higher quality sounds clearer but takes longer to make each sentence.</div>
        <div class="tts-sep"></div>
        <label>MP3</label>
        <div class="tts-row tts-export">
          <button class="tts-btn" data-act="export">${svg('down')}<span>Download full text</span></button>
          <div class="tts-export-info"></div>
        </div>
      </div>`;
    this.el = el;
    this.attach();
    this.$ = (s) => el.querySelector(s);
    // sit over the text column, not the middle of the window
    const place = () => {
      const c = document.querySelector('#quartz-body .center')?.getBoundingClientRect();
      if (!c || innerWidth <= 800) { el.style.left = ''; el.style.width = ''; return; }
      el.style.left = c.left + c.width / 2 + 'px';
      el.style.width = Math.min(680, c.width) + 'px';
    };
    this.place = place;
    place();
    addEventListener('resize', place, { passive: true });

    // a mouse click leaves the focus alone, so that Space afterwards pauses rather than pressing that button again
    el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) { if (e.target.closest('.tts-bar')) this.togglePanel(); return; } // anywhere on the bar opens it
      const act = b.dataset.act;
      if (act === 'toggle') toggle();
      else if (act === 'prev') seek(cur - 1, state !== 'paused' && state !== 'idle');
      else if (act === 'next') seek(cur + 1, state !== 'paused' && state !== 'idle');
      else if (act === 'prevCh') chapter(-1);
      else if (act === 'nextCh') chapter(1);
      else if (act === 'close') close();
      else if (act === 'settings') this.togglePanel();
      else if (act === 'export') exp ? cancelExport() : startExport();
    });
    const voice = this.$('#tts-voice'), speed = this.$('#tts-speed'), steps = this.$('#tts-steps'), auto = this.$('#tts-auto');
    this.fillVoices = () => {
      const opt = (k, n) => { const o = new Option(n, k); return o; };
      const ai = document.createElement('optgroup'), br = document.createElement('optgroup');
      ai.label = 'AI voices'; br.label = "This browser's voices";
      ai.append(...VOICES.map(([k, n]) => opt(k, n)));
      br.append(opt('b:', 'Browser default'), ...bVoices().map((v) => opt('b:' + v.voiceURI, bName(v))));
      voice.replaceChildren(ai, ...(SS ? [br] : []));
      voice.value = settings.voice;
      if (!voice.value) voice.value = SS && isB() ? 'b:' : 'M2'; // its voices may still be loading
      this.showValues?.();
    };
    if (!SS && isB()) settings.voice = 'M2';
    this.fillVoices();
    SS?.addEventListener?.('voiceschanged', () => this.fillVoices());
    speed.value = settings.speed; steps.value = q; auto.checked = settings.auto;
    this.showValues = () => {
      this.$('output[for=tts-speed]').textContent = Number(speed.value).toFixed(2).replace(/0$/, '') + '×';
      this.$('output[for=tts-steps]').textContent = steps.value + ' steps';
      this.$('.tts-voice-name').textContent = VOICES.find(([k]) => k === voice.value)?.[1] || (bVoice()?.name.replace(/^Microsoft /, '').replace(/ (Online|-).*$/, '') || 'Browser');
      steps.disabled = auto.disabled = isB(); // the browser's voices have no quality to choose
    };
    this.showValues();
    voice.addEventListener('change', () => {
      const was = isB(), going = state === 'playing' || state === 'buffering' || state === 'loading';
      playGen++; stopSource(); clearTimeout(gapTimer); cancelAnimationFrame(raf);
      settings.voice = voice.value; store.set('voice-2', settings.voice);
      this.flashUntil = 0;
      this.showValues(); this.exportState();
      if (engineReady && !isB()) worker.postMessage({ type: 'voice', voice: settings.voice });
      invalidate();
      bridge = ''; bridgeOn = false; if (was !== isB()) bKey = '';
      if (going) { state = 'paused'; play(); } else this.status();
    });
    speed.addEventListener('input', this.showValues);
    steps.addEventListener('input', () => { if (auto.checked) { auto.checked = false; auto.dispatchEvent(new Event('change')); } this.showValues(); });
    speed.addEventListener('change', () => { settings.speed = Number(speed.value); store.set('speed', settings.speed); settingChanged(); });
    steps.addEventListener('change', () => { settings.steps = q = Number(steps.value); store.set('steps', settings.steps); settingChanged(); this.status(); });
    auto.addEventListener('change', () => { settings.auto = auto.checked; store.set('auto', settings.auto); if (!settings.auto) settings.steps = q = Number(steps.value); ensureAhead(); this.status(); });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => play());
      navigator.mediaSession.setActionHandler('pause', () => pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => seek(cur - 1));
      navigator.mediaSession.setActionHandler('nexttrack', () => seek(cur + 1));
    }
    this.exportState();
  },
  attach() { // (taken off the page when it changes, or the router would work it into the next one)
    if (!this.style.isConnected) document.head.append(this.style);
    if (!this.el.isConnected) document.body.append(this.el);
    this.place?.();
  },
  togglePanel() {
    const p = this.$('.tts-panel');
    p.hidden = !p.hidden;
    this.$('.tts-chip').setAttribute('aria-expanded', String(!p.hidden));
  },
  syncChapters() { // a page without headings has no chapters to skip between
    if (!this.el) return;
    const has = !!moreToCome() || chapters().length > 1;
    for (const b of this.el.querySelectorAll('.tts-ch')) b.hidden = !has;
  },
  syncQuality() { this.$('#tts-steps').value = q; this.showValues(); },
  state(s) {
    const b = this.$('.tts-main');
    const playing = s === 'playing' || s === 'buffering' || s === 'loading';
    b.innerHTML = svg(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', s === 'loading' ? 'Loading' : playing ? 'Pause' : 'Play');
    if (s !== 'buffering' && s !== 'loading') b.classList.remove('ring');
    if (s === 'buffering') this.ring(curFrac);
    document.querySelector('.tts-listen')?.setAttribute('aria-pressed', String(playing || s === 'loading'));
    this.status();
  },
  ring(frac) {
    const b = this.$('.tts-main');
    b.classList.add('ring');
    b.style.setProperty('--p', (Math.max(0.02, frac) * 100).toFixed(1) + '%');
    if (state === 'buffering') this.status();
  },
  // First use: a real progress bar for the download, then the four parts of the model being set up.
  loading(phase, done, total) {
    if (bridge || bridgeOn || state === 'idle' || state === 'paused') { // being read by the browser meanwhile
      loadFrac = total ? done / total : 0;
      loadText = phase === 'download' ? `Loading AI voice · ${mb(done)} of ${mb(total)} MB` : `Preparing AI voice · part ${Math.min(done + 1, total)} of ${total}`;
      return this.status();
    }
    if (phase === 'download') {
      const f = total ? done / total : 0;
      this.where('Downloading the voice');
      this.setSub(`<div class="tts-meter"><i style="width:${(f * 100).toFixed(1)}%"></i></div><span>${mb(done)} of ${mb(total)} MB · once only</span>`);
      this.ring(f * 0.9);
    } else {
      this.where('Getting the voice ready');
      this.setSub(`<div class="tts-meter"><i style="width:${(done / total * 100).toFixed(0)}%"></i></div><span>part ${Math.min(done + 1, total)} of ${total}</span>`);
      this.ring(0.9 + 0.1 * done / total);
    }
  },
  // The status line: messages first (red for trouble), otherwise what the machine is doing.
  flash(text, kind = 'info', ms = 4000) {
    clearTimeout(this.flashTimer);
    this.flashUntil = ms ? performance.now() + ms : Infinity;
    this.setSub(`<span>${text}</span>`, kind === 'warn');
    if (ms) this.flashTimer = setTimeout(() => { this.flashUntil = 0; this.status(); }, ms);
  },
  status() {
    if (!this.el || state === 'loading' || performance.now() < this.flashUntil) return;
    if (isB()) {
      const v = bVoice();
      return this.setSub(`<span>${state === 'idle' ? 'Click any sentence to read from there' : `Browser voice${v ? v.localService ? ' · on this device' : ' · online, the text is sent to its maker' : ''}`}</span>`);
    }
    const auto = settings.auto ? ' (auto)' : '';
    let text = '';
    // the first sentence on a GPU also compiles its shaders (~1 s in Chrome, ~12 s in Firefox): say so
    if (state === 'buffering') text = backend === 'webgpu' && !gpuSeen
      ? `Setting up the graphics card, first sentence only · ${Math.round(curFrac * 100)}%`
      : `${gated ? 'Getting ahead before starting' : 'Making this sentence'} · ${Math.round(curFrac * 100)}% · quality ${q}${auto}`;
    else if (state === 'playing' || state === 'paused') {
      const ahead = readyAhead();
      text = `${pending.size ? 'Rendering ahead' : 'Ready ahead'} · ${mins(ahead)} · quality ${src?.buffer.q ?? q}${src && q > src.buffer.q ? `, next ${q}` : ''}${auto}`;
    } else if (state === 'idle') text = 'Click any sentence to read from there';
    const loading = loadText || !engineReady || (!gpuSeen && !model.n);
    if (!isB() && loading && (bridge || bridgeOn) && (state === 'playing' || state === 'paused')) {
      const text = loadText || (engineReady ? 'Setting up AI voice' : 'Loading AI voice');
      return this.setSub(`${loadFrac < 0 ? '' : `<div class="tts-meter"><i style="width:${(loadFrac * 100).toFixed(1)}%"></i></div>`}<span>${text}</span>`);
    }
    if (bridge && slow) return this.setSub('<span>Browser voice · this device is too slow for the AI voice</span>');
    if (bridge && state === 'playing') return this.setSub('<span>Browser voice · the AI voice is making the next sentence</span>');
    this.setSub(`<span>${text}</span>`);
  },
  setSub(html, warn = false) {
    const s = this.$('.tts-sub');
    s.innerHTML = html;
    s.classList.toggle('warn', warn);
  },
  exportState() {
    if (!this.el) return;
    const btn = this.$('[data-act=export]'), info = this.$('.tts-export-info');
    btn.disabled = !exp && isB();
    if (btn.disabled) { info.innerHTML = '<span>AI voices only</span>'; return; }
    if (!exp) {
      if (!segs.length) refresh();
      const secs = windowed() ? W().chars() / cps / settings.speed : segs.reduce((a, s) => a + estSeconds(s), 0);
      if (secs > 20 * 3600) { btn.disabled = true; info.innerHTML = '<span>Too long for one MP3</span>'; return; }
      btn.innerHTML = `${svg('down')}<span>Download full text</span>`;
      info.innerHTML = `<span>about ${mins(secs).replace(' ', '')}, ${Math.max(1, Math.round(secs * MP3_KBPS / 8 / 1024))}MB${moreToCome() ? '+' : ''}</span>`;
      return;
    }
    btn.innerHTML = `<span>Cancel</span>`;
    const total = exp.list.length;
    if (!total) { info.innerHTML = '<span>Preparing…</span>'; return; }
    const f = exp.written / total;
    const el = (performance.now() - exp.t0) / 1000;
    const left = exp.written > 2 ? el / exp.written * (total - exp.written) : 0;
    // playback always goes first: on a slow device the MP3 waits until the reading has its minute in hand
    const waiting = pending.size > 0 && (state === 'playing' || state === 'buffering');
    info.innerHTML = `<div class="tts-meter"><i style="width:${(f * 100).toFixed(1)}%"></i></div><span>${Math.floor(f * 100)}%${waiting ? ' · waiting while the reading gets ahead' : left ? ' · about ' + mins(left) + ' left' : ''}</span>`;
    if (state === 'idle' && performance.now() >= this.flashUntil) this.setSub(`<span>Making the MP3 · ${Math.floor(f * 100)}%</span>`);
  },
  where(t) { this.whereText = t; this.$('.tts-where').textContent = t; },
};
// lets the tests see what the reader is doing
const log = [];
const testing = location.hostname === 'localhost';
if (!testing) log.push = () => 0;
if (testing) window.__tts = { get state() { return state; }, get cur() { return cur; }, get segs() { return segs; }, get backend() { return backend; }, get q() { return q; }, get exp() { return exp; }, readyAhead, log, seek, segAtPoint };

// ---------------------------------------------------------------- open / close
let listening = false, refreshing = 0;
const watch = new MutationObserver(() => {
  if (state === 'idle' || refreshing) return;
  refreshing = setTimeout(() => { refreshing = 0; if (state !== 'idle' && root.isConnected) refresh(); }, 50);
});
export function open() {
  const here = [...document.querySelectorAll('article .markdown-rendered')].find((x) => !x.closest('.popover'));
  if (!here) return;
  if (root !== here) {
    root = pageRoot = here;
    watch.disconnect();
    watch.observe(root, { childList: true, subtree: true });
  }
  SS?.getVoices(); // the browser lists its voices a moment after they are first asked for
  if (!ui.el) ui.build();
  ui.attach();
  ui.el.hidden = false;
  document.activeElement?.closest?.('.tts-listen')?.blur(); // so that Space pauses, rather than pressing Listen again
  ui.open = true;
  if (!listening) {
    listening = true;
    document.addEventListener('click', onClick);
    document.addEventListener('pointermove', onMove);
    for (const ev of ['wheel', 'touchmove']) addEventListener(ev, () => { userScrolledAt = performance.now(); }, { passive: true });
    addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.key) && !e.target.closest?.('.tts-ui')) userScrolledAt = performance.now(); });
    addEventListener('keydown', onKey);
    document.addEventListener('prenav', leave); // the site navigates without reloading
  }
  refresh();
  if (state === 'playing' || state === 'buffering' || state === 'loading') return;
  // Start where the reader is looking: the first sentence on screen.
  let first = 0;
  for (let hi = segs.length; first < hi;) {
    const m = (first + hi) >> 1, s = segs[m];
    if (rangeOf(s.rec, s.a, s.b).getBoundingClientRect().bottom > 90) hi = m; else first = m + 1;
  }
  ui.exportState();
  play(state === 'paused' ? null : first < segs.length ? first : 0);
}
function close() {
  if (!ui.el) return;
  stopSource(); bridge = ''; bridgeOn = false; clearTimeout(gapTimer); cancelAnimationFrame(raf);
  if (state !== 'idle') ctx?.suspend();
  setState('idle');
  ui.el.hidden = true; ui.open = false;
  if (held.length) { held.forEach((d) => W()?.release(d)); held = []; }
  for (const h of Object.values(hl)) h?.clear();
  root?.classList.remove('tts-pointing');
  document.querySelector('.tts-listen')?.setAttribute('aria-pressed', 'false');
}
function leave() { // to another page: nothing of this one is kept
  close();
  cancelExport();
  watch.disconnect();
  playGen++;
  invalidate();
  held = []; segs = []; cur = 0; root = null;
  if (!ui.el) return;
  ui.el.remove();
  ui.style.remove();
}
