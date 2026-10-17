export async function seedFixture({ version }) {
  const size = 120 * 32000 + 44;
  const library = await import(`./library.mjs?v=${version}`), storage = await import(`./storage.mjs?v=${version}`);
  let data = library.addAlbum(library.emptyLibrary(), 'Public browser fixture', 'fixture-album');
  data = library.placeTrack(data, { id: 'fixture-track', title: 'A public test episode with a longer title for narrow mobile screens', duration: 120, language: 'en', size,
    segments: Array.from({ length: 20 }, (_, i) => ({ start: i * 6, end: (i + 1) * 6, text: `Sentence ${i + 1} is public test content for the commute reading layout.` })) }, 'fixture-album');
  const bytes = new ArrayBuffer(size), view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, size - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, size - 44, true);
  data.revision = 1;
  await storage.commitLibrary(data, { expectedRevision: 0, audio: { id: 'fixture-track', blob: new Blob([bytes], { type: 'audio/wav' }) } });
  const stored = await storage.read('audio:fixture-track');
  if (!(stored instanceof Blob) || stored.size !== bytes.byteLength || stored.type !== 'audio/wav') throw new Error('Stored fixture audio must retain its Blob size and MIME type.');
  const actual = new Uint8Array(await stored.arrayBuffer()), expected = new Uint8Array(bytes);
  if (actual.some((byte, index) => byte !== expected[index])) throw new Error('Stored fixture audio bytes changed.');
}
