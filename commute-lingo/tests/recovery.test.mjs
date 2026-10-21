import test from 'node:test';
import assert from 'node:assert/strict';
import { availableTranscript, toSRT } from '../public/core.mjs';
import { emptyLibrary, addAlbum, placeTrack, sentencesFor } from '../public/library.mjs';

test('precise word timing retains the normal complete transcript path', () => {
  const result = availableTranscript({ timestampMode: 'word', processedSeconds: 60, chunks: [{ timestamp: [1, 2], text: 'A valid sentence.' }] }, 60);
  assert.equal(result.transcriptStatus, 'complete'); assert.equal(result.alignment, 'word-v1');
  assert.deepEqual(result.segments, [{ start: 1, end: 2, text: 'A valid sentence.', words: [{ start: 1, end: 2, text: 'A valid sentence.' }] }]);
});
test('a bad region keeps its text and physical window without discarding neighboring aligned sentences', () => {
  const result = availableTranscript({ timestampMode: 'mixed', processedSeconds: 60, regions: [
    { mode: 'word', chunks: [{ timestamp: [1, 3], text: 'First sentence.' }] },
    { mode: 'coarse', fallbackChunks: [{ start: 20, end: 40, text: 'Unaligned words. More words remain.' }] },
    { mode: 'word', chunks: [{ timestamp: [45, 50], text: 'Last sentence.' }] }
  ] }, 60);
  assert.equal(result.transcriptStatus, 'partial'); assert.equal(result.alignment, 'mixed-v1');
  assert.equal(result.segments.length, 3); assert.equal(result.segments[0].timingUncertain, undefined);
  assert.deepEqual(result.segments[1], { start: 20, end: 40, text: 'Unaligned words. More words remain.', timingUncertain: true });
  assert.equal(result.segments[2].start, 45); assert.equal(sentencesFor({ ...result, language: 'en' }).length, 3);
  assert.match(toSRT(result.segments), /00:00:20,000 --> 00:00:40,000/);
});
test('invalid model timestamps retain plain text with a disclosed whole-audio range', () => {
  const result = availableTranscript({ timestampMode: 'word', processedSeconds: 60, chunks: [{ timestamp: [NaN, -1], text: '<script>Raw words survive.</script>' }] }, 60);
  assert.equal(result.transcriptStatus, 'partial'); assert.equal(result.segments[0].text, 'Raw words survive.');
  assert.equal(result.segments[0].start, 0); assert.equal(result.segments[0].end, 60); assert.equal(result.segments[0].timingUncertain, true);
});
test('a zero-length sentence does not downgrade the healthy sentences around it', () => {
  const result = availableTranscript({ timestampMode: 'word', processedSeconds: 60, chunks: [
    { timestamp: [1, 3], text: 'First sentence.' }, { timestamp: [30, 30], text: 'Unaligned sentence.' }, { timestamp: [45, 50], text: 'Last sentence.' }
  ], fallbackChunks: [{ start: 20, end: 40, text: 'Window text.' }] }, 60);
  assert.equal(result.segments.length, 3); assert.equal(result.segments[0].timingUncertain, undefined); assert.equal(result.segments[0].start, 1);
  assert.equal(result.segments[1].timingUncertain, true); assert.equal(result.segments[1].start, 20); assert.equal(result.segments[1].end, 40);
  assert.equal(result.segments[2].timingUncertain, undefined); assert.equal(result.segments[2].end, 50);
});
test('empty or interrupted recognition produces audio-only status without fabricated subtitles', () => {
  for (const output of [undefined, { chunks: [], processedSeconds: 60 }, { timestampMode: 'mixed', fallbackChunks: [], processedSeconds: 5, incomplete: true }]) {
    const result = availableTranscript(output, 60);
    assert.equal(result.transcriptStatus, 'audio-only'); assert.deepEqual(result.segments, []); assert.ok(result.warnings.length);
  }
  const partial = availableTranscript({ timestampMode: 'mixed', processedSeconds: 20, incomplete: true, fallbackChunks: [{ start: 0, end: 20, text: 'Before the worker stopped.' }] }, 60);
  assert.equal(partial.transcriptStatus, 'partial'); assert.match(partial.segments[0].text, /worker stopped/);
  assert.ok(partial.warnings.some(item => item.type === 'partial-inference'));
});
test('untrusted fallback text remains bounded and invalid ranges are never exported', () => {
  const result = availableTranscript({ timestampMode: 'mixed', processedSeconds: 60, fallbackChunks: [{ start: -100, end: Infinity, text: 'a'.repeat(20001) }] }, 60);
  assert.equal(result.segments[0].text.length, 20000); assert.equal(result.segments[0].start, 0); assert.equal(result.segments[0].end, 60);
  assert.ok(result.warnings.some(item => item.type === 'output-limit'));
});
test('audio-only imports can be placed while malformed or accidentally empty subtitles remain rejected', () => {
  const library = addAlbum(emptyLibrary(), 'Audio', 'album');
  const track = { id: 'track', title: 'Saved original', duration: 60, segments: [], transcriptStatus: 'audio-only' };
  const placed = placeTrack(library, track, 'album'); assert.equal(placed.tracks.length, 1); assert.deepEqual(sentencesFor(placed.tracks[0]), []);
  assert.throws(() => placeTrack(library, { ...track, transcriptStatus: 'complete' }, 'album'), /字幕沒有有效/);
  assert.throws(() => placeTrack(library, { ...track, segments: [{ start: -1, end: 2, text: 'Bad.' }] }, 'album'), /起訖時間/);
});
