import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptText, guideAvailable, guideFingerprint, guideAudioRange, validateGuide, GUIDE_SCHEMA, GUIDE_MAX_INPUT } from '../public/guide.mjs';
import { encryptApiKey, decryptApiKey, validateApiKey } from '../public/key-vault.mjs';
import { generateGuide, verifyGeminiKey } from '../public/gemini.mjs';

// Self-authored fixtures and a deliberately unusable synthetic credential.
const key = 'fixture_only_invalid_key_000000000000';
const source = 'The train crosses a quiet valley. We notice familiar expressions.';
const fixture = () => ({ intro: '先想像搭車經過山谷的場景，再留意沿途的觀察。', route: ['注意列車經過的地方。'], vocabulary: [{ term: 'valley', pos: 'n.', meaning: '山谷', quote: 'The train crosses a quiet valley.', clue: '從列車沿途經過的地形猜測。' }], sentence: { quote: 'We notice familiar expressions.', translation: '我們注意到熟悉的表達方式。', explanation: 'notice 後面接被注意到的事物。' } });
const frame = (text, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, ...finishReason ? { finishReason } : {} }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 60, privateField: key } });
function sse(values, { split = false, suffix = '' } = {}) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + suffix);
  return new Response(new ReadableStream({ start(controller) { if (split) for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); else controller.enqueue(bytes); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const options = fetchImpl => ({ key, model: 'gemini-3.5-flash-lite', text: source, fetchImpl });

test('guide source and fingerprint preserve content and exclude incomplete transcripts', async () => {
  const track = { segments: [{ text: 'The train\n crosses' }, { text: 'a valley.' }] };
  assert.equal(transcriptText(track), 'The train crosses a valley.'); assert.ok(guideAvailable(track));
  for (const transcriptStatus of ['partial', 'audio-only']) assert.equal(guideAvailable({ ...track, transcriptStatus }), false);
  assert.equal(guideAvailable({ segments: [] }), false);
  const fingerprint = await guideFingerprint(source); assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, await guideFingerprint(source));
  assert.notEqual(fingerprint, await guideFingerprint(source + ' More.'));
  assert.notEqual(fingerprint, await guideFingerprint(source, 'gemini-3.8-flash'));
});
test('validation whitelists teaching fields and rejects invented quotes, duplicates and excessive content', () => {
  const value = fixture(); value.untrusted = '<script>'; value.vocabulary[0].unknown = key;
  assert.deepEqual(validateGuide(value, source), fixture());
  const fragment = fixture(); fragment.vocabulary[0].term = 'all'; assert.throws(() => validateGuide(fragment, source));
  for (const change of [v => { v.intro = '\0'; }, v => { v.route = Array(4).fill('多餘'); }, v => { v.vocabulary = Array(7).fill(v.vocabulary[0]); }, v => { v.vocabulary[0].quote = 'Invented quote.'; }, v => { v.vocabulary[0].term = 'unmentioned'; }, v => { v.vocabulary.push({ ...v.vocabulary[0] }); }, v => { v.sentence.quote = 'Invented sentence.'; }, v => { v.sentence.translation = 'x'.repeat(1201); }]) {
    const invalid = fixture(); change(invalid); assert.throws(() => validateGuide(invalid, source));
  }
  assert.deepEqual(validateGuide({ intro: '短文導讀。', route: [], vocabulary: [], sentence: null }, source), { intro: '短文導讀。', route: [], vocabulary: [], sentence: null });
});
test('guide original-audio ranges span existing cue boundaries without invented timecodes', () => {
  const cues = [{ start: 2, end: 5, text: 'The train crosses' }, { start: 6, end: 9, text: 'a quiet valley.' }, { start: 12, end: 15, text: 'We notice familiar expressions.' }];
  assert.deepEqual(guideAudioRange(cues, 'The train crosses a quiet valley.'), { start: 2, end: 9, text: 'The train crosses a quiet valley.' });
  assert.deepEqual(guideAudioRange(cues, 'familiar expressions.'), { start: 12, end: 15, text: 'familiar expressions.' });
  assert.equal(guideAudioRange(cues, 'Unmentioned quote.'), null);
  assert.equal(guideAudioRange([{ start: 2, end: null, text: 'No timing.' }], 'No timing.'), null);
});
test('AES-GCM survives structured cloning with fresh nonextractable keys and rejects tampering', async () => {
  const a = await encryptApiKey(key), b = await encryptApiKey(key);
  assert.equal(a.cryptoKey.extractable, false); assert.equal(a.cryptoKey.algorithm.length, 256);
  assert.equal(await decryptApiKey(structuredClone(a)), key);
  assert.notDeepEqual(a.iv, b.iv); assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.ok(!JSON.stringify(a).includes(key)); await assert.rejects(crypto.subtle.exportKey('raw', a.cryptoKey));
  const bad = structuredClone(a); new Uint8Array(bad.ciphertext)[0] ^= 1;
  for (const record of [bad, undefined, {}, { ...a, cryptoKey: b.cryptoKey }, { ...a, iv: new Uint8Array(8) }, { ...a, schema: 2 }]) await assert.rejects(decryptApiKey(record), /重新輸入/);
  for (const invalid of ['', 'short', 'x'.repeat(257), 'invalid key with spaces']) assert.throws(() => validateApiKey(invalid));
});
test('one fixed-origin request uses header-only credentials and handles split UTF-8 SSE', async () => {
  let calls = 0;
  const result = await generateGuide(options(async (url, init) => {
    calls++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
    assert.equal(init.headers['x-goog-api-key'], key);
    for (const [name, expected] of Object.entries({ credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' })) assert.equal(init[name], expected);
    assert.ok(!url.includes(key) && !init.body.includes(key));
    const body = JSON.parse(init.body); assert.equal(body.contents[0].parts[0].text, source);
    assert.equal(body.generationConfig.maxOutputTokens, 8192); assert.deepEqual(body.generationConfig.responseJsonSchema, GUIDE_SCHEMA);
    const text = JSON.stringify(fixture()), middle = Math.floor(text.length / 2);
    return sse([frame(text.slice(0, middle), null), frame(text.slice(middle))], { split: true });
  }));
  assert.equal(calls, 1); assert.deepEqual(result.content, fixture()); assert.deepEqual(result.usage, { promptTokenCount: 10, totalTokenCount: 60 });
});
test('Key verification uses a fixed short prompt without the transcript or guide schema', async () => {
  await verifyGeminiKey({ ...options(async (_, init) => {
    const body = JSON.parse(init.body); assert.equal(body.contents[0].parts[0].text, 'Please reply with OK.');
    assert.ok(!init.body.includes(source)); assert.equal(body.generationConfig.responseJsonSchema, undefined);
    assert.equal(body.generationConfig.maxOutputTokens, 1024); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low');
    return sse([frame('OK')]);
  }), model: 'gemini-3.8-flash' });
});
test('invalid input makes no requests; provider errors never expose bodies or retry automatically', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw Error(key); };
  for (const override of [{ model: '../redirect' }, { text: ' ' }, { text: 'x'.repeat(GUIDE_MAX_INPUT + 1) }, { text: source + key }, { key: '' }]) await assert.rejects(generateGuide({ ...options(fetchImpl), ...override }));
  assert.equal(calls, 0);
  for (const status of [400, 401, 403, 404, 429, 500]) {
    calls = 0;
    await assert.rejects(generateGuide(options(async () => { calls++; return new Response(key + ' private provider detail', { status }); })), error => error.status === status && !error.message.includes(key) && !error.message.includes('private'));
    assert.equal(calls, 1);
  }
  await assert.rejects(generateGuide(options(fetchImpl)), error => error.code === 'NETWORK' && !error.message.includes(key));
});
test('truncated, blocked, credential-bearing, malformed and oversized responses cannot become guides', async () => {
  const privateResult = fixture(); privateResult.intro = key;
  for (const response of [
    () => sse([frame(JSON.stringify(fixture()), 'MAX_TOKENS')]), () => sse([frame(JSON.stringify(fixture()), null)]),
    () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }]), () => sse([frame('not json')]),
    () => sse([frame(JSON.stringify(privateResult))]), () => sse([frame('x'.repeat(65537))]),
    () => sse([frame(JSON.stringify(fixture()))], { suffix: 'data: unfinished' }),
    () => new Response('data: {broken}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'text/event-stream' } }),
    () => new Response('<html>unsafe</html>')
  ]) await assert.rejects(generateGuide(options(async () => response())), error => !error.message.includes(key));
});
test('pre-cancel and in-flight cancel stop processing without exposing partial results', async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(generateGuide({ ...options(async () => { calls++; }), signal: before.signal }), error => error.code === 'CANCELLED'); assert.equal(calls, 0);
  const during = new AbortController();
  const waiting = generateGuide({ ...options(async (_, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); queueMicrotask(() => during.abort()); })), signal: during.signal });
  await assert.rejects(waiting, error => error.code === 'CANCELLED');
});
test('stalled headers time out after 180 seconds without retries', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  const pending = generateGuide(options(async (_, init) => { calls++; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); }));
  context.mock.timers.tick(180000); await assert.rejects(pending, error => error.code === 'TIMEOUT'); assert.equal(calls, 1);
});
