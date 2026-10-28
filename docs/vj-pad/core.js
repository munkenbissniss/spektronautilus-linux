// Pure logic for the VJ mixer (Spektropad). Shares the fade, poster and MIDI helpers with the Live DJ mixer.
import { clamp, ease, posterFrame, POSTER_COLORS, parseTitle, fmtTime, autoFadePos, parseMidi, midiKey, routeMidi } from '../live-dj/core.js';
export { clamp, ease, posterFrame, POSTER_COLORS, parseTitle, fmtTime, autoFadePos, parseMidi, midiKey, routeMidi };

export const PADS = 20;
// Keyboard layout (by physical key, so it works on any keyboard language): two rows of ten = 20 pads.
export const PAD_CODES = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP'];
export const PAD_LABELS = ['1','2','3','4','5','6','7','8','9','0','Q','W','E','R','T','Y','U','I','O','P'];
export const LAYER_CODES = ['KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN'];                  // A1 A2 A3 B1 B2 B3
export const FX_CODES = ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK'];

export const BLENDS = [['source-over', 'Normal'], ['lighter', 'Add'], ['screen', 'Screen'], ['multiply', 'Multiply']];

export const FX = [
  { id: 'zoom', name: 'Zoom' }, { id: 'shake', name: 'Shake' }, { id: 'flash', name: 'Flash' }, { id: 'strobe', name: 'Strobe' },
  { id: 'invert', name: 'Invert' }, { id: 'mirror', name: 'Mirror' }, { id: 'hue', name: 'Colour spin' }, { id: 'blur', name: 'Blur' },
];

// Tap tempo. `times` are tap times in ms. Returns bpm or null. Old taps (after a pause longer than 2 s) are ignored.
export function tapBpm(times) {
  const t = times.slice(-8); let start = 0;
  for (let i = t.length - 1; i > 0; i--) if (t[i] - t[i - 1] > 2000) { start = i; break; }
  const use = t.slice(start); if (use.length < 2) return null;
  const d = []; for (let i = 1; i < use.length; i++) d.push(use[i] - use[i - 1]);
  d.sort((a, b) => a - b); const med = d[Math.floor(d.length / 2)];
  let bpm = 60000 / med; while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2;   // keep it in a playable range
  return Math.round(bpm * 10) / 10;
}

// Where are we in the beat? Returns beats since the last trigger (0 .. every). Triggers happen on every `every`-th beat.
export function beatPos(now, t0, period, every = 1) {
  const b = (now - t0) / period; const m = ((b % every) + every) % every; return m;
}
// Shape of one pulse: 1 at the trigger, falls to 0 after one beat.
export const pulse = ph => (ph >= 1 ? 0 : Math.pow(1 - clamp(ph), 2));

// Kick detector for audio input. Feed it the low-frequency energy (0..1) about 60 times per second.
export class KickDetector {
  constructor({ sensitivity = 0.5, refractoryMs = 220 } = {}) { this.avg = 0; this.last = -1e9; this.s = sensitivity; this.ref = refractoryMs; }
  feed(e, now) {
    const thr = Math.max(0.04, this.avg * (1.25 + (1 - this.s) * 0.9) + 0.02 * (1 - this.s));
    const hit = e > thr && now - this.last > this.ref && e > this.avg + 0.03;
    this.avg += (e - this.avg) * (e > this.avg ? 0.08 : 0.02);
    if (hit) this.last = now;
    return hit;
  }
}
// Tempo from kick times (ms): median interval, folded into 70..180.
export const bpmFromKicks = ks => (ks.length < 4 ? null : tapBpm(ks));

export const VJ_MIDI_ACTIONS = [
  { id: 'xfade', label: 'Crossfader', kind: 'fader' },
  { id: 'mix', label: 'Mix to other channel (auto fade)', kind: 'button' },
  { id: 'tap', label: 'Tap tempo', kind: 'button' },
  { id: 'beat1', label: 'Set beat 1 (downbeat)', kind: 'button' },
  { id: 'fxAmount', label: 'Effect amount', kind: 'fader' },
  ...FX.map((f, i) => ({ id: 'fx' + (i + 1), label: `Effect: ${f.name}`, kind: 'button' })),
  ...Array.from({ length: PADS }, (_, i) => ({ id: 'pad' + (i + 1), label: `Pad ${i + 1}`, kind: 'button' })),
  ...['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].map((n, i) => ({ id: 'sel' + (i + 1), label: `Select layer ${n}`, kind: 'button' })),
  ...['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].map((n, i) => ({ id: 'op' + (i + 1), label: `Opacity layer ${n}`, kind: 'fader' })),
  { id: 'poster1', label: 'Poster slot 1', kind: 'button' }, { id: 'poster2', label: 'Poster slot 2', kind: 'button' },
  { id: 'poster3', label: 'Poster slot 3', kind: 'button' }, { id: 'poster4', label: 'Poster slot 4', kind: 'button' },
  { id: 'posterHide', label: 'Hide poster', kind: 'button' }, { id: 'logo', label: 'Logo on / off', kind: 'button' },
];
