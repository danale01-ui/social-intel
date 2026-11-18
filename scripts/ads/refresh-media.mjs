#!/usr/bin/env node
/**
 * refresh-media.mjs — recover creative whose signed URLs have expired.
 *
 * The URLs in an old run are dead within hours. The single-ad page is server rendered,
 * so loading `ads/library/?id=<ad_archive_id>` mints a fresh signed URL for the same
 * creative. This walks the ads in a run that have no local file yet and re-resolves them.
 *
 * Prefer `harvest.mjs --with-media`, which never lets the URLs go stale in the first
 * place. This is the recovery path for runs harvested before that, or for a run whose
 * download was interrupted.
 *
 * Usage:
 *   node refresh-media.mjs --in ../runs/porto-il [--top 8] [--images]
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { resolveChromium, UA } from './lib/browser.mjs';
import { downloadCreatives } from './lib/media.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const IN = arg('in');
const TOP = Number(arg('top', 8));
const WANT_IMAGES = argv.includes('--images');
if (!IN) {
  console.error('Need --in <harvest dir>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(IN, 'media-manifest.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(IN, 'meta.json'), 'utf8'));
const country = meta.country || 'IL';

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1200 }, userAgent: UA });
const page = await ctx.newPage();

const unescape = (s) => s.replace(/\\u0025/g, '%').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\/g, '');

const refreshed = [];
for (const item of manifest.slice(0, TOP)) {
  const adId = (item.ad_ids && item.ad_ids[0]) || (item.snapshot_url || '').split('id=')[1];
  if (!adId) continue;
  const single = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&id=${adId}`;
  try {
    await page.goto(single, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const html = await page.content();
    const idx = html.indexOf(`"ad_archive_id":"${adId}"`);
    const scope = idx === -1 ? html : html.slice(idx, idx + 40000);
    const videos = [...scope.matchAll(/"video_hd_url":"([^"]{20,})"/g)].map((m) => unescape(m[1]));
    const images = [...scope.matchAll(/"original_image_url":"([^"]{20,})"/g)].map((m) => unescape(m[1]));
    if (!videos.length && !images.length) {
      console.error(`[refresh] ${adId}: no media on the page. The ad may have been taken down.`);
      continue;
    }
    refreshed.push({ ...item, key: adId, videos: [...new Set(videos)], images: [...new Set(images)] });
    console.error(`[refresh] ${adId}: ${videos.length} videos, ${images.length} images`);
  } catch (e) {
    console.error(`[refresh] ${adId}: ${e.message}`);
  }
  await page.waitForTimeout(1500);
}

await browser.close();

if (!refreshed.length) {
  console.error('[refresh] nothing to download.');
  process.exit(2);
}
const r = await downloadCreatives(refreshed, path.join(IN, 'creative'), { images: WANT_IMAGES });
console.error(`[refresh] ${r.ok} files recovered${r.failed ? `, ${r.failed} failed` : ''}`);
