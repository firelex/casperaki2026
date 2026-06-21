#!/usr/bin/env node
// Recursively download files from a public Dropbox shared-folder page.
//
// Usage:
//   node scripts/download-dropbox-shared-folder.mjs \
//     "https://www.dropbox.com/scl/fo/<link_key>/<secure_hash>?rlkey=...&dl=0" \
//     /mnt/d/casperaki-samples
//
// The /scl/fo/ page is a client-side React app, so the file listing is not in
// the initial HTML. We hit the same internal XHR endpoint the page uses —
// `list_shared_link_folder_entries` — to walk the tree, then download each
// file via its href with `dl=1`.

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const [, , startUrl, outRootArg] = process.argv;

if (!startUrl || !outRootArg) {
  console.error('usage: node scripts/download-dropbox-shared-folder.mjs <dropbox-folder-url> <out-dir>');
  process.exit(1);
}

const outRoot = outRootArg;
const rootUrl = new URL(startUrl);
const rootSegs = rootUrl.pathname.split('/').filter(Boolean);
if (rootSegs[0] !== 'scl' || rootSegs[1] !== 'fo' || !rootSegs[2] || !rootSegs[3]) {
  console.error('expected a /scl/fo/<link_key>/<secure_hash> URL');
  process.exit(1);
}
const linkKey = rootSegs[2];
const rootSecureHash = rootSegs[3];
const rlkey = rootUrl.searchParams.get('rlkey') ?? '';

// Top-level folder names to skip entirely (folder and everything below it).
const SKIP_TOP_LEVEL = new Set([
  'drumTracks',
  'loopStretcher',
  'sample export ProTools',
]);

const cookies = new Map();
const visitedFolders = new Set();
const visitedFiles = new Set();

await bootstrapCookies();
await crawl(rootSecureHash, '');

async function bootstrapCookies() {
  const res = await fetch(folderPageUrl(rootSecureHash, ''), {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  storeCookies(res);
  await res.arrayBuffer().catch(() => {});
  if (!cookies.get('__Host-js_csrf')) {
    throw new Error('failed to obtain __Host-js_csrf cookie from Dropbox');
  }
}

async function crawl(secureHash, subPath) {
  const key = `${secureHash}|${subPath}`;
  if (visitedFolders.has(key)) return;
  visitedFolders.add(key);

  console.error(`[folder] ${subPath || '/'}`);

  let voucher = '';
  while (true) {
    const data = await listEntries(secureHash, subPath, voucher);
    const entries = data.entries ?? [];
    for (const e of entries) {
      if (subPath === '' && SKIP_TOP_LEVEL.has(e.filename)) {
        console.error(`[skip-tree] ${e.filename}`);
        continue;
      }
      if (e.is_dir) {
        const sub = parseFolderHref(e.href);
        await crawl(sub.secureHash, sub.subPath);
      } else {
        await downloadFile(e.href);
      }
    }
    if (!data.has_more_entries) break;
    const next = data.next_request_voucher ?? '';
    if (!next || next === voucher) break;
    voucher = next;
  }
}

async function listEntries(secureHash, subPath, voucher) {
  const form = new URLSearchParams();
  form.set('is_xhr', 'true');
  form.set('t', cookies.get('__Host-js_csrf') ?? '');
  form.set('link_key', linkKey);
  form.set('link_type', 's');
  form.set('secure_hash', secureHash);
  if (rlkey) form.set('rlkey', rlkey);
  form.set('sub_path', subPath);
  if (voucher) form.set('voucher', voucher);

  const res = await fetch('https://www.dropbox.com/list_shared_link_folder_entries', {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0',
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'https://www.dropbox.com',
      referer: folderPageUrl(secureHash, subPath),
      cookie: cookieHeader(),
    },
    body: form.toString(),
  });
  storeCookies(res);
  if (!res.ok) {
    throw new Error(`list failed ${res.status} ${res.statusText} for sub_path=${subPath || '/'}`);
  }
  return res.json();
}

async function downloadFile(fileHref) {
  const rel = relPathFromHref(fileHref);
  if (visitedFiles.has(rel)) return;
  visitedFiles.add(rel);

  const dest = join(outRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });

  if (existsSync(dest) && statSync(dest).size > 0) {
    console.error(`[skip] ${rel}`);
    return;
  }

  const url = new URL(fileHref);
  url.searchParams.set('dl', '1');

  console.error(`[file] ${rel}`);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0', cookie: cookieHeader() },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    throw new Error(`Dropbox returned HTML instead of file bytes for ${url}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

function folderPageUrl(secureHash, subPath) {
  const encodedSub = subPath
    ? '/' + subPath.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    : '';
  const u = new URL(`https://www.dropbox.com/scl/fo/${linkKey}/${secureHash}${encodedSub}`);
  if (rlkey) u.searchParams.set('rlkey', rlkey);
  u.searchParams.set('dl', '0');
  return u.toString();
}

function parseFolderHref(href) {
  const u = new URL(href);
  const segs = u.pathname.split('/').filter(Boolean);
  // ['scl','fo', linkKey, secureHash, ...subPathParts]
  return {
    secureHash: segs[3],
    subPath: '/' + segs.slice(4).map(decodeURIComponent).join('/'),
  };
}

function relPathFromHref(href) {
  const u = new URL(href);
  const segs = u.pathname.split('/').filter(Boolean);
  return segs.slice(4).map(decodeURIComponent).join('/');
}

function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
