import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, parseTranscript, normalizeSegments, normalizeGeneratedSegments, normalizeWordSentences, findActive, splitForTranslation, toSRT, formatTime, appleLookupURL, groupSentences, transcriptCoverage, checkDecodedAudio, sentenceTexts } from '../public/core.mjs';

test('SRT handles BOM, CRLF, markup as text, and a nonzero starting offset', () => {
  const doc = parseTranscript('\uFEFF1\r\n00:00:02,100 --> 00:00:04,250\r\n<b>Hello</b> world.\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nNext sentence.', { duration: 10 });
  assert.deepEqual(doc.segments, [{ start: 2.1, end: 4.25, text: 'Hello world.' }, { start: 5, end: 6, text: 'Next sentence.' }]);
  assert.equal(doc.verifiedAudio, false);
});
test('VTT handles cue identifiers, settings and NOTE blocks', () => {
  const doc = parseTranscript('WEBVTT\n\nNOTE ignored\n00:00.000 --> 00:01.000\nnot a cue\n\nintro\n00:02.000 --> 00:04.000 align:start\nHello.');
  assert.deepEqual(doc.segments, [{ start: 2, end: 4, text: 'Hello.' }]);
});
test('Whisper JSON retains model timing and explicitly marks a missing final end', () => {
  const { segments } = parseTranscript(JSON.stringify([{ timestamp: [0, 2], text: 'One.' }, { timestamp: [2, null], text: 'Two.' }]), { duration: 4 });
  assert.equal(segments[1].end, 4); assert.equal(segments[1].inferredEnd, true);
  const restored = parseTranscript(JSON.stringify({ segments }), { duration: 4 });
  assert.equal(restored.segments[1].inferredEnd, true);
});
test('fingerprints reject the wrong audio and allow the correct paired export', () => {
  const doc = { schema: SCHEMA, audio: { sha256: 'a' }, segments: [{ start: 1, end: 3, text: 'Hello.' }] };
  assert.throws(() => parseTranscript(JSON.stringify(doc), { audioHash: 'b', duration: 4 }), /另一份音檔/);
  assert.equal(parseTranscript(JSON.stringify(doc), { audioHash: 'a', duration: 4 }).verifiedAudio, true);
});
test('rejects corrupt timing, absent text, unsupported versions and out-of-range cues', () => {
  for (const cue of [{ start: -1, end: 2, text: 'x' }, { start: 1, end: 1, text: 'x' }, { start: 1, end: Infinity, text: 'x' }, { start: '1', end: 2, text: 'x' }, { start: 0, end: 2, text: '' }]) assert.throws(() => normalizeSegments([cue]));
  assert.throws(() => parseTranscript('{broken'), /JSON/);
  assert.throws(() => parseTranscript('{"schema":"future"}'), /版本/);
  assert.throws(() => parseTranscript('1\n00:70:00,000 --> 00:71:00,000\nx'), /格式/);
  assert.throws(() => normalizeSegments([{ start: 0, end: 30, text: 'x' }], 20), /長度/);
});
test('active cues honor exact boundaries, silence gaps and overlaps', () => {
  const cues = [{ start: 1, end: 4 }, { start: 2, end: 3 }, { start: 5, end: 6 }];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(t => findActive(cues, t)), [-1, 0, 1, 0, -1, 2, -1]);
});
test('generated subtitles keep valid timestamps unchanged and missing final ends disclosed', () => {
  const raw = [{ timestamp: [0, 2], text: 'One.' }, { timestamp: [2, null], text: 'Two.' }];
  const result = normalizeGeneratedSegments(raw, 4);
  assert.deepEqual(result.segments, normalizeSegments(raw, 4));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.segments[1].inferredEnd, true);
});
test('missing model starts retain text in a disclosed bounded range without relaxing file imports', () => {
  const raw = [{ timestamp: [null, 2], text: 'Untimed start.' }, { timestamp: [2, 4], text: 'Timed sentence.' }];
  assert.throws(() => normalizeSegments(raw, 4), /起訖時間無效/);
  const result = normalizeGeneratedSegments(raw, 4);
  assert.deepEqual(result.segments[0], { start: 0, end: 2, text: 'Untimed start.', timingUncertain: true });
  assert.equal(result.warnings[0].type, 'missing-start');
  assert.equal(result.segments[1].text, raw[1].text);
  assert.equal(raw[0].timestamp[0], null);
  assert.equal(groupSentences(result.segments)[0].timingUncertain, true);
  assert.equal(normalizeSegments(result.segments, 4)[0].timingUncertain, true);
});
test('an unlocated final model fragment is retained between the previous boundary and audio end', () => {
  const result = normalizeGeneratedSegments([{ timestamp: [0, 2], text: 'Timed.' }, { timestamp: [null, null], text: 'Tail text.' }], 5);
  assert.deepEqual(result.segments[1], { start: 2, end: 5, text: 'Tail text.', inferredEnd: true, timingUncertain: true });
  assert.equal(transcriptCoverage(result.segments, 100).timedEnd, 2);
});
test('equal and reversed overlap boundaries preserve every word using an existing adjacent range', () => {
  for (const start of [1, 1.02]) {
    const raw = [{ timestamp: [0, 1], text: 'Before.' }, { timestamp: [start, 1], text: 'Boundary words.' }, { timestamp: [1, 3], text: 'After.' }];
    assert.throws(() => normalizeSegments(raw, 4), /起訖時間無效/);
    const result = normalizeGeneratedSegments(raw, 4);
    assert.equal(result.segments.length, 2);
    assert.deepEqual([result.segments[1].start, result.segments[1].end], [1, 3]);
    assert.equal(result.segments.map(cue => cue.text).join(' ').replace(/\s+/g, ' '), 'Before. Boundary words. After.');
    assert.equal(result.segments[1].timingUncertain, true);
    assert.equal(result.warnings[0].type, 'overlap-boundary');
    assert.equal(raw[1].text, 'Boundary words.');
  }
});
test('a missing end skips repeated starts without producing a zero-length cue', () => {
  const result = normalizeGeneratedSegments([{ timestamp: [1, null], text: 'Open.' }, { timestamp: [1, 2], text: 'Overlap.' }, { timestamp: [3, 4], text: 'Later.' }], 5);
  assert.equal(result.segments[0].end, 3); assert.equal(result.segments[0].inferredEnd, true);
  assert.equal(result.segments[0].timingUncertain, true);
  assert.equal(result.segments.length, 3);
});
test('a rounded final timestamp cannot discard the transcript at a fractional MP3 duration', () => {
  const duration = 1850.279125;
  const raw = [{ timestamp: [1849, 1850.28], text: 'Last timed sentence.' }, { timestamp: [1850.28, null], text: 'Trailing words.' }];
  assert.throws(() => normalizeSegments(raw, duration), /起訖時間無效/);
  const result = normalizeGeneratedSegments(raw, duration);
  assert.equal(result.segments.length, 1);
  assert.deepEqual([result.segments[0].start, result.segments[0].end], [1849, 1850.28]);
  assert.equal(result.segments[0].text, 'Last timed sentence.\nTrailing words.');
  assert.equal(result.segments[0].timingUncertain, true);
});
test('corrupt or unbounded generated timestamps remain errors rather than invented timing', () => {
  for (const timestamp of [[-1, 2], ['1', 2], [1, NaN], [1, Infinity], [40, 1], [8, 2], [11, null]]) {
    assert.throws(() => normalizeGeneratedSegments([{ timestamp, text: 'Invalid.' }], 10), /字幕模型/);
  }
  assert.throws(() => normalizeGeneratedSegments([{ timestamp: [null, null], text: 'No duration.' }], NaN));
  assert.throws(() => normalizeGeneratedSegments([{ timestamp: [0, 1], text: '  ' }], 2), /有效原文/);
  assert.throws(() => normalizeGeneratedSegments([{ timestamp: [0, null], text: 'Inferred range.' }, { timestamp: [2, 1], text: 'Bad boundary.' }], 3), /時間無法安全對齊/);
});
test('long paragraphs split at UTF-8 byte limits without losing Unicode', () => {
  const input = `${'A sentence to translate. '.repeat(60)}${'中文🙂沒有空格'.repeat(70)}`.trim();
  const chunks = splitForTranslation(input);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(c => new TextEncoder().encode(c).length <= 500));
  assert.equal(chunks.join('').replace(/\s/g, ''), input.replace(/\s/g, ''));
  assert.ok(chunks.every(c => !c.includes('\uFFFD')));
  assert.throws(() => splitForTranslation('   '));
});
test('SRT round trip preserves timing and content', () => {
  const cues = [{ start: 3599.5, end: 3601.25, text: 'Across the hour.' }];
  assert.deepEqual(parseTranscript(toSRT(cues)).segments, cues);
  assert.equal(formatTime(59.9996, true), '00:01:00.000');
});
test('Apple lookup accepts the supplied episode format and rejects unrelated URLs', () => {
  const lookup = appleLookupURL('https://podcasts.apple.com/tw/podcast/example/id189330872?i=1000796641961');
  assert.equal(lookup.episode, '1000796641961'); assert.match(lookup.url, /id=189330872/);
  for (const input of ['http://podcasts.apple.com/id1?i=2', 'https://example.com/id1?i=2', 'https://podcasts.apple.com/id1', 'https://user:pass@podcasts.apple.com/id1?i=2']) assert.throws(() => appleLookupURL(input));
});

test('joins the reported mid-sentence break while retaining original cue timing and data', () => {
  const raw = [
    { start: 110, end: 114, text: "for coming on to chat. It's always great to have you. Thank you for having me. So I'd" },
    { start: 114, end: 119, text: 'love to start by asking how you, you know, first got interested.' },
    { start: 119, end: 125, text: 'A new sentence.' }
  ];
  const before = JSON.stringify(raw);
  const grouped = groupSentences(raw);
  assert.equal(grouped.length, 2);
  assert.match(grouped[0].text, /So I'd love to start/);
  assert.equal(grouped[0].start, 110); assert.equal(grouped[0].end, 119);
  assert.equal(grouped[0].incomplete, false); assert.equal(JSON.stringify(raw), before);
});
test('sentence grouping keeps abbreviations, CJK punctuation and incomplete tails', () => {
  const grouped = groupSentences([{ start: 0, end: 1, text: 'Dr.' }, { start: 1, end: 3, text: 'Wang arrived.' }, { start: 3, end: 5, text: 'But then' }]);
  assert.equal(grouped[0].text, 'Dr. Wang arrived.'); assert.equal(grouped[1].incomplete, true);
  assert.equal(groupSentences([{ start: 0, end: 1, text: 'これは' }, { start: 1, end: 2, text: '例です。' }], 'ja')[0].text, 'これは例です。');
});
test('word sentence grouping preserves inferred tails for coverage and valid later endpoints replace them', () => {
  const inferred = groupSentences([{ start: 0, end: 1, text: 'The' }, { start: 1, end: 120, text: 'tail.', inferredEnd: true }]);
  assert.equal(inferred[0].inferredEnd, true); assert.equal(transcriptCoverage(inferred, 120).needsReview, true);
  const confirmed = groupSentences([{ start: 0, end: 1, text: 'A', inferredEnd: true }, { start: 1, end: 2, text: 'sentence.' }]);
  assert.equal(confirmed[0].inferredEnd, undefined);
});
test('words sharing a DTW instant retain their text and form complete independently timed sentences', () => {
  const words = [{ timestamp: [0, 1], text: 'The' }, { timestamp: [1, 1], text: 'answer' }, { timestamp: [1, 1], text: 'lies' }, { timestamp: [1, 3], text: 'here.' }, { timestamp: [4, 5], text: 'Next.' }];
  const before = JSON.stringify(words);
  const { segments } = normalizeWordSentences(words, 6);
  assert.deepEqual(segments, [{ start: 0, end: 3, text: 'The answer lies here.' }, { start: 4, end: 5, text: 'Next.' }]);
  assert.equal(JSON.stringify(words), before);
});
test('word sentence timing rejects reversed, unordered, missing and out-of-range anchors or zero-length sentences', () => {
  for (const words of [
    [{ timestamp: [2, 1], text: 'Bad.' }], [{ timestamp: [null, 1], text: 'Bad.' }], [{ timestamp: [0, Infinity], text: 'Bad.' }],
    [{ timestamp: [0, 10], text: 'Bad.' }], [{ timestamp: [0, 0], text: 'Bad.' }],
    [{ timestamp: [2, 3], text: 'The' }, { timestamp: [1, 2], text: 'end.' }]
  ]) assert.throws(() => normalizeWordSentences(words, 6));
});
test('identical complementary DTW copies resolve to one sentence using only positive model spans', () => {
  const words = [{ timestamp: [0, 1], text: 'The' }, { timestamp: [1, 1], text: 'answer.' }, { timestamp: [1, 1], text: 'The' }, { timestamp: [1, 2], text: 'answer.' }];
  const { segments, duplicateSentences } = normalizeWordSentences(words, 3);
  assert.deepEqual(segments, [{ start: 0, end: 2, text: 'The answer.' }]); assert.equal(duplicateSentences, 1);
});
test('genuinely repeated sentences keep both copies even when their ranges touch', () => {
  const { segments, duplicateSentences } = normalizeWordSentences([
    { timestamp: [0, 1], text: 'The' }, { timestamp: [1, 2], text: 'answer.' },
    { timestamp: [2, 3], text: 'The' }, { timestamp: [3, 4], text: 'answer.' }
  ], 4);
  assert.equal(segments.length, 2); assert.equal(duplicateSentences, 0);
});
test('an inferred last end cannot hide a transcript stopping at 1:54 in 22-minute audio', () => {
  const raw = [{ start: 0, end: 114, text: 'Beginning.' }, { start: 114, end: 1335, text: 'Unfinished', inferredEnd: true }];
  const coverage = transcriptCoverage(raw, 1335);
  assert.equal(coverage.timedEnd, 114); assert.equal(coverage.needsReview, true);
  assert.equal(transcriptCoverage([{ start: 1325, end: 1335, text: 'End.', inferredEnd: true }], 1335).needsReview, false);
});
test('decoding a two-minute prefix cannot be accepted as a complete 22-minute input', () => {
  assert.throws(() => checkDecodedAudio(120 * 16000, 16000, 1335), /只轉錄前段/);
  assert.equal(checkDecodedAudio(1335 * 16000, 16000, 1335), 1335);
  assert.throws(() => checkDecodedAudio(0, 16000, 1335));
});
test('translation requests prefer complete sentence boundaries over a full byte bucket', () => {
  const sentence = 'A complete sentence. ';
  const chunks = splitForTranslation(sentence.repeat(40));
  assert.ok(chunks.every(chunk => chunk.endsWith('.')));
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 500));
});

test('selectable sentences inside a shared timestamp cue translate independently', () => {
  assert.deepEqual(sentenceTexts('It is great to have you. Thank you for having me. So let us begin.'), ['It is great to have you.', 'Thank you for having me.', 'So let us begin.']);
  assert.deepEqual(sentenceTexts('第一句。第二句！', 'zh'), ['第一句。', '第二句！']);
});
