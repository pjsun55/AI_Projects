import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, candidateCSP } from '../tools/server.mjs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';

test('preview serves every declared shell asset and does not expose project documents', async () => {
  const server = await createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const shell = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    const assets = vm.runInNewContext(shell + '\nASSETS', { URL, self: { registration: { scope: origin + '/' }, addEventListener() {} } });
    for (const route of [...assets, './sw.js']) {
      const response = await fetch(new URL(route, origin)); assert.equal(response.status, 200, route); assert.ok((await response.arrayBuffer()).byteLength > 10, route);
      if (route.endsWith('.png')) assert.equal(response.headers.get('content-type'), 'image/png');
      if (/\.mjs(?:\?|$)/.test(route)) assert.match(response.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(origin + '/PROJECT_PLAN.md')).status, 404);
    assert.equal((await fetch(origin + '/%2e%2e%2fPROJECT_PLAN.md')).status, 403);
    assert.equal((await fetch(origin + '/%E0%A4%A')).status, 400);
    assert.equal((await fetch(origin + '/', { method: 'POST' })).status, 405);
    const head = await fetch(origin + '/app.mjs', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.match(head.headers.get('content-type'), /javascript/); assert.equal(await head.text(), '');
    const html = await (await fetch(origin)).text();
    assert.match(html, /CommuteLingo/);
    const headers = (await fetch(origin)).headers;
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.match(headers.get('permissions-policy'), /microphone=\(\)/);
    assert.equal(headers.get('content-security-policy-report-only'), candidateCSP);
    assert.equal(headers.get('content-security-policy'), "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"); // Script restrictions await real WASM/browser verification.
    const unexpectedHost = await new Promise((resolve, reject) => {
      http.get(origin, { headers: { Host: 'attacker.example.com' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(unexpectedHost, 403);
    for (const name of ['.security-review.env', 'security-review.secret']) {
      const fixture = new URL(`../public/${name}`, import.meta.url);
      await writeFile(fixture, 'NON_SECRET_REVIEW_CANARY', { flag: 'wx' });
      try { assert.equal((await fetch(origin + '/' + name)).status, 404); }
      finally { await unlink(fixture); }
    }
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('preview supports the Pages subpath without exposing assets outside its scope', async () => {
  const base = '/AI_Projects/commute-lingo/', server = await createServer({ basePath: base });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + base)).status, 200);
    assert.equal((await fetch(origin + base + 'app.mjs')).status, 200);
    assert.equal((await fetch(origin + '/app.mjs')).status, 404);
    assert.equal((await fetch(origin + base + '%2e%2e%2fpackage.json')).status, 403);
    assert.equal((await fetch(origin + base)).headers.get('referrer-policy'), 'no-referrer');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
