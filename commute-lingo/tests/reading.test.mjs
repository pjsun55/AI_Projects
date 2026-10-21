import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSegments, normalizeWordSentences, availableTranscript } from '../public/core.mjs';
import { readingCues, readingPages, activeWord } from '../public/reading.mjs';
import { emptyLibrary, addAlbum, placeTrack, sentencesFor } from '../public/library.mjs';
const compact = text => text.replace(/\s+/gu, '');
const fixture = (count = 53) => Array.from({ length: count }, (_, i) => ({ text: 'word' + i + (i === count - 1 ? '.' : ''), timestamp: [i * .4, (i + 1) * .4] }));
test('word anchors survive normalization, album placement and a JSON storage round trip', () => {
  const { segments } = normalizeWordSentences(fixture(), 30);
  const library = placeTrack(addAlbum(emptyLibrary(), 'Fixture', 'a'), { id: 't', title: 'Generated fixture', duration: 30, alignment: 'word-v1', language: 'en', segments }, 'a');
  const restored = JSON.parse(JSON.stringify(library)).tracks[0];
  assert.equal(restored.segments[0].words.length, 53);
  assert.deepEqual(sentencesFor(restored)[0].words, segments[0].words);
});
test('a 53-word sentence splits into small reading cues using only original anchors', () => {
  const { segments } = normalizeWordSentences(fixture(), 30), before = JSON.stringify(segments);
  const cues = readingCues(segments);
  assert.ok(cues.length >= 9);
  assert.ok(cues.every(cue => cue.words.length <= 6 && cue.text.length <= 40 && cue.pages.length === 1));
  assert.equal(compact(cues.map(cue => cue.text).join('')), compact(segments[0].text));
  assert.deepEqual(cues.flatMap(cue => cue.words), segments[0].words);
  assert.ok(cues.every(cue => cue.sourceText === segments[0].text && cue.sourceStart === 0 && cue.sourceEnd === segments[0].end));
  assert.equal(JSON.stringify(segments), before);
});
test('word cursor rejects zero durations, gaps, stretched spans and overlaps', () => {
  const words = [{ text: 'A', start: 0, end: .3 }, { text: 'zero', start: .3, end: .3 }, { text: 'next', start: .3, end: .6 }, { text: 'later', start: 1, end: 1.5 }];
  assert.equal(activeWord(words, .1), 0); assert.equal(activeWord(words, .4), 2); assert.equal(activeWord(words, .8), -1); assert.equal(activeWord(words, 1.1), 3);
  assert.equal(activeWord([{ text: 'held', start: 0, end: 5 }], 2), -1);
  assert.equal(activeWord([{ text: 'first', start: 0, end: 1 }, { text: 'overlap', start: .5, end: 1.5 }], .7), -1);
  assert.equal(activeWord([{ text: 'two words', start: 0, end: 1 }], .5), -1);
});
test('legacy and coarse paragraphs paginate without inventing page or word times', () => {
  for (const text of ['A long public sentence '.repeat(30), '這是一段沒有空白的測試文字。'.repeat(30), '🙂'.repeat(101)]) {
    const cue = { start: 10, end: 40, text, timingUncertain: true }, [reading] = readingCues([cue]);
    assert.ok(reading.pages.length > 1 && reading.pages.every(page => Array.from(page).length <= 40));
    assert.equal(reading.pages.join(''), text); assert.equal(reading.start, 10); assert.equal(reading.end, 40); assert.equal(reading.words, undefined);
  }
});
test('invalid persisted anchors are rejected by the normalizer and cannot create a reading cursor', () => {
  const cue = { start: 0, end: 2, text: 'Safe text.' };
  for (const words of [[{ start: 0, end: 3, text: 'Safe text.' }], [{ start: 0, end: 1, text: 'Other text.' }], [{ start: NaN, end: 1, text: 'Safe text.' }], [{ start: 0, end: 1, text: '<img>' }]]) {
    assert.throws(() => normalizeSegments([{ ...cue, words }], 3));
    assert.equal(readingCues([{ ...cue, words }])[0].words, undefined);
  }
});
test('zero-only sentences still use the disclosed physical window, never synthesized word durations', () => {
  const result = availableTranscript({ timestampMode: 'word', processedSeconds: 30, chunks: [{ text: 'Unlocated.', timestamp: [10, 10] }], fallbackChunks: [{ start: 0, end: 30, text: 'Unlocated.' }] }, 30);
  assert.equal(result.transcriptStatus, 'partial');
  const cues = readingCues(result.segments);
  assert.ok(cues.every(cue => !cue.words && cue.timingUncertain));
});
test('reading pages preserve all punctuation and Unicode with bounded unspaced tokens', () => {
  for (const text of [' word '.repeat(20), 'x'.repeat(400), '漢字🙂'.repeat(100), '']) assert.equal(readingPages(text).join(''), text);
});
test('large clusters of zero anchors remain bounded and do not fabricate a clock', () => {
  const words = Array.from({ length: 2000 }, () => ({ text: 'x', start: 0, end: 0 })); words.push({ text: 'end.', start: 0, end: 1 });
  const cue = { start: 0, end: 1, text: words.map(word => word.text).join(' '), words };
  const result = readingCues([cue]);
  assert.equal(result.length, 1); assert.ok(result[0].pages.length > 1); assert.equal(result[0].pages.join('').replace(/\s/gu, ''), compact(cue.text));
});
