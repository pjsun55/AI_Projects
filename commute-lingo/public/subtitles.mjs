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

// Reuse the saved original audio. A short media-time check complements
// timeupdate (which can be several hundred milliseconds apart). Pauses,
// buffering and speed changes always recalculate from the media clock.
export function createAudioExcerpt({ audio, timers = globalThis, onChange = () => {} }) {
  let range = null, timer, generation = 0;
  const clear = () => { timers.clearTimeout(timer); timer = undefined; };
  const check = () => {
    clear();
    if (!range) return;
    if (audio.currentTime >= range.end) {
      audio.pause();
      if (audio.currentTime !== range.end) audio.currentTime = range.end;
      onChange(false); return;
    }
    if (audio.currentTime < range.start - 0.1) { audio.pause(); onChange(false); return; }
    const playing = !audio.paused; onChange(playing);
    if (playing) timer = timers.setTimeout(check, Math.max(10, Math.min(100, (range.end - audio.currentTime) * 1000 / (audio.playbackRate || 1))));
  };
  for (const event of ['play', 'timeupdate', 'pause', 'playing', 'ratechange', 'seeked', 'ended']) audio.addEventListener(event, check);
  return {
    get active() { return !!range; },
    get playing() { return !!range && !audio.paused; },
    get returnTime() { return range?.returnTime; },
    async start({ start, end }) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('這一段沒有可播放的時間範圍。');
      const returnTime = range?.returnTime ?? audio.currentTime;
      clear(); const current = ++generation;
      range = { start, end, returnTime }; audio.currentTime = start;
      try { await audio.play(); }
      catch (error) { if (current === generation) { audio.pause(); onChange(false); throw error; } }
      if (current === generation) check();
    },
    pause() { clear(); if (range) audio.pause(); onChange(false); },
    reset({ restore = true } = {}) {
      const previous = range; generation++; clear();
      if (previous) { audio.pause(); if (restore) audio.currentTime = previous.returnTime; }
      range = null;
      onChange(false);
    }
  };
}
