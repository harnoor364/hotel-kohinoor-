// Shared walkthrough timeline: 7 scenes ("holds") joined by 6 camera moves.
// Scroll progress 0..1 maps onto these weighted segments.
export const SCENE_COUNT = 7;
export const SCENE_NAMES = ['Exterior', 'Lobby', 'Corridor', 'Guest room', 'Banquet hall', 'Groove Restobar', 'Check availability'];

const HOLD = [1.3, 1.0, 1.0, 1.1, 1.1, 1.1, 1.4];
// cut = fade through dark instead of a continuous camera glide
const MOVE = [
  { w: 1.1, cut: false }, // exterior -> lobby (through the entrance)
  { w: 0.8, cut: false }, // lobby -> corridor
  { w: 0.9, cut: false }, // corridor -> room (through the door)
  { w: 0.7, cut: true },  // room -> banquet
  { w: 0.7, cut: true },  // banquet -> restobar
  { w: 0.8, cut: true },  // restobar -> exterior pull-back
];

export const SEGMENTS = (() => {
  const segs = [];
  let acc = 0;
  for (let i = 0; i < SCENE_COUNT; i++) {
    segs.push({ kind: 'hold', i, start: acc, len: HOLD[i] });
    acc += HOLD[i];
    if (i < SCENE_COUNT - 1) {
      segs.push({ kind: 'move', i, cut: MOVE[i].cut, start: acc, len: MOVE[i].w });
      acc += MOVE[i].w;
    }
  }
  segs.forEach((s) => { s.start /= acc; s.len /= acc; s.end = s.start + s.len; });
  return segs;
})();

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export function locate(p) {
  p = clamp01(p);
  for (const s of SEGMENTS) {
    if (p <= s.end) return { seg: s, t: s.len ? clamp01((p - s.start) / s.len) : 0 };
  }
  const last = SEGMENTS[SEGMENTS.length - 1];
  return { seg: last, t: 1 };
}

const holdSeg = (i) => SEGMENTS.find((s) => s.kind === 'hold' && s.i === i);

// Progress value to jump to for scene i (a little into its hold so the caption is visible)
export function sceneProgress(i) {
  const s = holdSeg(i);
  if (i === 0) return 0;
  if (i === SCENE_COUNT - 1) return 1;
  return s.start + s.len * 0.5;
}

// Per-scene caption opacity, image-layer opacity, active scene and end-bar visibility
export function uiState(p) {
  const { seg, t } = locate(p);
  const caption = new Array(SCENE_COUNT).fill(0);
  const image = new Array(SCENE_COUNT).fill(0);
  let active;
  if (seg.kind === 'hold') {
    const i = seg.i;
    const fin = i === 0 ? 1 : smooth(0, 0.2, t);
    const fout = i === SCENE_COUNT - 1 ? 1 : 1 - smooth(0.8, 1, t);
    caption[i] = fin * fout;
    image[i] = 1;
    active = i;
  } else {
    image[seg.i] = 1 - smooth(0.15, 0.85, t);
    image[seg.i + 1] = 1 - image[seg.i];
    active = t < 0.5 ? seg.i : seg.i + 1;
  }
  const end = seg.kind === 'hold' && seg.i === SCENE_COUNT - 1 && t > 0.25;
  return { caption, image, active, end, seg, t };
}

// Door at the end of the corridor opens during the second half of the corridor scene
export function doorOpen(p) {
  const s = holdSeg(2);
  return smooth(s.start + s.len * 0.45, s.end, p);
}
