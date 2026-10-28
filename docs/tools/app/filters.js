// Ten looks for VJ loops. Each one is a piece of an ffmpeg filter graph that is added after the picture has been
// scaled to its final size. `amount` is 0..1. `w`/`h` are the final picture size, `dur` is the clip length in seconds.
// The pieces are written so a clip that loops keeps looping: the colour cycle goes round exactly once per clip, and
// nothing else depends on how long the clip has been playing.
const r1 = x => Math.round(x * 10) / 10;
const sc = (w, px) => Math.max(1, Math.round(px * (w / 1280)));          // sizes in "pixels at 1280 wide" -> real pixels

export const FILTERS = [
  { id: 'neon', name: 'Neon glow', desc: 'Bright parts bloom into a soft glow.',
    chain: (a, { w }) => `split[fxa][fxb];[fxb]gblur=sigma=${r1(sc(w, 5 + a * 30))},eq=brightness=${r1(0.02 + a * 0.08)}:saturation=${r1(1.4 + a * 0.8)}[fxg];[fxa][fxg]blend=all_mode=screen:all_opacity=${r1(0.6 + a * 0.4)}` },
  { id: 'rgb', name: 'RGB split', desc: 'Red and blue drift apart, like a glitchy lens.',
    chain: (a, { w }) => `rgbashift=rh=${-sc(w, 2 + a * 18)}:bh=${sc(w, 2 + a * 18)}` },
  { id: 'mirror', name: 'Mirror', desc: 'The left half is mirrored onto the right.',
    chain: (a, { w, h }) => `split[fxa][fxb];[fxa]crop=iw/2:ih:0:0[fxl];[fxb]crop=iw/2:ih:0:0,hflip[fxr];[fxl][fxr]hstack,scale=${w}:${h}` },
  { id: 'kaleido', name: 'Kaleidoscope', desc: 'One quarter of the picture, mirrored four ways.',
    chain: (a, { w, h }) => `crop=iw/2:ih/2:0:0,split[fxq1][fxq2];[fxq2]hflip[fxq3];[fxq1][fxq3]hstack,split[fxh1][fxh2];[fxh2]vflip[fxh3];[fxh1][fxh3]vstack,scale=${w}:${h}` },
  { id: 'vhs', name: 'VHS glitch', desc: 'Tape noise, colour bleed and a bit too much saturation.',
    chain: (a, { w }) => `noise=alls=${Math.round(6 + a * 30)}:allf=t,rgbashift=rh=${-sc(w, 1 + a * 5)}:bh=${sc(w, 1 + a * 5)},eq=saturation=${r1(1.2 + a * 0.5)}:contrast=${r1(1.03 + a * 0.1)}` },
  { id: 'pixel', name: 'Pixelate', desc: 'Big chunky pixels.',
    chain: (a, { w, h }) => { const b = sc(w, 8 + a * 56); return `scale=trunc(iw/${b}):trunc(ih/${b}):flags=neighbor,scale=${w}:${h}:flags=neighbor`; } },
  { id: 'hue', name: 'Colour cycle', desc: 'Colours go round the whole wheel once per loop.',
    chain: (a, { dur }) => `hue=h='360*t/${r1(Math.max(0.5, dur || 8))}':s=${r1(1 + a * 0.6)}` },
  { id: 'duo', name: 'Duotone', desc: 'Deep blue shadows, hot pink highlights.',
    chain: a => `hue=s=0,eq=contrast=${r1(1 + a)},curves=r='0/0.05 1/1':g='0/0 1/0.2':b='0/0.25 1/0.6'` },
  { id: 'edges', name: 'Edge glow', desc: 'Only the outlines are left, in colour.',
    chain: a => `edgedetect=low=${r1(0.04 + (1 - a) * 0.06)}:high=${r1(0.35 - a * 0.22)}:mode=colormix,eq=brightness=0.02:saturation=1.6` },
  { id: 'trails', name: 'Trails', desc: 'Moving things leave a soft trail behind.',
    chain: a => `tmix=frames=${2 + Math.round(a * 10)}` },
];
export const filterById = id => FILTERS.find(f => f.id === id);
// amount 0..100 as typed in the page
export function filterChain(id, amount, ctx) {
  const f = filterById(id); if (!f) throw new Error('Unknown filter ' + id);
  return f.chain(Math.min(1, Math.max(0, amount / 100)), ctx);
}
