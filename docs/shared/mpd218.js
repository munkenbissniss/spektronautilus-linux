// Akai MPD218: one click sets up the pads, and the knobs are learned by turning each one once.
// The pads send notes 36-51 (pad bank A), 52-67 (B) and 68-83 (C) on MIDI channel 10 out of the box; the knobs' numbers
// differ between presets, so they are not guessed. Pad 1 is bottom left, pad 4 bottom right, pad 13 top left.
const range = (from, ids) => Object.fromEntries(ids.map((id, i) => [from + i, id]).filter(([, id]) => id));
const n = (p, k) => Array.from({ length: k }, (_, i) => p + (i + 1));

export const MPD_LAYOUTS = {
  // VJ Mixer: bank A = 16 clips, bank B = 4 more clips, the 8 effects and the beat buttons, bank C = layers, posters, logo, banks
  vj: {
    pads: {
      ...range(36, n('pad', 16)),
      ...range(52, [...n('pad', 20).slice(16), ...n('fx', 8), 'mix', 'tap', 'beat1', 'posterHide']),
      ...range(68, [...n('sel', 6), ...n('poster', 4), 'logo', 'bankPrev', 'bankNext']),
    },
    knobs: ['xfade', 'fxAmount', 'op1', 'op2', 'op4', 'op5'],
  },
  // Video DJ: bottom row = play A, mix, mix, play B; next row = poster 1-4; then hide poster ... logo
  dj: {
    pads: range(36, ['playA', 'mix', 'mix', 'playB', ...n('poster', 4), 'posterHide', '', '', 'logo']),
    knobs: ['volA', 'volB', 'xfade'],
  },
};
export const MPD_CHANNELS = [9, 0];   // channel 10 (the factory setting) and channel 1 (some presets)

// The pads, added to an existing map. Earlier keys for these actions are kept, so nothing the user learned by hand is lost,
// except a key that is now used by a pad.
export function mpdPadMap(map, layout) {
  const out = { ...map };
  for (const ch of MPD_CHANNELS) for (const [note, id] of Object.entries(layout.pads)) out[`note:${ch}:${note}`] = id;
  return out;
}

// Learning the knobs: turn knob 1, then knob 2 ... A knob sends many messages while it turns, so a knob that has just been learned
// is ignored until another one moves. Pads (notes) do not count. Returns the new state; state.done is true at the end.
export function mpdWizardStart(map, layout) {
  const m = { ...map };
  for (const k of Object.keys(m)) if (m[k] && layout.knobs.includes(m[k]) && k.startsWith('cc:')) delete m[k];
  return { map: m, steps: layout.knobs.slice(), i: 0, used: [], done: layout.knobs.length === 0 };
}
export function mpdWizardFeed(st, msg) {
  if (!st || st.done || !msg || msg.type !== 'cc') return st;
  const key = `cc:${msg.ch}:${msg.num}`;
  if (st.used.includes(key)) return st;
  const map = { ...st.map }; delete map[key]; map[key] = st.steps[st.i];
  const i = st.i + 1;
  return { ...st, map, i, used: [...st.used, key], done: i >= st.steps.length };
}
export function mpdWizardSkip(st) { if (!st || st.done) return st; const i = st.i + 1; return { ...st, i, done: i >= st.steps.length }; }
export const isMpd = name => /mpd\s*218/i.test(name || '');

// The button, the "turn knob 1" line and its Skip / Done buttons. feed(msg) returns true while it uses the message.
export function attachMpd({ $, S, store, layout, actions, renderMidi, enableMidi, toast = () => {} }) {
  const T = s => (window.SPK_T ? window.SPK_T(s) : s), btn = $('#mpdSetup'), msg = $('#mpdMsg'), skip = $('#mpdSkip'), done = $('#mpdDone');
  if (!btn) return { feed: () => false };
  let st = null;
  const label = id => { const a = actions.find(x => x.id === id); return a ? T(a.label) : id; };
  const show = () => {
    const on = !!(st && !st.done); skip.hidden = done.hidden = !on; btn.classList.toggle('on', on);
    msg.textContent = on ? T('Turn knob {a} (it becomes: {b}).').replace('{a}', st.i + 1).replace('{b}', label(st.steps[st.i])) : '';
  };
  const save = () => { S.midi.map = st.map; store.set('midi', S.midi.map); renderMidi(); };
  const finish = () => { const learned = st ? st.used.length : 0; st = null; show(); msg.textContent = T('MPD218 is ready: the pads are set up, and {a} knobs are learned. Change anything with Learn below.').replace('{a}', learned); };
  btn.onclick = async () => {
    if (!S.midi.access) await enableMidi();
    if (!S.midi.access) { msg.textContent = T('Turn on MIDI first (Chrome or Edge on a computer).'); return; }
    S.midi.learn = null; st = mpdWizardStart(mpdPadMap(S.midi.map, layout), layout); save(); show();
  };
  skip.onclick = () => { st = mpdWizardSkip(st); if (st.done) finish(); else show(); };
  done.onclick = () => finish();
  return {
    feed(m) {
      if (!st || st.done) return false;
      if (m.type !== 'cc') return false;   // pads keep working while you set up the knobs
      st = mpdWizardFeed(st, m); save(); if (st.done) finish(); else show(); return true;
    },
    get active() { return !!(st && !st.done); },
  };
}
