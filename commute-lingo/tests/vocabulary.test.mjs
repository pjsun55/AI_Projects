import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyVocabulary, addWord, editWord, normalizeWord, wordIdentity, validateWord, validateVocabulary, mergeVocabulary } from '../public/vocabulary.mjs';

const book = (word = 'Resilience', language = 'en', id = 'local-word') => addWord(emptyVocabulary(), { word, language }, { id, now: 100 });
test('single-word collection supports accents and internal apostrophes but rejects sentences, URLs and controls', () => {
  for (const word of ['résumé', "don't", 'l’école', 'self-esteem', '復原力']) assert.equal(normalizeWord(word), word);
  for (const word of ['two words', 'word.', '<script>', 'https://test.com', 'word\nword', 'abc123', 'word\u200b', 'a'.repeat(65)]) assert.throws(() => normalizeWord(word));
  assert.equal(wordIdentity('E\u0301cole', 'fr'), wordIdentity('école', 'fr'));
  assert.equal(wordIdentity('DON’T', 'en'), wordIdentity("don't", 'en'));
});
test('duplicate collection preserves the original spelling and notes; languages remain distinct', () => {
  const initial = editWord(book(), 'local-word', { note: 'My personal meaning', translation: '韌性' }, 200);
  assert.throws(() => addWord(initial, { word: 'RESILIENCE', language: 'en' }), /已在單字本/);
  const other = addWord(initial, { word: 'Resilience', language: 'fr' }, { id: 'french-word' });
  assert.equal(other.words.length, 2); assert.equal(other.words[0].note, 'My personal meaning'); assert.equal(other.words[0].word, 'Resilience');
});
test('edit whitelists user fields and validates tags without changing source, word or identifier', () => {
  const initial = book();
  const next = editWord(initial, 'local-word', { word: 'overwrite', id: 'malicious', translation: '復原力', tags: '生活,工作,生活', starred: true, status: 'learning' }, 200);
  assert.equal(next.words[0].word, 'Resilience'); assert.equal(next.words[0].id, 'local-word');
  assert.deepEqual(next.words[0].tags, ['生活', '工作']); assert.equal(next.words[0].translationSource, 'manual');
  assert.throws(() => editWord(next, 'local-word', { tags: ['a'.repeat(25)] }));
  assert.throws(() => editWord(next, 'local-word', { starred: 'true' }));
});
test('only permitted text metadata is retained and dictionary attribution links are canonical', () => {
  const source = book().words[0];
  const word = validateWord({ ...source, audio: 'EXCLUDED_AUDIO_CANARY', apiKey: 'EXCLUDED_KEY_CANARY', sentence: 'EXCLUDED_SENTENCE_CANARY', dictionary: {
    phonetic: '/rɪˈzɪliəns/', senses: [{ partOfSpeech: 'noun', definition: 'Recovery after difficulty.', html: '<script>' }], sourceURL: 'javascript:alert(1)', audio: 'https://attacker.example/audio', license: { url: 'https://attacker.example/license' }
  } });
  const serialized = JSON.stringify(word);
  assert.doesNotMatch(serialized, /EXCLUDED_|javascript:|attacker|<script>/);
  assert.equal(word.dictionary.sourceURL, 'https://en.wiktionary.org/wiki/Resilience');
  assert.equal(word.dictionary.license.name, 'CC BY-SA 4.0');
});
test('merge preserves local edits, learning status and identities, fills blanks and merges classification', () => {
  const local = editWord(book(), 'local-word', { translation: '我的解釋', note: 'Keep this note', status: 'known', tags: ['工作'] }, 200);
  const imported = editWord(book('resilience', 'en', 'imported-word'), 'imported-word', { translation: '不同意思', note: 'Incoming note', tags: ['生活'], starred: true, status: 'new' }, 300);
  const result = mergeVocabulary(local, imported, { now: 400 });
  assert.equal(result.added, 0); assert.equal(result.duplicates, 1); assert.equal(result.enriched, 1);
  const entry = result.vocabulary.words[0];
  assert.equal(entry.id, 'local-word'); assert.equal(entry.word, 'Resilience'); assert.equal(entry.translation, '我的解釋'); assert.equal(entry.note, 'Keep this note'); assert.equal(entry.status, 'known');
  assert.deepEqual(entry.tags, ['工作', '生活']); assert.equal(entry.starred, true);
  assert.equal(result.vocabulary.generation, local.generation);
});
test('imported IDs never overwrite another local word and repeated restore is idempotent', () => {
  const local = book(), imported = book('Journey', 'en', 'local-word');
  const result = mergeVocabulary(local, imported, { idFactory: () => 'new-generated-id' });
  assert.equal(result.added, 1); assert.equal(result.vocabulary.words[1].id, 'new-generated-id');
  const again = mergeVocabulary(result.vocabulary, imported);
  assert.equal(again.added, 0); assert.equal(again.duplicates, 1); assert.equal(again.enriched, 0);
  assert.deepEqual(again.vocabulary.words, result.vocabulary.words);
});
test('malformed or repeated imported words are rejected before any mutation', () => {
  const initial = book();
  for (const changes of [{ words: [...initial.words, initial.words[0]] }, { revision: -1 }, { generation: '../escape' }, { words: [{ ...initial.words[0], language: '__proto__' }] }]) assert.throws(() => validateVocabulary({ ...initial, ...changes }));
  assert.equal(initial.words.length, 1);
});
