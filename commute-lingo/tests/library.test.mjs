import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, DEFAULT_SETTINGS, validateSettings, checkDuration, addAlbum, removeAlbum, removeTrack, rename, tracksIn, placeTrack, changeSettings, playbackQueue, sentenceTarget, legacyLibrary, libraryBytes } from '../public/library.mjs';

const track = (id, seconds = 60) => ({ id, title: `Audio ${id}`, duration: seconds, size: 1234, segments: [{ start: 0, end: seconds, text: 'One complete sentence.' }] });
function albumLibrary() { return addAlbum(emptyLibrary(), 'On the train', 'a'); }
test('defaults and hard limits match the requested 3 albums / 3 per album / 20 minutes', () => {
  assert.deepEqual([DEFAULT_SETTINGS.albumLimit, DEFAULT_SETTINGS.trackLimit, DEFAULT_SETTINGS.maxMinutes], [3, 3, 20]);
  assert.doesNotThrow(() => validateSettings({ albumLimit: 5, trackLimit: 5, maxMinutes: 35 }));
  for (const input of [{ albumLimit: 6 }, { trackLimit: 0 }, { maxMinutes: 36 }, { maxMinutes: 20.5 }, { model: 'unknown' }, { icon: 'unknown' }]) assert.throws(() => validateSettings(input));
  assert.equal('apiKey' in validateSettings({ apiKey: 'test-placeholder' }), false);
  assert.equal(validateSettings({ icon: 'dialogue' }).icon, 'sunrise'); // Earlier icon preferences adopt the fixed orange choice.
  assert.doesNotThrow(() => checkDuration(1200, DEFAULT_SETTINGS));
  assert.throws(() => checkDuration(1200.01, DEFAULT_SETTINGS), /超過/);
});
test('album creation enforces quota and rename preserves audio links', () => {
  let library = albumLibrary(); library = addAlbum(library, 'B', 'b'); library = addAlbum(library, 'C', 'c');
  assert.throws(() => addAlbum(library, 'D', 'd'), /專輯數量已滿/);
  library = placeTrack(library, track('one'), 'a');
  const renamed = rename(library, 'album', 'a', 'New name');
  assert.equal(renamed.albums[0].title, 'New name'); assert.equal(renamed.tracks[0].albumId, 'a');
  assert.equal(library.albums[0].title, 'On the train');
  assert.throws(() => rename(library, 'track', 'one', '  '));
});
test('episode quotas are per album; a full album requires an explicit same-album replacement', () => {
  let library = addAlbum(albumLibrary(), 'B', 'b');
  for (const id of ['one', 'two', 'three']) library = placeTrack(library, track(id), 'a');
  library = placeTrack(library, track('other'), 'b');
  assert.equal(library.tracks.length, 4);
  assert.throws(() => placeTrack(library, track('four'), 'a'), /已滿/);
  assert.throws(() => placeTrack(library, track('four'), 'a', 'other'), /所選專輯/);
  const replaced = placeTrack(library, track('four'), 'a', 'two');
  assert.deepEqual(tracksIn(replaced, 'a').map(item => item.id), ['one', 'three', 'four']);
  assert.deepEqual(tracksIn(library, 'a').map(item => item.id), ['one', 'two', 'three']);
});
test('failed placement does not delete the old audio or album; lengths are rechecked at save', () => {
  let library = placeTrack(albumLibrary(), track('old'), 'a');
  assert.throws(() => placeTrack(library, track('new', 1201), 'a', 'old'), /超過/);
  assert.equal(library.tracks[0].id, 'old');
  assert.throws(() => placeTrack(library, { ...track('new'), segments: [] }, 'a', 'old'), /有效段落/);
  assert.equal(library.tracks[0].id, 'old');
});
test('deleting an album removes its own episodes and playback only, leaving the other album', () => {
  let library = addAlbum(albumLibrary(), 'B', 'b');
  library = placeTrack(placeTrack(library, track('one'), 'a'), track('two'), 'b');
  library.playback = { trackId: 'one' };
  const next = removeAlbum(library, 'a');
  assert.deepEqual(next.albums.map(album => album.id), ['b']); assert.deepEqual(next.tracks.map(item => item.id), ['two']); assert.equal(next.playback, null);
  assert.equal(libraryBytes(next), 1234);
  assert.equal(removeTrack(next, 'two').tracks.length, 0);
});
test('reducing settings cannot silently discard albums, episodes, or oversized audio', () => {
  let library = addAlbum(albumLibrary(), 'B', 'b');
  library = placeTrack(placeTrack(library, track('one', 700), 'a'), track('two'), 'a');
  for (const settings of [{ albumLimit: 1 }, { trackLimit: 1 }, { maxMinutes: 10 }]) assert.throws(() => changeSettings(library, settings), /先至檔案管理/);
  assert.equal(changeSettings(library, { subtitleSize: 'xlarge' }).settings.subtitleSize, 'xlarge');
});
test('album and single-episode queues are distinct; sentence navigation respects source timestamps', () => {
  let library = albumLibrary(); for (const id of ['a1', 'a2', 'a3']) library = placeTrack(library, track(id), 'a');
  assert.deepEqual(playbackQueue(library, 'a'), ['a1', 'a2', 'a3']);
  assert.deepEqual(playbackQueue(library, 'a', 'a2'), ['a2', 'a3']);
  assert.deepEqual(playbackQueue(library, null, 'a2'), ['a2']);
  const cues = [{ start: 0 }, { start: 5.2 }, { start: 12.8 }];
  assert.equal(sentenceTarget(cues, 5.2, -1), 0); assert.equal(sentenceTarget(cues, 7, -1), 5.2);
  assert.equal(sentenceTarget(cues, 6, 1), 12.8); assert.equal(sentenceTarget(cues, 14, 1), null);
});
test('old saved 22-minute episode migrates intact with an explicitly adjusted length preference', () => {
  const saved = { file: new Blob(['example'], { type: 'audio/mpeg' }), name: 'Old episode', doc: { audio: { duration: 1335.64 }, language: 'en', segments: [{ start: 0, end: 1335.64, text: 'Existing saved words.' }] } };
  const result = legacyLibrary(saved);
  assert.equal(result.library.settings.maxMinutes, 23); assert.equal(result.library.tracks[0].title, 'Old episode');
  assert.equal(result.audio.blob, saved.file); assert.equal(result.library.tracks[0].segments[0].end, 1335.64);
  assert.equal(legacyLibrary({ ...saved, doc: { ...saved.doc, audio: { duration: 2200 } } }), null);
  assert.equal(legacyLibrary({ file: saved.file }), null);
});
