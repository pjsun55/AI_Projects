import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../public/translation.mjs';
const ok = translation => Response.json({ responseStatus: 200, quotaFinished: false, responseData: { translatedText: translation } });

test('first lookup sends only selected text; repeat and persisted lookups use no network', async () => {
  const saved = new Map(); let count = 0;
  const options = { load: async k => saved.get(k), save: async (k, v) => saved.set(k, v), fetchImpl: async (url, init) => {
    count++; assert.equal(url.hostname, 'api.mymemory.translated.net'); assert.equal(url.searchParams.get('q'), 'Hello.'); assert.equal(url.searchParams.get('langpair'), 'en|zh-TW'); assert.equal(init.credentials, 'omit');
    return ok('你好。');
  } };
  const client = createTranslator(options);
  const first = await client.translate('Hello.', 'en');
  assert.equal(first.translation, '你好。'); assert.equal(first.persisted, true);
  assert.equal((await client.translate('Hello.', 'en')).cached, true);
  const restored = await createTranslator(options).translate('Hello.', 'en');
  assert.equal(restored.cached, true); assert.equal(restored.persisted, true);
  assert.equal(count, 1);
});
test('long paragraph uses sequential <=500-byte requests and keeps successful parts for retry', async () => {
  let count = 0, fail = true;
  const client = createTranslator({ fetchImpl: async url => {
    count++; assert.ok(new TextEncoder().encode(url.searchParams.get('q')).length <= 500);
    if (count === 2 && fail) throw new Error('offline');
    return ok('翻譯');
  } });
  const text = 'First paragraph. '.repeat(80);
  await assert.rejects(client.translate(text, 'en'), /offline/);
  fail = false;
  const result = await client.translate(text, 'en');
  assert.equal(result.cached, false); assert.ok(result.translation.includes('翻譯'));
  // The first successful chunk was cached; repeated identical chunks also reuse it.
  assert.ok(count < 6);
});
test('quota messages never become cached translations', async () => {
  let count = 0;
  const client = createTranslator({ fetchImpl: async () => { count++; return Response.json({ responseStatus: 200, quotaFinished: true, responseData: { translatedText: 'LIMIT' } }); } });
  await assert.rejects(client.translate('Hello', 'en'), /額度/);
  await assert.rejects(client.translate('Hello', 'en'), /額度/);
  assert.equal(count, 2); assert.equal(client.entries().length, 0);
});
test('cancelled or late responses do not overwrite the translation cache', async () => {
  const controller = new AbortController(); let release;
  const client = createTranslator({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = client.translate('Old sentence', 'en', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); release(ok('舊句子'));
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(client.entries().length, 0);
});
test('storage failure reports session-only caching while retaining useful translations', async () => {
  let warning, requests = 0;
  const client = createTranslator({ save: async () => { throw new Error('full'); }, warn: message => { warning = message; }, fetchImpl: async () => { requests++; return ok('你好'); } });
  assert.equal((await client.translate('Hello', 'en')).persisted, false);
  assert.match(warning, /本次/); assert.equal((await client.translate('Hello', 'en')).cached, true); assert.equal(requests, 1);
});
test('different source languages cannot collide in the cache', async () => {
  let count = 0;
  const client = createTranslator({ fetchImpl: async () => ok(`結果${++count}`) });
  await client.translate('chat', 'en'); await client.translate('chat', 'fr'); assert.equal(count, 2);
});

test('oversized, null, and invalid translated values cannot enter the cache', async () => {
  for (const body of [null, { responseStatus: 200, responseData: { translatedText: {} } }, { responseStatus: 200, responseData: { translatedText: 'x'.repeat(70000) } }]) {
    let saves = 0;
    const client = createTranslator({ fetchImpl: async () => Response.json(body), save: async () => { saves++; } });
    await assert.rejects(client.translate('Hello', 'en'), /有效結果|大小限制/);
    assert.equal(client.entries().length, 0); assert.equal(saves, 0);
  }
});
