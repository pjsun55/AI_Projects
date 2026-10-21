import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupDictionary } from '../public/dictionary.mjs';
const fixture = () => ({ word: 'resilience', source: { license: { name: 'CC BY-SA 4.0' } }, entries: [{ language: { code: 'en' }, partOfSpeech: 'noun', pronunciations: [{ type: 'ipa', text: '/rɪˈzɪliəns/' }], senses: [{ definition: 'The ability to recover after difficulty.' }] }] });
test('dictionary sends only a single word to a fixed HTTPS service and retains text with attribution, no audio', async () => {
  const result = await lookupDictionary('resilience', 'en', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://freedictionaryapi.com/api/v1/entries/en/resilience');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
    const body = fixture(); body.entries[0].audio = 'https://attacker.example/audio'; return Response.json(body);
  } });
  assert.equal(result.senses[0].partOfSpeech, 'noun'); assert.equal(result.license.name, 'CC BY-SA 4.0');
  assert.doesNotMatch(JSON.stringify(result), /attacker|audio/);
});
test('dictionary failures, wrong language, HTML and oversized responses leave enrichment unavailable', async () => {
  const wrong = fixture(); wrong.entries[0].language.code = 'fr';
  const unlicensed = fixture(); unlicensed.source.license.name = 'unknown';
  for (const response of [new Response('', { status: 429 }), new Response('<script>', { headers: { 'content-type': 'text/html' } }), Response.json(wrong), Response.json(unlicensed), Response.json({ ...fixture(), word: 'different' }), Response.json({ ...fixture(), huge: 'a'.repeat(256 * 1024) })]) {
    await assert.rejects(lookupDictionary('resilience', 'en', { fetchImpl: async () => response }));
  }
});
test('cancelled and non-word lookups cannot send a request', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lookupDictionary('resilience', 'en', { signal: controller.signal, fetchImpl: async () => assert.fail('No fetch') }), { name: 'AbortError' });
  await assert.rejects(lookupDictionary('two words', 'en', { fetchImpl: async () => assert.fail('No fetch') }));
});
