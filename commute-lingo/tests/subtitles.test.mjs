import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubtitleFollow, subtitleScrollTop, createAudioExcerpt } from '../public/subtitles.mjs';

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

function excerptFixture() {
  const audio = new EventTarget(), pending = new Map(); let id = 0;
  Object.assign(audio, { currentTime: 17, playbackRate: 1, paused: true });
  audio.play = async () => { audio.paused = false; audio.dispatchEvent(new Event('play')); audio.dispatchEvent(new Event('playing')); };
  audio.pause = () => { if (!audio.paused) { audio.paused = true; audio.dispatchEvent(new Event('pause')); } };
  const excerpt = createAudioExcerpt({ audio, timers: { setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; }, clearTimeout(key) { pending.delete(key); } } });
  return { audio, excerpt, pending, tick() { const tasks = [...pending.values()]; pending.clear(); for (const task of tasks) task.fn(); } };
}
test('original-audio excerpt stops at its end, replays, and restores the original listening position', async () => {
  const f = excerptFixture(); await f.excerpt.start({ start: 5, end: 8 });
  assert.equal(f.audio.currentTime, 5); assert.equal(f.excerpt.playing, true);
  f.audio.currentTime = 8.12; f.tick();
  assert.equal(f.audio.paused, true); assert.equal(f.audio.currentTime, 8); assert.equal(f.pending.size, 0);
  await f.excerpt.start({ start: 5, end: 8 }); assert.equal(f.audio.currentTime, 5);
  f.excerpt.reset(); assert.equal(f.audio.currentTime, 17); assert.equal(f.audio.paused, true); assert.equal(f.excerpt.active, false);
  f.audio.currentTime = 40; f.tick(); assert.equal(f.audio.currentTime, 40);
});
test('excerpt checks the media clock through buffering, speed changes, manual stop and file ending', async () => {
  const f = excerptFixture(); await f.excerpt.start({ start: 5, end: 8 });
  f.tick(); assert.equal(f.audio.paused, false); // A stalled clock never completes early.
  f.audio.currentTime = 7.9; f.audio.playbackRate = 2; f.audio.dispatchEvent(new Event('ratechange'));
  assert.ok([...f.pending.values()][0].ms <= 51);
  f.excerpt.pause(); assert.equal(f.pending.size, 0); assert.equal(f.excerpt.active, true);
  await f.excerpt.start({ start: 5, end: 8 }); f.audio.currentTime = 8; f.audio.dispatchEvent(new Event('ended'));
  assert.equal(f.excerpt.active, true); assert.equal(f.audio.paused, true); assert.equal(f.pending.size, 0);
  f.excerpt.reset({ restore: false }); assert.equal(f.audio.currentTime, 8);
  await assert.rejects(f.excerpt.start({ start: 8, end: 5 }), /時間範圍/);
  await assert.rejects(f.excerpt.start({ start: 0, end: Infinity }), /時間範圍/);
});
test('closing an excerpt cancels queued checks and failed playback remains retryable', async () => {
  const f = excerptFixture(); await f.excerpt.start({ start: 5, end: 8 });
  const queued = [...f.pending.values()][0].fn;
  f.excerpt.reset(); f.audio.currentTime = 30; await f.audio.play(); queued();
  assert.equal(f.audio.paused, false); assert.equal(f.audio.currentTime, 30);
  f.audio.pause(); f.audio.play = async () => { throw new Error('autoplay refused'); };
  await assert.rejects(f.excerpt.start({ start: 5, end: 8 }), /autoplay refused/);
  assert.equal(f.audio.paused, true); assert.equal(f.pending.size, 0);
  f.excerpt.reset(); assert.equal(f.audio.currentTime, 30);
});
