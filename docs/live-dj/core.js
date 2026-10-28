// Pure logic for the Live Video DJ Mixer. No DOM here, so it can be tested in Node.
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ease = t => (t = clamp(t), t * t * (3 - 2 * t));            // smoothstep for automatic fades
const easeOut = t => 1 - Math.pow(1 - clamp(t), 3);

// Crossfader position f: 0 = only deck A, 1 = only deck B.
// Video: B is drawn over A with alpha f, which is an exact dissolve.
// Audio: equal power keeps the loudness steady through the middle; "linear" is the classic DJ cut-in.
export function audioGains(f, curve = 'power') {
  f = clamp(f);
  if (curve === 'linear') return { a: 1 - f, b: f };
  return { a: Math.cos(f * Math.PI / 2), b: Math.sin(f * Math.PI / 2) };
}

// Which deck is "on air": the one with more of the picture.
export const onAir = f => (f < 0.5 ? 'A' : 'B');

// An automatic fade. Returns the position at time t (ms) or null when finished.
export function autoFadePos(from, to, t, durMs) {
  if (durMs <= 0) return to;
  const p = clamp(t / durMs);
  return from + (to - from) * ease(p);
}

// Poster animation: slides in, holds, slides out. Returns {phase, p} where p is 0 (hidden) .. 1 (fully shown).
export function posterFrame(t, inMs = 700, holdMs = 6000, outMs = 600) {
  if (holdMs === Infinity) return t < inMs ? { phase: 'in', p: easeOut(t / inMs) } : { phase: 'hold', p: 1 };
  if (t < 0) return { phase: 'off', p: 0 };
  if (t < inMs) return { phase: 'in', p: easeOut(t / inMs) };
  if (t < inMs + holdMs) return { phase: 'hold', p: 1 };
  if (t < inMs + holdMs + outMs) return { phase: 'out', p: 1 - ease((t - inMs - holdMs) / outMs) };
  return { phase: 'off', p: 0 };
}

export const POSTER_COLORS = [
  { id: 'neon',  name: 'Neon pink',     bg: '#ff2d7a', fg: '#ffffff', accent: '#14182b' },
  { id: 'blue',  name: 'Electric blue', bg: '#2b3af0', fg: '#ffffff', accent: '#9fb0ff' },
  { id: 'mono',  name: 'Black & white', bg: '#ffffff', fg: '#000000', accent: '#000000' },
  { id: 'night', name: 'Night',         bg: '#0b0d1e', fg: '#ffffff', accent: '#ff3d81' },
  { id: 'gold',  name: 'Gold',          bg: '#ffc928', fg: '#1a1400', accent: '#1a1400' },
  { id: 'mint',  name: 'Mint',          bg: '#2de2b0', fg: '#04261c', accent: '#04261c' },
  { id: 'red',   name: 'Red alert',     bg: '#e11d2e', fg: '#ffffff', accent: '#ffffff' },
];

// "Artist - Title.mp4" -> {artist, title}. Falls back to the plain name.
export function parseTitle(filename) {
  let n = String(filename).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\d{1,3}[\s.)-]+(?=\D)/, '');             // "03 - " track numbers
  const m = n.split(/\s+[-–—]\s+/);
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { artist: '', title: n };
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// ---- MIDI ----
export function parseMidi(d) {
  if (!d || d.length < 2) return null;
  const st = d[0] & 0xf0, ch = d[0] & 0x0f;
  if (st === 0xb0) return { type: 'cc', ch, num: d[1], val: (d[2] ?? 0) / 127 };
  if (st === 0x90 && (d[2] ?? 0) > 0) return { type: 'note', ch, num: d[1], val: 1 };
  if (st === 0x80 || st === 0x90) return { type: 'noteoff', ch, num: d[1], val: 0 };
  return null;
}
export const midiKey = m => `${m.type === 'noteoff' ? 'note' : m.type}:${m.ch}:${m.num}`;

export const MIDI_ACTIONS = [
  { id: 'xfade', label: 'Crossfader', kind: 'fader' },
  { id: 'mix', label: 'Mix to other deck (auto fade)', kind: 'button' },
  { id: 'playA', label: 'Play / pause A', kind: 'button' },
  { id: 'playB', label: 'Play / pause B', kind: 'button' },
  { id: 'volA', label: 'Volume A', kind: 'fader' },
  { id: 'volB', label: 'Volume B', kind: 'fader' },
  { id: 'poster1', label: 'Poster slot 1', kind: 'button' },
  { id: 'poster2', label: 'Poster slot 2', kind: 'button' },
  { id: 'poster3', label: 'Poster slot 3', kind: 'button' },
  { id: 'poster4', label: 'Poster slot 4', kind: 'button' },
  { id: 'posterHide', label: 'Hide poster', kind: 'button' },
  { id: 'logo', label: 'Logo on / off', kind: 'button' },
];

// Which action does a message trigger? Returns {action, value} or null. Faders only react to cc; buttons to note-on or cc > 0.5.
export function routeMidi(msg, map, actions = MIDI_ACTIONS) {
  if (!msg) return null;
  const id = map[midiKey(msg)];
  if (!id) return null;
  const a = actions.find(x => x.id === id);
  if (!a) return null;
  if (a.kind === 'fader') return msg.type === 'cc' ? { action: id, value: msg.val } : null;
  if (msg.type === 'noteoff') return null;
  if (msg.type === 'cc' && msg.val < 0.5) return null;
  return { action: id, value: 1 };
}
