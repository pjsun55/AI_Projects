import test from 'node:test';
import assert from 'node:assert/strict';
import { longPress, isMobileLandscape } from '../public/gestures.mjs';
import { crc32, zipFiles } from '../public/backup.mjs';

test('long press fires once; scrolling and pointer cancellation never translate', () => {
  const handlers = new Map(); let pending, translated = 0;
  const element = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const timers = { setTimeout: fn => { pending = fn; return 1; }, clearTimeout: () => { pending = null; } };
  const cleanup = longPress(element, () => { translated++; }, { timers });
  handlers.get('pointerdown')({ button: 0, clientX: 1, clientY: 1 }); pending(); assert.equal(translated, 1);
  let prevented = 0; handlers.get('click')({ preventDefault() { prevented++; }, stopPropagation() {} }); assert.equal(prevented, 1);
  handlers.get('pointerdown')({ button: 0, clientX: 1, clientY: 1 }); handlers.get('pointermove')({ clientX: 1, clientY: 40 }); assert.equal(pending, null);
  handlers.get('pointerdown')({ button: 0, clientX: 1, clientY: 1 }); handlers.get('pointercancel')(); assert.equal(pending, null);
  handlers.get('keydown')({ key: 'Enter', preventDefault() {} }); assert.equal(translated, 2);
  cleanup(); assert.equal(handlers.size, 0);
});
test('portrait-only gate ignores a portrait software keyboard and a landscape desktop monitor', () => {
  assert.equal(isMobileLandscape({ coarse: true, orientationType: 'portrait-primary', width: 900, height: 300 }), false);
  assert.equal(isMobileLandscape({ coarse: false, orientationType: 'landscape-primary' }), false);
  assert.equal(isMobileLandscape({ coarse: true, orientationType: 'landscape-secondary' }), true);
  assert.equal(isMobileLandscape({ coarse: true, orientationAngle: 90 }), true);
});
test('tablets support both orientations while narrow phones keep their portrait gate', () => {
  for (const [width, height] of [[800, 1280], [1280, 800], [600, 960], [960, 600]]) {
    assert.equal(isMobileLandscape({ coarse: true, width, height, orientationType: 'landscape-primary' }), false);
    assert.equal(isMobileLandscape({ coarse: true, width, height, orientationAngle: 90 }), false);
    assert.equal(isMobileLandscape({ coarse: true, width, height }), false);
  }
  assert.equal(isMobileLandscape({ coarse: true, width: 874, height: 402, orientationType: 'landscape-primary' }), true);
  assert.equal(isMobileLandscape({ coarse: true, width: 960, height: 599, orientationAngle: 90 }), true);
});
test('ZIP backup has real CRC, UTF-8 names, original audio bytes, and a valid central directory', async () => {
  assert.equal(await crc32(new Blob(['123456789'])), 0xcbf43926);
  const files = [{ name: 'audio/test.mp3', blob: new Blob([new Uint8Array([3, 1, 4, 1, 5])]) }, { name: '字幕.json', blob: new Blob(['{"text":"測試"}']) }];
  const archive = new Uint8Array(await (await zipFiles(files)).arrayBuffer()); const view = new DataView(archive.buffer);
  let offset = 0;
  for (const file of files) {
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const nameLength = view.getUint16(offset + 26, true), size = view.getUint32(offset + 18, true);
    assert.equal(new TextDecoder().decode(archive.subarray(offset + 30, offset + 30 + nameLength)), file.name);
    assert.deepEqual(archive.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size), new Uint8Array(await file.blob.arrayBuffer()));
    offset += 30 + nameLength + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  assert.equal(view.getUint32(archive.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(archive.length - 12, true), files.length);
  await assert.rejects(zipFiles([{ name: '../invalid', blob: new Blob() }]), /名稱無效/);
});
