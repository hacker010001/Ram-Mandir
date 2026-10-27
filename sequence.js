/* =========================================================
   AURORA — cinematic scroll-linked frame sequence
   Background layer only. The hero layout and styles are
   untouched; this script only paints the canvas behind it.
   ========================================================= */

(() => {
  "use strict";

  const TOTAL = 240;
  const PARALLEL = 6;
  const AHEAD = 14;
  const BEHIND = 5;
  const DPR_CAP = 2;
  const BG = "#090603";
  const EASE = 0.011; // exponential smoothing per millisecond

  const AUTO_DELAY = 2000;      // idle time before the sequence finishes itself
  const AUTO_FPS = 30;          // playback speed once it takes over
  const PARALLAX_EASE = 0.006;  // pointer-follow smoothing per millisecond
  const PARALLAX_SCALE = 1.04;  // overscan so parallax never reveals an edge
  const PARALLAX_X = 1.2;       // max horizontal drift, % of canvas width
  const PARALLAX_Y = 0.8;       // max vertical drift, % of canvas height

  const track = document.querySelector(".scroll-track");
  const viewport = document.querySelector(".sticky-viewport");
  const canvas = document.getElementById("hero-canvas");
  if (!track || !viewport || !canvas) return;

  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const images = new Array(TOTAL);
  const state = new Uint8Array(TOTAL); // 0 idle · 1 loading/loaded · 2 queued · 3 failed
  const ready = new Uint8Array(TOTAL);

  const urgent = [];
  const coarse = [];
  for (let i = 0; i < TOTAL; i += 8) coarse.push(i);

  let coarseCursor = 0;
  let fillCursor = 0;
  let inflight = 0;
  let preloadingPaused = false;

  let target = 0;
  let current = 0;
  let needsPaint = true;
  let firstShown = false;

  let hasScrolled = false;
  let autoPlaying = false;
  let autoDone = false;
  let autoFrame = -1;
  let autoLockProgress = 0;
  let idleTimer = 0;

  let px = 0;
  let py = 0;
  let pointerX = 0;
  let pointerY = 0;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let trackTop = 0;
  let travel = 1;

  let lastPriority = 0;
  let priorityDir = 1;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motionQuery.matches;

  const parallaxQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  let parallaxCapable = parallaxQuery.matches;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const source = (i) => `frames/ezgif-frame-${String(i + 1).padStart(3, "0")}.jpg`;

  /* ───────────────────────── loading ───────────────────────── */

  function beginLoad(i) {
    state[i] = 1;
    inflight += 1;

    const img = new Image();
    img.decoding = "async";
    images[i] = img;

    img.onload = () => {
      inflight -= 1;
      ready[i] = 1;

      // repaint only when this frame can actually change what is on screen;
      // background preloading should not keep repainting the still frame
      const base = Math.floor(current);
      if (!firstShown || (i >= base - 1 && i <= base + 2)) needsPaint = true;

      pump();
    };

    img.onerror = () => {
      inflight -= 1;
      state[i] = 3;
      pump();
    };

    img.src = source(i);
  }

  function nextBackground() {
    while (coarseCursor < coarse.length) {
      const i = coarse[coarseCursor++];
      if (state[i] === 0) return i;
    }
    while (fillCursor < TOTAL) {
      const i = fillCursor++;
      if (i % 8 !== 0 && state[i] === 0) return i;
    }
    return -1;
  }

  function pump() {
    if (preloadingPaused) return;

    while (inflight < PARALLEL) {
      let i = -1;

      while (urgent.length) {
        const candidate = urgent.shift();
        if (state[candidate] === 2) {
          i = candidate;
          break;
        }
      }

      if (i < 0) i = nextBackground();
      if (i < 0) break;

      beginLoad(i);
    }
  }

  function prioritize(index) {
    const center = clamp(Math.round(index), 0, TOTAL - 1);

    if (center !== lastPriority) {
      priorityDir = center > lastPriority ? 1 : -1;
      lastPriority = center;
    }

    const queue = (i) => {
      if (i < 0 || i >= TOTAL || state[i] !== 0) return;
      state[i] = 2;
      urgent.push(i);
    };

    queue(Math.round(current));
    queue(center);

    for (let d = 1; d <= AHEAD; d += 1) {
      queue(center + d * priorityDir);
      if (d <= BEHIND) queue(center - d * priorityDir);
    }

    // During a fast scrub, warm the frames between the playhead
    // and the target so the eased pass never lands on a blank frame.
    const from = Math.min(current, center);
    const to = Math.max(current, center);
    if (to - from > 2) {
      const step = to - from > 48 ? 4 : 2;
      for (let i = Math.ceil(from); i <= to; i += step) queue(i);
    }

    pump();
  }

  /* ───────────────────────── rendering ───────────────────────── */

  function reveal() {
    if (firstShown) return;
    firstShown = true;
    canvas.classList.add("is-ready");
  }

  function drawCover(img, alpha) {
    const iw = img.naturalWidth || 1280;
    const ih = img.naturalHeight || 720;
    if (!iw || !ih) return;

    const scale = Math.max(width / iw, height / ih);
    const dw = iw * scale;
    const dh = ih * scale;

    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (width - dw) * 0.5, (height - dh) * 0.5, dw, dh);
    ctx.globalAlpha = 1;
  }

  function nearestReady(index) {
    if (ready[index]) return index;
    for (let r = 1; r < TOTAL; r += 1) {
      const before = index - r;
      const after = index + r;
      if (before >= 0 && ready[before]) return before;
      if (after < TOTAL && ready[after]) return after;
    }
    return -1;
  }

  function paint() {
    if (!width || !height) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    const base = Math.floor(current);
    const next = base + 1;
    const fraction = current - base;
    const hasBase = base >= 0 && base < TOTAL && ready[base] === 1;
    const hasNext = next < TOTAL && ready[next] === 1;
    let exact = false;

    if (hasBase) {
      drawCover(images[base], 1);
      if (hasNext && fraction > 0.004) drawCover(images[next], fraction);
      exact = true;
    } else if (hasNext) {
      drawCover(images[next], 1);
      exact = true;
    } else {
      const near = nearestReady(clamp(Math.round(current), 0, TOTAL - 1));
      if (near >= 0) drawCover(images[near], 1);
    }

    // only reveal once a frame at (or immediately beside) the playhead
    // is ready — a restored mid-page load never flashes frame 1
    if (exact) reveal();

    needsPaint = false;
  }

  /* ─────────────────────── scroll → frame ─────────────────────── */

  function measure() {
    const vh = viewport.getBoundingClientRect().height || window.innerHeight;

    trackTop = track.getBoundingClientRect().top + window.scrollY;
    travel = Math.max(1, track.offsetHeight - vh);

    const cssW = Math.max(1, viewport.clientWidth);
    const cssH = Math.max(1, vh);
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);

    if (bw !== width || bh !== height) {
      width = bw;
      height = bh;
      canvas.width = bw;
      canvas.height = bh;
    }
  }

  function scrollProgress() {
    return clamp((window.scrollY - trackTop) / travel, 0, 1);
  }

  function updateTarget() {
    if (reduced) {
      target = 0;
      current = 0;
      needsPaint = true;
      return;
    }

    // while the film is finishing itself, scroll mapping is suspended
    if (autoPlaying) {
      prioritize(target);
      return;
    }

    const progress = scrollProgress();
    let nextTarget = progress * (TOTAL - 1);

    if (autoDone) {
      // after the idle take-over the last frame stays on screen while the
      // page keeps scrolling down; scrolling back up hands control back
      if (progress >= 0.995 || progress <= autoLockProgress - 0.012) {
        autoDone = false;
      } else {
        nextTarget = TOTAL - 1;
      }
    }

    if (Math.abs(nextTarget - target) > 0.0001) {
      target = nextTarget;
      needsPaint = true;
    }

    prioritize(target);
  }

  /* ───────────────────── idle auto-play ───────────────────── */

  function clearIdleTimer() {
    if (!idleTimer) return;
    window.clearTimeout(idleTimer);
    idleTimer = 0;
  }

  function tryAutoPlay() {
    idleTimer = 0;

    if (reduced || autoPlaying || autoDone || !hasScrolled || document.hidden) return;

    const progress = scrollProgress();
    if (progress <= 0.01 || progress >= 0.995) return;

    autoPlaying = true;
    autoFrame = Math.max(current, target);
    needsPaint = true;
  }

  function scheduleAutoPlay() {
    clearIdleTimer();

    if (reduced || autoPlaying || autoDone || !hasScrolled) return;

    const progress = scrollProgress();
    if (progress <= 0.01 || progress >= 0.995) return;

    idleTimer = window.setTimeout(tryAutoPlay, AUTO_DELAY);
  }

  /* ─────────────────────── pointer parallax ─────────────────────── */

  function applyParallax() {
    if (reduced || !parallaxCapable) {
      canvas.style.transform = "";
      return;
    }

    canvas.style.transform =
      `translate3d(${px.toFixed(2)}%, ${py.toFixed(2)}%, 0) scale(${PARALLAX_SCALE})`;
  }

  function resetParallax() {
    pointerX = 0;
    pointerY = 0;
  }

  function clearParallax() {
    px = 0;
    py = 0;
    resetParallax();
    applyParallax();
  }

  function onPointerMove(event) {
    if (reduced || !parallaxCapable) return;

    const rect = viewport.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    pointerX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    pointerY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  }

  function onParallaxChange() {
    parallaxCapable = parallaxQuery.matches;

    if (!parallaxCapable || reduced) {
      px = 0;
      py = 0;
      resetParallax();
      canvas.style.transform = "";
    } else {
      applyParallax();
    }
  }

  /* ───────────────────────── scroll events ───────────────────────── */

  function onScroll() {
    hasScrolled = true;

    if (autoPlaying) {
      autoPlaying = false;
      autoFrame = -1;
    }

    updateTarget();
    scheduleAutoPlay();
  }

  let resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      measure();
      updateTarget();
      paint();
    });
  }

  function onMotionChange() {
    reduced = motionQuery.matches;

    if (reduced) {
      preloadingPaused = true;
      clearIdleTimer();
      autoPlaying = false;
      autoDone = false;
      autoFrame = -1;
      target = 0;
      current = 0;
      clearParallax();
      needsPaint = true;
      paint();
    } else {
      preloadingPaused = false;
      onResize();
      if (parallaxCapable) applyParallax();
      scheduleAutoPlay();
    }
  }

  /* ───────────────────────── rAF loop ───────────────────────── */

  let lastTime = 0;

  function tick(now) {
    if (!lastTime) lastTime = now;
    const dt = Math.min(64, Math.max(0, now - lastTime));
    lastTime = now;

    if (!reduced) {
      // idle take-over: advance the frame target only, never the page scroll
      if (autoPlaying) {
        autoFrame = Math.min(TOTAL - 1, autoFrame + (dt / 1000) * AUTO_FPS);
        target = autoFrame;
        needsPaint = true;
        prioritize(target);

        if (autoFrame >= TOTAL - 1) {
          target = TOTAL - 1;
          autoPlaying = false;
          autoDone = true;
          autoLockProgress = scrollProgress();
        }
      }

      const delta = target - current;
      if (Math.abs(delta) > 0.0005) {
        const ease = 1 - Math.exp(-dt * EASE);
        current += delta * ease;
        if (Math.abs(target - current) < 0.0015) current = target;
        needsPaint = true;
      }

      // pointer parallax: eased drift, small enough to stay behind the type
      if (parallaxCapable) {
        const wantX = pointerX * PARALLAX_X;
        const wantY = pointerY * PARALLAX_Y;
        const dx = wantX - px;
        const dy = wantY - py;

        if (Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005) {
          const ease = 1 - Math.exp(-dt * PARALLAX_EASE);
          px += dx * ease;
          py += dy * ease;
          if (Math.abs(wantX - px) < 0.002) px = wantX;
          if (Math.abs(wantY - py) < 0.002) py = wantY;
          applyParallax();
        }
      }
    }

    if (needsPaint) paint();

    requestAnimationFrame(tick);
  }

  /* ───────────────────────── boot ───────────────────────── */

  function boot() {
    reduced = motionQuery.matches;
    parallaxCapable = parallaxQuery.matches;
    preloadingPaused = reduced;

    measure();

    if (reduced) {
      beginLoad(0);
    } else {
      updateTarget();
      current = target;
    }

    if (parallaxCapable && !reduced) applyParallax();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("pageshow", onScroll);
    window.addEventListener("blur", resetParallax);

    // only the hero layer reacts to the pointer; the copy and controls
    // above it are untouched
    viewport.addEventListener("pointermove", onPointerMove, { passive: true });
    viewport.addEventListener("pointerleave", resetParallax);
    viewport.addEventListener("pointercancel", resetParallax);

    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", onMotionChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(onMotionChange);
    }

    if (typeof parallaxQuery.addEventListener === "function") {
      parallaxQuery.addEventListener("change", onParallaxChange);
    } else if (typeof parallaxQuery.addListener === "function") {
      parallaxQuery.addListener(onParallaxChange);
    }

    if ("ResizeObserver" in window) {
      new ResizeObserver(onResize).observe(viewport);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearIdleTimer();
        autoPlaying = false;
        autoFrame = -1;
        return;
      }

      needsPaint = true;
      updateTarget();
      scheduleAutoPlay();
    });

    requestAnimationFrame(tick);
  }

  boot();
})();