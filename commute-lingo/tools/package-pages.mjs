import { mkdir, lstat, readFile, realpath, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inside = (root, target) => target.startsWith(root + path.sep);
export const PUBLIC_FILES = Object.freeze({
  'commute-lingo': [
    'index.html', 'styles.css', 'sw.js', 'icon.svg', 'manifest.webmanifest',
    ...['journey', 'dialogue', 'sunrise'].flatMap(name => [`icon-${name}.svg`, `icon-${name}-192.png`, `icon-${name}-512.png`, `manifest-${name}.webmanifest`]),
    ...['app', 'asr', 'backup', 'core', 'decode', 'decoder', 'gestures', 'icons', 'library', 'network', 'source', 'storage', 'subtitles', 'transcriber', 'translation'].map(name => `${name}.mjs`)
  ],
  'ios-pwa-lab': ['index.html', 'styles.css', 'app.js', 'core.js', 'catalog.js', 'storage.js', 'probes.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'worker.js', 'sw.js', 'network-test.json']
});

export async function publicInventory(repositoryRoot) {
  const repository = await realpath(repositoryRoot), files = [];
  for (const [app, names] of Object.entries(PUBLIC_FILES)) {
    for (const name of names) {
      const relative = path.join(app, 'public', name);
      let cursor = repository;
      for (const part of relative.split(path.sep)) {
        cursor = path.join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Refusing symlink: ${relative}`);
      }
      const actual = await realpath(cursor), info = await lstat(actual);
      if (!inside(repository, actual) || !info.isFile() || info.nlink !== 1) throw new Error(`Invalid public file: ${relative}`);
      const bytes = await readFile(actual);
      files.push({ source: actual, destination: `${app}/${name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files;
}

export async function packagePages({ repositoryRoot = path.dirname(project), destination = path.join(project, '.tmp/pages-site') } = {}) {
  const repository = await realpath(repositoryRoot);
  const parent = await realpath(path.dirname(destination));
  if ((parent !== repository && !inside(repository, parent)) || !inside(repository, path.resolve(destination))) throw new Error('Output must stay inside the repository.');
  const files = await publicInventory(repository);
  // Never reuse an output directory: stale/private files must not be uploaded.
  await mkdir(destination);
  for (const item of files) {
    const target = path.join(destination, item.destination);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(item.source, target);
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== item.sha256) throw new Error('Public asset changed during packaging.');
  }
  return files.map(({ source, ...item }) => item);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await mkdir(path.join(project, '.tmp'), { recursive: true });
  console.log(JSON.stringify({ files: await packagePages() }, null, 2));
}
