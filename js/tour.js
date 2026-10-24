// Walkthrough controller: picks a mode, maps scroll to progress, drives captions/UI.
// Modes:  3d      – Three.js scene (tier high/mid/low, auto-degrades if the frame rate drops)
//         images  – fading image + text sequence (prefers-reduced-motion)
//         static  – single hero image with the availability bar (no WebGL / load failure)
// Test overrides: ?tour=3d | lite | images | static  and  ?tier=high | mid | low
import { SCENE_COUNT, SCENE_NAMES, uiState, sceneProgress, clamp01, smooth } from './timeline.js';

const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js';
const LOAD_TIMEOUT = 15000;

const $ = (id) => document.getElementById(id);
const tour = $('tour');
const stage = $('tourStage');
let canvas = $('tourCanvas');
const loader = $('loader');
const loaderBar = $('loaderBar');
const fadeEl = $('tourFade');
const avail = $('availForm');
const hint = $('tourHint');
const dotsNav = $('tourDots');
const captions = [...document.querySelectorAll('.tour__caption')];
const images = [...document.querySelectorAll('.tour__img')];

const params = new URLSearchParams(location.search);
const forced = params.get('tour');
const reducedMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

let mode = null;
let world = null;
let target = 0, current = 0, raf = 0, lastT = 0, inView = true;
let slowFrames = 0, sampled = 0;

/* ---------- Loader ---------- */
const setLoader = (v) => { loaderBar.style.width = Math.round(clamp01(v) * 100) + '%'; };
function hideLoader() {
  loader.classList.add('is-done');
  loader.setAttribute('aria-hidden', 'true');
  setTimeout(() => loader.remove(), 900);
}

/* ---------- Dots + skip ---------- */
const dots = [];
for (let i = 0; i < SCENE_COUNT; i++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<span>${SCENE_NAMES[i]}</span>`;
  b.setAttribute('aria-label', `Go to scene: ${SCENE_NAMES[i]}`);
  b.addEventListener('click', () => scrollToProgress(sceneProgress(i), true));
  dotsNav.appendChild(b); dots.push(b);
}
function scrollRange() { return Math.max(1, tour.offsetHeight - stage.offsetHeight); }
function tourTop() { return tour.getBoundingClientRect().top + window.scrollY; }
function scrollToProgress(p, smoothScroll) {
  const top = tourTop() + p * scrollRange() + 2;
  window.scrollTo({ top, behavior: smoothScroll && !reducedMQ.matches ? 'smooth' : 'instant' });
}
$('tourSkip').addEventListener('click', () => {
  const rooms = $('rooms');
  const header = $('siteHeader');
  const y = rooms.getBoundingClientRect().top + window.scrollY - header.offsetHeight + 1;
  window.scrollTo({ top: y, behavior: 'instant' });
  rooms.setAttribute('tabindex', '-1');
  rooms.focus({ preventScroll: true });
});

/* ---------- Progress ---------- */
function measure() {
  if (mode === 'static') return 0;
  const r = tour.getBoundingClientRect();
  return clamp01(-r.top / scrollRange());
}

let lastActive = -1, lastEnd = null;
function applyUI(p) {
  const s = uiState(p);
  const moveFx = mode === '3d';
  for (let i = 0; i < SCENE_COUNT; i++) {
    const a = s.caption[i];
    const el = captions[i];
    el.style.opacity = a.toFixed(3);
    el.style.transform = moveFx ? `translate3d(0, ${((1 - a) * 18).toFixed(1)}px, 0)` : '';
    el.style.visibility = a > 0.001 ? 'visible' : 'hidden';
    if (mode === 'images') images[i].style.opacity = s.image[i].toFixed(3);
  }
  if (mode === '3d') {
    let f = 0;
    if (s.seg.kind === 'move' && s.seg.cut) f = smooth(0, 1, 1 - Math.abs(2 * s.t - 1));
    fadeEl.style.opacity = f.toFixed(3);
  }
  if (s.active !== lastActive) {
    dots.forEach((d, i) => { d.classList.toggle('is-active', i === s.active); d.setAttribute('aria-current', i === s.active ? 'step' : 'false'); });
    lastActive = s.active;
  }
  if (s.end !== lastEnd) {
    avail.classList.toggle('is-visible', s.end);
    avail.inert = !s.end;
    lastEnd = s.end;
  }
  hint.style.opacity = p < 0.015 ? '1' : '0';
}

function frame(now) {
  raf = 0;
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  if (mode === '3d') current += (target - current) * (1 - Math.exp(-dt * 7));
  else current = target;
  const settled = Math.abs(target - current) < 0.00003;
  if (settled) current = target;

  if (world) {
    world.render(current);
    // Adaptive quality: if frames are consistently slow while moving, step quality down.
    if (!settled) {
      sampled++;
      if (dt > 1 / 40) slowFrames++;
      if (sampled >= 45) {
        if (slowFrames > 28 && world.degrade()) console.info('[tour] lowering 3D quality');
        sampled = 0; slowFrames = 0;
      }
    }
  }
  applyUI(current);
  if (!settled && inView) raf = requestAnimationFrame(frame);
  else lastT = 0;
}
function kick() { if (!raf && inView) raf = requestAnimationFrame(frame); }
function onScroll() { target = measure(); kick(); }

/* ---------- Modes ---------- */
function loadImage(el) {
  if (el.dataset.loaded) return;
  el.dataset.loaded = '1';
  el.style.backgroundImage = `linear-gradient(180deg, rgba(23,9,8,.25), rgba(23,9,8,.1)), url("${el.dataset.src}")`;
}

function startImages() {
  mode = 'images';
  tour.classList.remove('tour--3d', 'tour--static');
  tour.classList.add('tour--images');
  loadImage(images[0]);
  const rest = () => images.forEach(loadImage);
  if ('requestIdleCallback' in window) requestIdleCallback(rest, { timeout: 2000 }); else setTimeout(rest, 800);
  setLoader(1);
  setTimeout(hideLoader, 350);
  bind();
}

function startStatic(reason) {
  if (reason) console.warn('[tour] using static hero:', reason);
  mode = 'static';
  if (world) { try { world.dispose(); } catch (e) { /* ignore */ } world = null; }
  tour.classList.remove('tour--3d', 'tour--images');
  tour.classList.add('tour--static');
  loadImage(images[0]);
  captions.forEach((c, i) => { c.style.opacity = i === 0 ? '1' : '0'; c.style.visibility = i === 0 ? 'visible' : 'hidden'; c.style.transform = ''; });
  fadeEl.style.opacity = '0';
  avail.classList.add('is-visible');
  avail.inert = false;
  setLoader(1);
  hideLoader();
}

function freshCanvas() {
  const c = canvas.cloneNode(false);
  canvas.replaceWith(c);
  canvas = c;
}

function pickTier() {
  if (forced === 'lite') return 'low';
  const asked = params.get('tier');
  if (['high', 'mid', 'low'].includes(asked)) return asked;
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  const conn = navigator.connection;
  if (conn && conn.saveData) return 'low';
  if ((mem && mem <= 2) || (cores && cores <= 4)) return 'low';
  const mobile = window.matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 820;
  if (mobile || (mem && mem <= 4)) return 'mid';
  return 'high';
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

async function start3D() {
  mode = '3d';
  tour.classList.add('tour--3d');
  setLoader(0.08);
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('load timeout')), LOAD_TIMEOUT); });
  let THREE, mod;
  try {
    [THREE, mod] = await Promise.race([Promise.all([import(THREE_URL), import('./scene3d.js')]), timeout]);
  } catch (e) {
    clearTimeout(timer);
    return startStatic(e.message || e);
  }
  setLoader(0.4);

  const first = pickTier();
  const tiers = first === 'low' ? ['low'] : [first, 'low'];
  for (const tier of tiers) {
    try {
      world = await Promise.race([
        mod.createWorld(THREE, canvas, { tier, strict: forced !== '3d', onProgress: (v) => setLoader(0.4 + v * 0.6) }),
        timeout,
      ]);
      break;
    } catch (e) {
      console.warn(`[tour] 3D tier "${tier}" failed:`, e && e.message);
      world = null;
      freshCanvas();
    }
  }
  clearTimeout(timer);
  if (!world || mode !== '3d') return startStatic('WebGL unavailable');
  tour.dataset.tier = world.tier;

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); startStatic('context lost'); }, { once: true });
  bind();
  target = current = measure();
  world.render(current);
  applyUI(current);
  hideLoader();
}

let bound = false;
function bind() {
  if (bound) return;
  bound = true;
  window.addEventListener('scroll', onScroll, { passive: true });
  let rt = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => { if (world && mode === '3d') world.resize(); onScroll(); if (world) world.render(current); });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      inView = entries[0].isIntersecting;
      if (inView) onScroll();
    }, { rootMargin: '100px 0px' }).observe(tour);
  }
  target = current = measure();
  applyUI(current);
}

/* ---------- Boot ---------- */
function boot() {
  if (forced === 'static') return startStatic();
  if (forced === 'images' || (reducedMQ.matches && forced !== '3d' && forced !== 'lite')) return startImages();
  if (!webglAvailable()) return startStatic('no WebGL');
  start3D();
}
boot();

// Safety net: never leave the loader up
setTimeout(() => { if (loader.isConnected && !loader.classList.contains('is-done')) startStatic('slow start'); }, LOAD_TIMEOUT + 4000);
