import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubtitleFollow, subtitleScrollTop } from '../public/subtitles.mjs';

function fixture() {
  let now = 0, playing = true, calls = 0, id = 0;
  const pending = new Map();
  const timers = { setTimeout(fn, ms) { pending.set(++id, { fn, at: now + ms }); return id; }, clearTimeout(key) { pending.delete(key); } };
  const follower = createSubtitleFollow({ timers, onFollow: () => calls++, canResume: () => playing });
  return { follower, get calls() { return calls; }, set playing(value) { playing = value; }, advance(ms) { now += ms; for (const [key, item] of pending) if (item.at <= now) { pending.delete(key); item.fn(); } } };
}

test('manual browsing resumes following after three idle seconds, including the same cue', () => {
  const f = fixture(); f.follower.browse(); assert.equal(f.follower.enabled, false);
  f.advance(2999); assert.equal(f.calls, 0); f.advance(1);
  assert.equal(f.follower.enabled, true); assert.equal(f.calls, 1);
});
test('holding a finger and momentum scrolling postpone follow; automatic scroll does not disable it', () => {
  const f = fixture(); f.follower.hold('touch'); f.advance(5000); assert.equal(f.calls, 0);
  f.follower.release('touch'); f.advance(2500); f.follower.scrolled(); f.advance(2500); assert.equal(f.calls, 0);
  f.advance(500); assert.equal(f.calls, 1);
  f.follower.scrolled(); f.advance(3000); assert.equal(f.calls, 1); assert.equal(f.follower.enabled, true);
});
test('translation or paused playback never pulls the reader back; play can resume immediately', () => {
  const f = fixture(); f.follower.browse(); f.playing = false; f.advance(3000); assert.equal(f.calls, 0);
  f.playing = true; f.follower.browse(); f.follower.suspend(); f.advance(4000); assert.equal(f.calls, 0);
  f.follower.resume(); assert.equal(f.calls, 1); assert.equal(f.follower.enabled, true);
  f.advance(4000); assert.equal(f.calls, 1);
});
test('closing or changing tracks clears pending follow and active gestures', () => {
  const f = fixture(); f.follower.hold('pointer'); f.follower.release('pointer'); f.follower.reset();
  f.advance(4000); assert.equal(f.calls, 0); assert.equal(f.follower.enabled, true);
  f.follower.release('pointer'); f.advance(4000); assert.equal(f.calls, 0);
});
test('subtitle scroll uses viewport rectangles, keeps current cue near top, and clamps at both ends', () => {
  const base = { scrollTop: 200, scrollHeight: 2000, clientHeight: 240, clientTop: 1, containerTop: 500, cueTop: 901 };
  assert.equal(subtitleScrollTop(base), 540);
  assert.equal(subtitleScrollTop({ ...base, containerTop: 100, cueTop: 501 }), 540); // Outer player scrolled.
  assert.equal(subtitleScrollTop({ ...base, cueTop: 0 }), 0);
  assert.equal(subtitleScrollTop({ ...base, cueTop: 4000 }), 1760);
});
