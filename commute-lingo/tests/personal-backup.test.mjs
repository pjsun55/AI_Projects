import test from 'node:test';
import assert from 'node:assert/strict';
import { personalBackup, readPersonalBackup, planPersonalRestore, MAX_BACKUP_BYTES } from '../public/backup.mjs';
import { emptyLibrary, addAlbum, placeTrack } from '../public/library.mjs';
import { emptyVocabulary, addWord } from '../public/vocabulary.mjs';

const vocabulary = () => addWord(emptyVocabulary(), { word: 'resilience', language: 'en', translation: '復原力', tags: ['生活'] }, { id: 'word', now: 100 });
test('personal backup round-trips settings and vocabulary and excludes all other data and credential fields', async () => {
  const library = emptyLibrary(); library.settings.guidePrompt = '依主題展開完整內容。'; library.settings.geminiKey = 'EXCLUDED_CREDENTIAL_CANARY'; library.settings.audio = 'EXCLUDED_AUDIO_CANARY';
  const book = vocabulary(); book.privateData = 'EXCLUDED_PRIVATE_CANARY'; book.words[0].sentence = 'EXCLUDED_SENTENCE_CANARY';
  const blob = personalBackup(library.settings, book);
  assert.equal(blob.type, 'application/json');
  assert.doesNotMatch(await blob.text(), /EXCLUDED_|albums|tracks|transcripts|audioFile/);
  const result = await readPersonalBackup(blob);
  assert.equal(result.vocabulary.words[0].translation, '復原力'); assert.equal(result.settings.maxMinutes, 25);
  assert.equal(result.vocabulary.revision, 0); assert.equal(result.settings.guidePrompt, library.settings.guidePrompt);
});
test('backup restore only builds a preview, preserves local albums/audio metadata, and never calls an API', async () => {
  const library = placeTrack(addAlbum(emptyLibrary(), 'My saved audio', 'album'), { id: 'track', title: 'Original', duration: 120, segments: [{ start: 0, end: 120, text: 'Original words.' }] }, 'album');
  const before = JSON.stringify(library);
  const backup = await readPersonalBackup(personalBackup(emptyLibrary().settings, vocabulary()));
  const result = planPersonalRestore(library, emptyVocabulary(), backup);
  assert.equal(result.added, 1); assert.equal(JSON.stringify(library), before);
  assert.deepEqual(result.library.tracks, library.tracks); assert.deepEqual(result.library.albums, library.albums);
});
test('incompatible settings stop restore planning instead of deleting existing audio', async () => {
  const library = placeTrack(addAlbum(emptyLibrary(), 'Saved', 'album'), { id: 'track', title: 'Original', duration: 120, segments: [{ start: 0, end: 120, text: 'Original.' }] }, 'album');
  const backup = await readPersonalBackup(personalBackup({ ...emptyLibrary().settings, maxMinutes: 1 }, vocabulary()));
  assert.throws(() => planPersonalRestore(library, emptyVocabulary(), backup, { restoreSettings: true }), /長度上限/);
  assert.equal(planPersonalRestore(library, emptyVocabulary(), backup).added, 1);
  assert.equal(library.tracks.length, 1);
});
test('oversized, invalid, legacy ZIP and unexpected top-level content cannot be imported', async () => {
  await assert.rejects(readPersonalBackup({ size: MAX_BACKUP_BYTES + 1, text() { assert.fail('Oversized file must not be read'); } }));
  for (const content of ['PK-legacy-zip', '{', 'null', '{}']) await assert.rejects(readPersonalBackup(new Blob([content])));
  const data = JSON.parse(await personalBackup(emptyLibrary().settings, vocabulary()).text()); data.audio = 'UNEXPECTED_BINARY';
  await assert.rejects(readPersonalBackup(new Blob([JSON.stringify(data)])), /非預期/);
});

test('restoring an old Flash preference selects Flash-Lite while preserving collected words', async () => {
  const data = JSON.parse(await personalBackup(emptyLibrary().settings, vocabulary()).text());
  data.settings.geminiModel = 'gemini-3.8-flash'; data.settings.autoGuide = true;
  const parsed = await readPersonalBackup(new Blob([JSON.stringify(data)]));
  assert.equal(parsed.settings.geminiModel, 'gemini-3.5-flash-lite');
  assert.equal(parsed.settings.autoGuide, false);
  assert.equal(parsed.vocabulary.words[0].word, 'resilience');
});
