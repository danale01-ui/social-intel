#!/usr/bin/env node
/**
 * harvest.mjs — pull ads out of Meta's public Ad Library.
 *
 * No API key and no login. The public Ad Library web app talks to /api/graphql/, so
 * we load the page once, capture the exact search request it issues, then replay that
 * request from inside the page with our own cursor until the results run out. What
 * comes back is the full structured record for every ad: start_date, end_date,
 * is_active, collation_count, page_name, creative title/body/CTA, publisher
 * platforms, and direct video and image URLs.
 *
 * Why not the official Ad Library API: /ads_archive needs an app token plus identity
 * verification, and outside the EU it only returns political and issue ads. For
 * commercial ads in Israel it returns nothing. This route returns everything the
 * public library shows a human.
 *
 * Usage:
 *   node harvest.mjs --q 'נדל"ן בפורטוגל' --country IL --out ../runs/porto
 *   node harvest.mjs --page-id 103010829339647 --country IL --out ../runs/competitor
 *   node harvest.mjs --q 'sleep supplement' --country US --pages 10
 *
 * Flags:
 *   --q <text>          keyword search
 *   --page-id <id>      every ad from one advertiser (overrides --q)
 *   --country <ISO>     default IL
 *   --status active|all default active
 *   --media all|video|image   default all
 *   --min-age <days>    ask Meta for ads that started at least N days ago. This is the
 *                       longevity filter pushed server side, which is what makes big
 *                       categories tractable: instead of paging through 900 ads to find
 *                       the old ones, only the old ones come back.
 *   --started-before <YYYY-MM-DD>   same filter, explicit date
 *   --pages <n>         max result pages, default 40. Meta serves ~10 ads per page no
 *                       matter what we ask for, but pagination itself is not capped, so
 *                       this is a throughput knob and not a coverage ceiling.
 *   --all               keep paging until the category is exhausted (safety cap 300 pages)
 *   --with-media        download the creative during the harvest, while the signed CDN
 *                       URLs are still alive. This is the fix for expiry: no gap.
 *   --media-cap <n>     how many ads to pull creative for, oldest first. Default 25
 *   --out <dir>         output dir
 *   --headed            watch the browser work
 */
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveChromium, UA } from './lib/browser.mjs';
import { downloadCreatives } from './lib/media.mjs';
import { extractAdsFromText } from './lib/embedded.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const Q = arg('q');
const PAGE_ID = arg('page-id');
const COUNTRY = (arg('country', 'IL') || 'IL').toUpperCase();
const STATUS = arg('status', 'active');
const MEDIA = arg('media', 'all');
const MAX_PAGES = flag('all') ? 300 : Number(arg('pages', 40));
const WITH_MEDIA = flag('with-media');
const MEDIA_CAP = Number(arg('media-cap', 25));
const MIN_AGE = arg('min-age') ? Number(arg('min-age')) : null;
const STARTED_BEFORE =
  arg('started-before') ||
  (MIN_AGE ? new Date(Date.now() - MIN_AGE * 86400000).toISOString().slice(0, 10) : null);
const OUT = path.resolve(HERE, arg('out') || path.join('..', 'runs', `harvest-${COUNTRY}-${Date.now()}`));

if (!Q && !PAGE_ID) {
  console.error('Need --q "<keyword>" or --page-id <id>. See the header of this file for usage.');
  process.exit(1);
}

const params = new URLSearchParams({
  active_status: STATUS === 'all' ? 'all' : 'active',
  ad_type: 'all',
  country: COUNTRY,
  media_type: MEDIA,
});
if (PAGE_ID) {
  params.set('view_all_page_id', PAGE_ID);
  params.set('search_type', 'page');
} else {
  params.set('q', Q);
  params.set('search_type', 'keyword_unordered');
}
// The age filter deliberately does NOT go in the page URL. It is applied in the
// GraphQL variables, which is what actually filters; putting it in the URL as well
// made some searches render empty and never issue the query we need to capture.
const url = `https://www.facebook.com/ads/library/?${params.toString()}`;

/** Deep-walk any JSON and collect every object that looks like an ad record. */
function collectAds(node, sink) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectAds(n, sink);
    return;
  }
  if (typeof node.ad_archive_id === 'string' && node.snapshot) sink.set(node.ad_archive_id, node);
  for (const k of Object.keys(node)) collectAds(node[k], sink);
}

/** FB sometimes streams several JSON documents in one body, newline separated. */
function parseChunks(text) {
  const docs = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      docs.push(JSON.parse(t));
    } catch {
      /* partial chunk */
    }
  }
  return docs;
}

const exec = resolveChromium();
console.error(`[harvest] chromium: ${exec}`);
console.error(`[harvest] url: ${url}`);

const browser = await chromium.launch({ executablePath: exec, headless: !flag('headed') });
const ctx = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'Asia/Jerusalem',
  viewport: { width: 1440, height: 1200 },
  userAgent: UA,
});
const page = await ctx.newPage();

// The page issues AdLibrarySearchPaginationQuery on load. We steal its POST body,
// which carries every token FB wants (lsd, jazoest, doc_id, session id).
let template = null;
page.on('request', (r) => {
  if (template || !r.url().includes('/api/graphql')) return;
  const pd = r.postData() || '';
  if (pd.includes('AdLibrarySearchPaginationQuery')) template = pd;
});

const ads = new Map();
page.on('response', async (res) => {
  if (!res.url().includes('/api/graphql')) return;
  const text = await res.text().catch(() => null);
  if (text) for (const doc of parseChunks(text)) collectAds(doc, ads);
});

// Capturing the template is the one step that can fail for no reason: a slow first
// paint looks exactly like a broken contract. Measured behaviour is that a retry
// usually succeeds, so retry properly instead of slowing the whole run down.
const ATTEMPTS = 3;
for (let attempt = 1; attempt <= ATTEMPTS && !template; attempt++) {
  if (attempt > 1) console.error(`[harvest] search query not seen, attempt ${attempt}/${ATTEMPTS}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error(`[harvest] page load failed: ${e.message}`);
  }
  await page.waitForTimeout(6000 * attempt);
  if (template) break;
  // Scrolling nudges the list into requesting its next page, which is the request we want.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(5000 * attempt);
}
let embeddedOnly = false;
if (!template) {
  // No pagination request does not mean no ads. A result set small enough to fit in the
  // first payload never triggers a second page, so the request we listen for is never
  // issued while the ads sit rendered on screen. Read them out of the page instead.
  const html = await page.content().catch(() => '');
  for (const ad of extractAdsFromText(html)) ads.set(ad.ad_archive_id, ad);

  if (ads.size) {
    embeddedOnly = true;
    console.error(`[harvest] no pagination request (small result set). Read ${ads.size} ads from the page payload.`);
  } else {
    // Now the two real failures are distinguishable, and they need different responses.
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const empty = /\b0\s+results|no ads match|לא נמצאו|אין תוצאות/i.test(bodyText);
    if (empty) {
      console.error('[harvest] this search returned no ads. Try a broader keyword, --status all, or another country.');
    } else {
      console.error('[harvest] FATAL: no search query captured and no ads embedded in the page.');
      console.error('[harvest] run `node doctor.mjs` to see which assumption broke.');
    }
    await browser.close();
    process.exit(empty ? 2 : 3);
  }
}

const reportedCount = await page
  .evaluate(() => {
    const m = document.body.innerText.match(/~?([\d,]+)\s+results/i);
    return m ? m[1] : null;
  })
  .catch(() => null);

// Record the contract we are coding against, so a future break is diagnosable.
const contract = (() => {
  if (!template) return { doc_id: null, variables_version: null, route: 'embedded-payload' };
  const p = new URLSearchParams(template);
  let v = null;
  try {
    v = JSON.parse(p.get('variables')).v;
  } catch {
    /* ignore */
  }
  return { doc_id: p.get('doc_id'), variables_version: v, route: 'graphql-replay' };
})();

fs.mkdirSync(OUT, { recursive: true });
/** Write what we have so far, so a crash or a rate limit never costs the whole run. */
const checkpoint = () => fs.writeFileSync(path.join(OUT, 'raw-ads.json'), JSON.stringify([...ads.values()], null, 1));

let cursor = null;
let pageNo = 0;
let stalled = 0;
while (!embeddedOnly && pageNo < MAX_PAGES) {
  const result = await page.evaluate(
    async ([post, cur, startedBefore]) => {
      const p = new URLSearchParams(post);
      const v = JSON.parse(p.get('variables'));
      v.cursor = cur;
      v.first = 30; // Meta caps this at 10, asking for more is harmless
      if (startedBefore) v.startDate = { min: null, max: startedBefore };
      p.set('variables', JSON.stringify(v));
      const r = await fetch('/api/graphql/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: p.toString(),
        credentials: 'include',
      });
      return { status: r.status, body: await r.text() };
    },
    [template, cursor, STARTED_BEFORE]
  );

  if (result.body.includes('"errors"')) {
    console.error('[harvest] GraphQL returned errors, stopping:', result.body.slice(0, 200));
    break;
  }
  const before = ads.size;
  for (const doc of parseChunks(result.body)) collectAds(doc, ads);
  const pi = result.body.match(/"end_cursor":"([^"]*)","has_next_page":(true|false)/);
  pageNo++;
  console.error(
    `[harvest] page ${pageNo}: http ${result.status} -> ${ads.size} ads (+${ads.size - before}) more=${pi ? pi[2] : 'unknown'}`
  );
  if (result.status !== 200) {
    console.error('[harvest] non-200, stopping. Meta may be rate limiting; retry in a few minutes.');
    break;
  }
  if (pageNo % 5 === 0) checkpoint();
  // Meta hands back overlapping windows, so a page of pure duplicates is normal.
  // Many in a row means the cursor chain is spinning and there is nothing left.
  stalled = ads.size === before ? stalled + 1 : 0;
  if (stalled >= 8) {
    console.error('[harvest] 8 pages with nothing new, treating the category as exhausted');
    break;
  }
  if (!pi || pi[2] !== 'true' || !pi[1]) break;
  cursor = pi[1];
  await page.waitForTimeout(1200); // stay polite
}

const raw = [...ads.values()];
const meta = {
  query: Q || null,
  page_id: PAGE_ID || null,
  country: COUNTRY,
  status: STATUS,
  media: MEDIA,
  started_before: STARTED_BEFORE,
  min_age_requested: MIN_AGE,
  url,
  reported_result_count: reportedCount,
  harvested: raw.length,
  pages_fetched: pageNo,
  exhausted: embeddedOnly || pageNo < MAX_PAGES,
  route: embeddedOnly ? "embedded-payload" : "graphql-replay",
  contract,
  harvested_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
checkpoint();

console.error(
  `[harvest] done. ${raw.length} ads over ${pageNo} pages (library reports ~${reportedCount ?? '?'})${meta.exhausted ? ', category exhausted' : ', page cap reached, raise --pages or use --all'} -> ${OUT}/raw-ads.json`
);

// Download creative now, in the same session. The CDN links are signed and short
// lived, so any gap between harvest and download is a chance to lose them.
if (WITH_MEDIA && raw.length) {
  const DAY = 86400;
  const nowSec = Math.floor(Date.now() / 1000);
  const withMedia = raw
    .map((a) => {
      const s = a.snapshot || {};
      const cards = s.cards || [];
      const last = a.is_active ? Math.max(a.end_date || 0, nowSec) : a.end_date || a.start_date || 0;
      return {
        key: a.ad_archive_id,
        page_name: a.page_name,
        age_days: a.start_date ? Math.round((last - a.start_date) / DAY) : null,
        title: (s.title || '').slice(0, 80),
        snapshot_url: `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`,
        videos: [
          ...(s.videos || []).map((v) => v.video_hd_url || v.video_sd_url),
          ...cards.map((c) => c.video_hd_url || c.video_sd_url),
        ].filter(Boolean),
        images: [
          ...(s.images || []).map((i) => i.original_image_url || i.resized_image_url),
          ...cards.map((c) => c.original_image_url || c.resized_image_url),
        ].filter(Boolean),
      };
    })
    .filter((x) => x.videos.length || x.images.length)
    .sort((a, b) => (b.age_days || 0) - (a.age_days || 0))
    .slice(0, MEDIA_CAP);

  console.error(`[harvest] downloading creative for ${withMedia.length} ads, oldest first`);
  const r = await downloadCreatives(withMedia, path.join(OUT, 'creative'), { images: true });
  console.error(`[harvest] creative: ${r.ok} files${r.failed ? `, ${r.failed} failed` : ''}`);
}

await browser.close();

if (raw.length === 0) {
  console.error('[harvest] WARNING: zero ads. Either nothing matches, or Meta changed the payload shape.');
  console.error('[harvest] run `node doctor.mjs` to find out which of the two it is.');
  process.exit(2);
}
