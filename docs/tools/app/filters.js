// Twenty looks for VJ loops (twelve effects and eight colour styles). Each one is a piece of an ffmpeg filter graph that is added after the picture has been
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
  { id: 'invert', name: 'Invert', desc: 'Negative: dark becomes light and every colour flips to its opposite.',
    chain: () => 'negate' },
  { id: 'polarize', name: 'Polarize', desc: 'Only the bright parts flip to negative, like a solarised photo. The slider sets how much of the picture flips.',
    chain: a => { const t = r1(0.8 - a * 0.6); return `lutrgb=r='ifnot(gt(val,maxval*${t}),val,maxval-val)':g='ifnot(gt(val,maxval*${t}),val,maxval-val)':b='ifnot(gt(val,maxval*${t}),val,maxval-val)'`; } },
];
// ---- colour styles. Each one is measured from a reference loop. Most are "gradient maps": the picture is turned into brightness, and
// each brightness gets the colour the reference has there (stops are brightness 0..1 -> red, green, blue). A few keep the clip's own
// colours and only lift the blacks to a tint. `keep` is how much of the clip's own colour survives before the curves (0 = none).
// The amount slider: 0 = a light touch, 50 = the reference look, 100 = the reference look pushed further (more colour and contrast).
const ch = (stops, i) => stops.map(s => `${s[0]}/${s[i]}`).join(' ');
const grade = ({ keep, stops, contrast = 1, sat = 1, grain = 0 }) => a => {
  const op = r1(Math.min(1, 0.3 + 1.4 * a)), push = Math.max(0, a - 0.5);                  // push: 0 at the reference look, 0.5 at 100
  const eq = `eq=contrast=${Math.round((contrast + push * 0.5) * 100) / 100}:saturation=${Math.round((sat + push * 0.8) * 100) / 100}`;
  return `split[fxa][fxb];[fxb]hue=s=${Math.round(keep * 100) / 100},${eq},curves=r='${ch(stops, 1)}':g='${ch(stops, 2)}':b='${ch(stops, 3)}'${grain ? `,format=yuv444p,noise=c0s=${Math.round(grain * (0.4 + 1.2 * a))}:c0f=t+u` : ''}[fxg];[fxa][fxg]blend=all_expr='A+(B-A)*${op}'`;
};
const STYLES = [
  { id: 'bluedream', name: 'Blue Dream', desc: 'Deep navy shadows with vivid cyan, red and white colours.',
    chain: grade({ keep: 1, contrast: 1.25, sat: 1.5, stops: [[0, 0, .02, .4], [1, 1, 1, 1]] }) },
  { id: 'purpledream', name: 'Purple Dream', desc: 'Dusky plum shadows, with bright and saturated colours.',
    chain: grade({ keep: 1, sat: 1.35, stops: [[0, .3, .08, .21], [1, 1, 1, 1]] }) },
  { id: 'darkfuture', name: 'Dark Future', desc: 'Black and cold mint-green, with pale highlights.',
    chain: grade({ keep: 0, contrast: 1.1, stops: [[0, 0, .01, .02], [.07, .04, .07, .1], [.15, .12, .16, .23], [.275, .2, .26, .36], [.425, .33, .44, .46], [.575, .45, .62, .58], [.725, .58, .8, .71], [.85, .64, .9, .76], [.95, .93, .97, .92], [1, .96, .99, .95]] }) },
  { id: 'sepia', name: 'Sepia', desc: 'Soft, warm black and white with lifted blacks.',
    chain: grade({ keep: 0, stops: [[0, .1, .08, .06], [.07, .11, .09, .07], [.15, .15, .13, .12], [.275, .29, .26, .23], [.425, .45, .43, .4], [.575, .62, .59, .55], [.725, .77, .74, .71], [.85, .87, .84, .82], [1, .94, .91, .9]] }) },
  { id: 'matrix', name: 'The Matrix', desc: 'Black to pale green, like an old monitor.',
    chain: grade({ keep: 0, contrast: 1.1, stops: [[0, 0, .01, .02], [.07, .04, .07, .08], [.15, .11, .15, .16], [.275, .22, .27, .29], [.425, .36, .43, .42], [.575, .51, .6, .55], [.725, .63, .76, .69], [.85, .7, .9, .78], [.95, .93, .97, .92], [1, .96, .99, .95]] }) },
  { id: 'vegas', name: 'Las Vegas', desc: 'Maroon and violet shadows melting into hot pink and cream.',
    chain: grade({ keep: 0, contrast: 1.1, stops: [[0, .2, 0, 0], [.07, .28, 0, 0], [.15, .29, .01, .64], [.275, .86, .06, .61], [.425, .83, .29, .64], [.575, .9, .48, .65], [.725, .96, .67, .66], [.85, 1, .84, .66], [.95, .99, 1, .65], [1, 1, 1, .7]] }) },
  { id: 'grainy', name: 'Grainy', desc: 'A film look: cool navy shadows, warm highlights and a little moving grain.',
    chain: grade({ keep: .7, grain: 12, contrast: .95, stops: [[0, .04, .07, .11], [.09, .05, .09, .12], [.3, .2, .27, .36], [.55, .56, .52, .49], [.8, .92, .79, .66], [1, 1, .93, .82]] }) },
  { id: 'coal', name: 'Coal', desc: 'Dark, cool and matte, like a night-time film still.',
    chain: grade({ keep: .15, stops: [[0, .02, .02, .03], [.02, .03, .03, .04], [.07, .07, .07, .07], [.15, .15, .15, .16], [.275, .28, .29, .33], [.425, .4, .38, .4], [.575, .55, .54, .52], [.725, .66, .65, .63], [.85, .72, .71, .69], [1, .78, .77, .75]] }) },
];
FILTERS.push(...STYLES);
export const filterById = id => FILTERS.find(f => f.id === id);
// amount 0..100 as typed in the page
export function filterChain(id, amount, ctx) {
  const f = filterById(id); if (!f) throw new Error('Unknown filter ' + id);
  return f.chain(Math.min(1, Math.max(0, amount / 100)), ctx);
}
