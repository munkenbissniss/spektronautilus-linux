// Sixteen looks for VJ loops (ten effects and six colour styles). Each one is a piece of an ffmpeg filter graph that is added after the picture has been
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
// ---- colour styles. Each one is a colour grade measured from a reference loop: the shadows, mid-tones and highlights are pushed
// to the same colours with one tone curve per channel (points are brightness in -> brightness out, 0..1). `keep` is how much of
// the clip's own colour survives before the curves (0 = one-colour look, 1 = all of it). The amount slider works like this:
// 0 = a light touch, 50 = the reference look, 100 = the reference look pushed further (stronger colour and contrast).
const pts = a => a.map(([x, y]) => `${x}/${y}`).join(' ');
const grade = ({ keep, r, g, b, contrast = 1, bright = 0, sat = 1 }) => a => {
  const op = r1(Math.min(1, 0.3 + 1.4 * a)), push = Math.max(0, a - 0.5);                  // push: 0 at the reference look, 0.5 at 100
  const eq = `eq=contrast=${r1((contrast + push * 0.5) * 100) / 100}:brightness=${r1(bright * 100) / 100}:saturation=${r1((sat + push * 0.8) * 100) / 100}`;
  return `split[fxa][fxb];[fxb]hue=s=${r1(keep * 100) / 100},${eq},curves=r='${pts(r)}':g='${pts(g)}':b='${pts(b)}'[fxg];[fxa][fxg]blend=all_expr='A+(B-A)*${op}'`;
};
const STYLES = [
  { id: 'bluedream', name: 'Blue Dream', desc: 'Deep blue and violet, with glowing pink and white highlights.',
    chain: grade({ keep: .55, r: [[0, .1], [.1, .18], [.45, .47], [.9, .93], [1, .97]], g: [[0, .03], [.1, .07], [.45, .42], [.9, .88], [1, .95]], b: [[0, .38], [.1, .6], [.45, .92], [.9, .99], [1, 1]] }) },
  { id: 'pinkdream', name: 'Pink Dream', desc: 'Dark plum shadows and cool blue lights. Soft and dreamy.',
    chain: grade({ keep: .45, r: [[0, .12], [.06, .19], [.3, .14], [.45, .32], [.9, .9], [1, .95]], g: [[0, .02], [.06, .06], [.3, .12], [.45, .37], [.9, .92], [1, 1]], b: [[0, .12], [.06, .19], [.3, .55], [.45, .89], [.9, 1], [1, 1]] }) },
  { id: 'darkfuture', name: 'Dark Future', desc: 'Icy blue, almost one colour, with crisp white highlights.',
    chain: grade({ keep: 0, r: [[0, 0], [.05, .02], [.45, .28], [.9, .87], [1, .93]], g: [[0, .03], [.05, .08], [.45, .45], [.9, .9], [1, .95]], b: [[0, .18], [.05, .26], [.45, .65], [.9, .91], [1, .95]] }) },
  { id: 'sepia', name: 'Sepia', desc: 'Warm, faded old-film tones with lifted blacks.',
    chain: grade({ keep: .1, r: [[0, .12], [.05, .16], [.45, .5], [.9, .88], [1, .92]], g: [[0, .1], [.05, .13], [.45, .45], [.9, .82], [1, .86]], b: [[0, .08], [.05, .1], [.45, .37], [.9, .71], [1, .74]] }) },
  { id: 'matrix', name: 'The Matrix', desc: 'Cold green-teal shadows and pale green highlights.',
    chain: grade({ keep: .6, sat: 1.1, r: [[0, 0], [.08, .03], [.45, .43], [.9, .8], [1, .85]], g: [[0, .02], [.08, .07], [.45, .47], [.9, .9], [1, .95]], b: [[0, .03], [.08, .09], [.45, .33], [.9, .68], [1, .72]] }) },
  { id: 'vegas', name: 'Las Vegas', desc: 'A dusty magenta night with teal glints. Soft and flat.',
    chain: grade({ keep: .5, r: [[0, .25], [.1, .29], [.45, .31], [1, .42]], g: [[0, .04], [.1, .1], [.45, .38], [1, .6]], b: [[0, .08], [.1, .16], [.45, .4], [1, .62]] }) },
];
FILTERS.push(...STYLES);
export const filterById = id => FILTERS.find(f => f.id === id);
// amount 0..100 as typed in the page
export function filterChain(id, amount, ctx) {
  const f = filterById(id); if (!f) throw new Error('Unknown filter ' + id);
  return f.chain(Math.min(1, Math.max(0, amount / 100)), ctx);
}
