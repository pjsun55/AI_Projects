import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function affectedApps(files) {
  const common = files.some(file => file === '.github/workflows/ios-pwa-lab.yml' || ['commute-lingo/tools/changed-apps.mjs', 'commute-lingo/tools/package-pages.mjs'].includes(file));
  const matches = app => files.some(file => new RegExp(`^${app}/(?:public/|tests/|tools/|package(?:-lock)?\\.json$|playwright\\.config\\.js$)`).test(file));
  return { lab: common || matches('ios-pwa-lab'), commute: common || matches('commute-lingo') };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_EVENT_PATH) throw new Error('This entry point is for GitHub Actions.');
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let result = { lab: true, commute: true }; // Manual/unknown events fail closed: test both.
  if (['push', 'pull_request'].includes(process.env.GITHUB_EVENT_NAME)) {
    let base = event.pull_request?.base?.sha;
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      // Compare against the last successful release workflow, so changes from
      // an earlier failed run cannot slip into a later app's deployment untested.
      try {
        const repository = process.env.GITHUB_REPOSITORY;
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid repository');
        const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/ios-pwa-lab.yml/runs?branch=main&status=success&event=push&per_page=1`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error('Release history unavailable');
        const previous = (await response.json()).workflow_runs?.[0];
        if (previous?.head_branch === 'main' && previous.event === 'push' && previous.conclusion === 'success') base = previous.head_sha;
      } catch { /* Missing release history requires both suites below. */ }
    }
    const head = process.env.GITHUB_EVENT_NAME === 'push' ? event.after : event.pull_request?.head?.sha;
    if (/^[0-9a-f]{40}$/.test(base || '') && /^[0-9a-f]{40}$/.test(head || '') && !/^0+$/.test(base)) {
      try {
        const range = process.env.GITHUB_EVENT_NAME === 'pull_request' ? [base + '...' + head] : [base, head];
        const names = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', ...range], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
        result = affectedApps(names);
      } catch { /* Unavailable history must never skip testing. */ }
    }
  }
  await appendFile(process.env.GITHUB_OUTPUT, `lab=${result.lab}\ncommute=${result.commute}\n`);
  console.log(JSON.stringify(result));
}
