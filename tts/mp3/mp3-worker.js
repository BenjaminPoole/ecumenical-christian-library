// MP3 export: encodes the book's audio as it is made, 64 kbit/s mono, with lamejs (loaded only for an export).
// The model puts next to nothing above 12 kHz (measured: 38 dB and more below the speech band), so 64 kbit/s
// mono loses nothing audible. In: {type:'init', rate, kbps}  {type:'pcm', pcm: Float32Array}  {type:'end'}
// Out: {type:'done', blob}
importScripts('lame.min.js');
let enc, out = [];
const FRAME = 1152;
let carry = new Int16Array(0);

self.onmessage = ({ data: m }) => {
  if (m.type === 'init') {
    enc = new lamejs.Mp3Encoder(1, m.rate, m.kbps);
    out = []; carry = new Int16Array(0);
  } else if (m.type === 'pcm') {
    const f = m.pcm;
    const s = new Int16Array(carry.length + f.length);
    s.set(carry);
    for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); s[carry.length + i] = v < 0 ? v * 32768 : v * 32767; }
    const whole = s.length - (s.length % FRAME);
    for (let i = 0; i < whole; i += FRAME * 32) {
      const b = enc.encodeBuffer(s.subarray(i, Math.min(whole, i + FRAME * 32)));
      if (b.length) out.push(new Uint8Array(b));
    }
    carry = s.slice(whole);
  } else if (m.type === 'end') {
    if (carry.length) { const b = enc.encodeBuffer(carry); if (b.length) out.push(new Uint8Array(b)); }
    const b = enc.flush();
    if (b.length) out.push(new Uint8Array(b));
    self.postMessage({ type: 'done', blob: new Blob(out, { type: 'audio/mpeg' }) });
    out = [];
  }
};
