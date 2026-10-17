// Manual browsing temporarily yields to the reader; ordinary playback resumes
// following once the gesture and its momentum have been idle for a moment.
export function createSubtitleFollow({ onFollow, canResume = () => true, timers = globalThis, delay = 3000 }) {
  let enabled = true, timer;
  const holds = new Set();
  const cancel = () => { timers.clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (holds.size || !canResume()) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (holds.size || !canResume()) return;
      enabled = true; onFollow();
    }, delay);
  };
  return {
    get enabled() { return enabled; },
    hold(key) { enabled = false; holds.add(key); cancel(); },
    release(key) { if (holds.delete(key) && !enabled) schedule(); },
    browse() { enabled = false; schedule(); },
    scrolled() { if (!enabled) schedule(); },
    suspend() { cancel(); holds.clear(); enabled = false; },
    resume() { cancel(); holds.clear(); enabled = true; onFollow(); },
    reset() { cancel(); holds.clear(); enabled = true; }
  };
}

// Bounding rectangles share viewport coordinates even when the cue and list
// have different offset parents or the outer player has already been scrolled.
export function subtitleScrollTop({ scrollTop, scrollHeight, clientHeight, clientTop = 0, containerTop, cueTop }) {
  const target = scrollTop + cueTop - containerTop - clientTop - clientHeight * 0.25;
  return Math.max(0, Math.min(Math.max(0, scrollHeight - clientHeight), target));
}

// Readable clause breaks are visual only. Joining the parts restores the exact
// sentence; neither translation context nor the source timing is split.
export function sentenceReadingParts(text) {
  if (text.length <= 160) return [text];
  const parts = []; let pending = '';
  for (const clause of text.split(/(?<=[,;，；、])/u)) {
    if (pending.trim().length >= 45 && (pending + clause).trim().length > 110) { parts.push(pending); pending = ''; }
    pending += clause;
  }
  if (pending) parts.push(pending);
  return parts;
}
