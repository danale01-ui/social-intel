#!/usr/bin/env node
/**
 * doctor.mjs — check that Meta's Ad Library still behaves the way this skill assumes.
 *
 * The skill rides a private endpoint. When Meta changes it, the useful question is not
 * "did it break" but "which part broke", because each part has a different fix:
 * a renamed query means re-capturing the template, a missing field means the ranker
 * loses one signal, a dead date filter means large categories need another strategy.
 *
 * Run it before a session that matters, and after any harvest that returns oddly little.
 * Exit 0 = every assumption holds. Exit 1 = something moved, and the report says what.
 *
 * Usage: node doctor.mjs [--country IL] [--q "<keyword>"]
 */
import { chromium } from 'playwright-core';
import { resolveChromium, UA } from './lib/browser.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const COUNTRY = arg('country', 'IL');
const Q = arg('q', 'קורס');

const checks = [];
const check = (name, pass, detail, fix) => {
  checks.push({ name, pass, detail, fix });
  console.error(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass && fix) console.error(`        fix: ${fix}`);
};

const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${COUNTRY}&media_type=all&q=${encodeURIComponent(
  Q
)}&search_type=keyword_unordered`;

const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true });
const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1200 }, userAgent: UA });
const page = await ctx.newPage();

let template = null;
page.on('request', (r) => {
  if (template || !r.url().includes('/api/graphql')) return;
  const pd = r.postData() || '';
  if (pd.includes('AdLibrarySearchPaginationQuery')) template = pd;
});

console.error(`[doctor] probing ${COUNTRY} / "${Q}"\n`);

let loaded = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  loaded = true;
} catch (e) {
  check('the public Ad Library loads without login', false, e.message, 'check network access to facebook.com');
}
if (loaded) check('the public Ad Library loads without login', true);

if (!template) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(6000);
}
check(
  'the page still issues AdLibrarySearchPaginationQuery',
  !!template,
  template ? `doc_id ${new URLSearchParams(template).get('doc_id')}` : 'query not seen',
  'Meta renamed the search query. Capture the new name in devtools and update harvest.mjs.'
);

if (template) {
  const call = (patch) =>
    page.evaluate(
      async ([post, p]) => {
        const params = new URLSearchParams(post);
        const v = JSON.parse(params.get('variables'));
        Object.assign(v, p);
        params.set('variables', JSON.stringify(v));
        const r = await fetch('/api/graphql/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          credentials: 'include',
        });
        return { status: r.status, body: await r.text() };
      },
      [template, patch]
    );

  const base = await call({ cursor: null, first: 30 });
  const okBase = base.status === 200 && !base.body.includes('"errors"');
  check('replaying the search from inside the page returns data', okBase, `http ${base.status}, ${base.body.length} bytes`,
    'FB may now bind the request to headers we are not sending. Compare against a real request in devtools.');

  if (okBase) {
    // every field the ranker depends on
    const needed = {
      ad_archive_id: 'nothing works without it',
      start_date: 'the whole longevity signal',
      end_date: 'age of active ads',
      is_active: 'proven vs retired',
      collation_count: 'the variants signal',
      page_name: 'who is advertising',
      snapshot: 'all creative content',
      display_format: 'video vs image',
      publisher_platform: 'where it runs',
    };
    const missing = Object.keys(needed).filter((k) => !base.body.includes(`"${k}"`));
    check('every field the ranker reads is present', missing.length === 0,
      missing.length ? `missing: ${missing.map((m) => `${m} (${needed[m]})`).join(', ')}` : `${Object.keys(needed).length} fields`,
      'Drop the missing signal from rank.mjs scoring rather than shipping a silent zero.');

    const creative = ['video_hd_url', 'original_image_url', 'cta_text'].filter((k) => base.body.includes(`"${k}"`));
    check('creative URLs and CTA still come through', creative.length >= 2, `found: ${creative.join(', ') || 'none'}`,
      'fetch-media.mjs and the CTA column go dark. Check the snapshot shape.');

    const pi = base.body.match(/"end_cursor":"([^"]*)","has_next_page":(true|false)/);
    check('pagination cursor is where we expect it', !!pi, pi ? `has_next_page=${pi[2]}` : 'page_info not found',
      'Harvest will stop after one page. Find the new page_info path.');

    const ids = new Set([...base.body.matchAll(/"ad_archive_id":"(\d+)"/g)].map((m) => m[1]));
    check('a page still carries ~10 ads', ids.size >= 5, `${ids.size} ads on page 1`,
      'If this drops, raise --pages; if it rises, we can harvest faster.');

    // the date filter is what makes large categories tractable
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const filtered = await call({ cursor: null, first: 30, startDate: { min: null, max: cutoff } });
    const okFilter = filtered.status === 200 && !filtered.body.includes('"errors"');
    let respected = false;
    if (okFilter) {
      const starts = [...filtered.body.matchAll(/"start_date":(\d+)/g)].map((m) => Number(m[1]) * 1000);
      respected = starts.length > 0 && starts.every((t) => t <= Date.parse(cutoff) + 86400000);
    }
    check('the startDate filter is accepted and respected', okFilter && respected,
      okFilter ? (respected ? `cutoff ${cutoff} honoured` : 'accepted but newer ads still came back') : 'rejected',
      'This is what makes big categories tractable. Without it, harvest everything and filter in rank.mjs, and expect long runs.');
  }
}

await browser.close();

const failed = checks.filter((c) => !c.pass);
console.error(`\n[doctor] ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`[doctor] broken: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(1);
}
