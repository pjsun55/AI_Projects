import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSegments, normalizeWordSentences, availableTranscript } from '../public/core.mjs';
import { readingCues, activeWord } from '../public/reading.mjs';
import { emptyLibrary, addAlbum, placeTrack, sentencesFor } from '../public/library.mjs';
const fixture = (count = 53) => Array.from({ length: count }, (_, i) => ({ text: 'word' + i + (i === count - 1 ? '.' : ''), timestamp: [i * .4, (i + 1) * .4] }));
test('word anchors survive normalization, album placement and a JSON storage round trip', () => {
  const { segments } = normalizeWordSentences(fixture(), 30);
  const library = placeTrack(addAlbum(emptyLibrary(), 'Fixture', 'a'), { id: 't', title: 'Generated fixture', duration: 30, alignment: 'word-v1', language: 'en', segments }, 'a');
  const restored = JSON.parse(JSON.stringify(library)).tracks[0];
  assert.equal(restored.segments[0].words.length, 53);
  assert.deepEqual(sentencesFor(restored)[0].words, segments[0].words);
});
test('a complete 53-word sentence stays in one card with every original word anchor', () => {
  const { segments } = normalizeWordSentences(fixture(), 30), before = JSON.stringify(segments);
  const cues = readingCues(segments);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, segments[0].text);
  assert.deepEqual(cues[0].words, segments[0].words);
  assert.equal(cues[0].start, segments[0].start);
  assert.equal(cues[0].end, segments[0].end);
  assert.equal(activeWord(cues[0].words, 20.5), 51);
  assert.equal(JSON.stringify(segments), before);
});
test('sentence-ending punctuation separates cards while commas, abbreviations and decimals stay inside', () => {
  const text = 'Dr. Smith paid 3.14 dollars, then boarded the morning train. Did he arrive? Yes!';
  const chunks = text.split(' ').map((text, i) => ({ text, timestamp: [i * .4, (i + 1) * .4] }));
  const { segments } = normalizeWordSentences(chunks, 30);
  const cues = readingCues(sentencesFor({ alignment: 'word-v1', language: 'en', segments }));
  assert.deepEqual(cues.map(cue => cue.text), ['Dr. Smith paid 3.14 dollars, then boarded the morning train.', 'Did he arrive?', 'Yes!']);
  assert.deepEqual(cues.flatMap(cue => cue.words), segments.flatMap(cue => cue.words));
});
test('CJK sentence punctuation forms complete cards without splitting at a comma', () => {
  const chunks = ['今天', '搭車，', '一起', '學習。', '聽懂了嗎？', '太好了！'].map((text, i) => ({ text, timestamp: [i, i + 1] }));
  const { segments } = normalizeWordSentences(chunks, 6, 'zh');
  assert.deepEqual(readingCues(segments).map(cue => cue.text), ['今天搭車，一起學習。', '聽懂了嗎？', '太好了！']);
});
test('word cursor rejects zero durations, gaps, stretched spans and overlaps', () => {
  const words = [{ text: 'A', start: 0, end: .3 }, { text: 'zero', start: .3, end: .3 }, { text: 'next', start: .3, end: .6 }, { text: 'later', start: 1, end: 1.5 }];
  assert.equal(activeWord(words, .1), 0); assert.equal(activeWord(words, .4), 2); assert.equal(activeWord(words, .8), -1); assert.equal(activeWord(words, 1.1), 3);
  assert.equal(activeWord([{ text: 'held', start: 0, end: 5 }], 2), -1);
  assert.equal(activeWord([{ text: 'first', start: 0, end: 1 }, { text: 'overlap', start: .5, end: 1.5 }], .7), -1);
  assert.equal(activeWord([{ text: 'two words', start: 0, end: 1 }], .5), -1);
});
test('legacy and coarse text stays fully visible without inventing page or word times', () => {
  for (const text of ['A long public sentence '.repeat(30), '這是一段沒有空白的測試文字。'.repeat(30), '🙂'.repeat(101)]) {
    const cue = { start: 10, end: 40, text, timingUncertain: true }, [reading] = readingCues([cue]);
    assert.equal(reading.text, text);
    assert.ok(!reading.pages || reading.pages.length === 1);
    assert.equal(reading.start, 10); assert.equal(reading.end, 40); assert.equal(reading.words, undefined);
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
test('sentence cards preserve punctuation and Unicode without hiding text on additional pages', () => {
  for (const text of [' word '.repeat(20), 'x'.repeat(400), '漢字🙂'.repeat(100), '']) assert.equal(readingCues([{ start: 0, end: 1, text }])[0].text, text);
});
test('large clusters of zero anchors remain bounded and do not fabricate a clock', () => {
  const words = Array.from({ length: 2000 }, () => ({ text: 'x', start: 0, end: 0 })); words.push({ text: 'end.', start: 0, end: 1 });
  const cue = { start: 0, end: 1, text: words.map(word => word.text).join(' '), words };
  const result = readingCues([cue]);
  assert.equal(result.length, 1); assert.equal(result[0].text, cue.text); assert.deepEqual(result[0].words, words); assert.equal(activeWord(result[0].words, .5), words.length - 1);
});
