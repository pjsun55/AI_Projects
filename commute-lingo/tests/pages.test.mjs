import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { PUBLIC_FILES, packagePages } from '../tools/package-pages.mjs';

async function fixture() {
  const tmp = new URL('../.tmp/', import.meta.url); await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(new URL('pages-test-', tmp));
  for (const [app, names] of Object.entries(PUBLIC_FILES)) for (const name of names) {
    const file = `${root}/${app}/public/${name}`;
    await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    await writeFile(file, `public fixture ${app}/${name}`);
  }
  return root;
}
test('Pages packages only reviewed assets, preserving both applications and excluding documents/exports', async () => {
  const root = await fixture();
  try {
    for (const name of ['private.md', '.env', 'secrets.json', 'recording.mp3', 'backup.zip']) await writeFile(`${root}/commute-lingo/public/${name}`, 'NON_SECRET_CANARY');
    const files = await packagePages({ repositoryRoot: root, destination: `${root}/site` });
    assert.equal(files.length, Object.values(PUBLIC_FILES).flat().length);
    assert.deepEqual((await readdir(`${root}/site`)).sort(), ['commute-lingo', 'ios-pwa-lab']);
    assert.equal((await readFile(`${root}/site/ios-pwa-lab/index.html`, 'utf8')), 'public fixture ios-pwa-lab/index.html');
    assert.equal((await readdir(`${root}/site/commute-lingo`)).includes('secrets.json'), false);
    await writeFile(`${root}/site/do-not-delete`, 'original');
    await assert.rejects(packagePages({ repositoryRoot: root, destination: `${root}/site` }), { code: 'EEXIST' });
    assert.equal(await readFile(`${root}/site/do-not-delete`, 'utf8'), 'original');
  } finally { await rm(root, { recursive: true }); }
});
test('Pages refuses a symlink to a private file even when the target remains inside the repository', async () => {
  const root = await fixture();
  try {
    await writeFile(`${root}/private.txt`, 'NON_SECRET_CANARY');
    const publicFile = `${root}/commute-lingo/public/index.html`;
    await rm(publicFile); await symlink(`${root}/private.txt`, publicFile);
    await assert.rejects(packagePages({ repositoryRoot: root, destination: `${root}/site` }), /symlink/);
  } finally { await rm(root, { recursive: true }); }
});
