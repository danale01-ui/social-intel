#!/usr/bin/env node
/**
 * merge.mjs — combine several harvests into one run, so a category can be swept from
 * more than one angle and still be ranked as a single picture.
 *
 * One keyword never covers a category. Advertisers describe the same product in
 * different words, and the library matches on text, so the honest way to cover a market
 * is several searches merged and de-duplicated by ad id.
 *
 * Usage:
 *   node merge.mjs --out ../runs/merged ../runs/kw1 ../runs/kw2 ../runs/kw3
 */
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
if (outIdx === -1) {
  console.error('Need --out <dir> followed by the harvest dirs to merge');
  process.exit(1);
}
const OUT = argv[outIdx + 1];
const INPUTS = argv.filter((a, i) => i !== outIdx && i !== outIdx + 1 && !a.startsWith('--'));
if (!INPUTS.length) {
  console.error('Need at least one harvest dir');
  process.exit(1);
}

const ads = new Map();
const sources = [];
for (const dir of INPUTS) {
  const rawPath = path.join(dir, 'raw-ads.json');
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(rawPath)) {
    console.error(`[merge] skipping ${dir}: no raw-ads.json`);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  const before = ads.size;
  for (const a of raw) if (a.ad_archive_id) ads.set(a.ad_archive_id, a);
  sources.push({ dir, query: meta.query || meta.page_id || null, ads: raw.length, new: ads.size - before });
  console.error(`[merge] ${meta.query || dir}: ${raw.length} ads, ${ads.size - before} new`);
}

fs.mkdirSync(OUT, { recursive: true });
const merged = [...ads.values()];
const first = sources[0] || {};
fs.writeFileSync(
  path.join(OUT, 'meta.json'),
  JSON.stringify(
    {
      query: sources.map((s) => s.query).filter(Boolean).join(' + '),
      merged_from: sources,
      country: (() => {
        const m = path.join(INPUTS[0], 'meta.json');
        return fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')).country : null;
      })(),
      status: 'active',
      harvested: merged.length,
      harvested_at: new Date().toISOString(),
    },
    null,
    2
  )
);
fs.writeFileSync(path.join(OUT, 'raw-ads.json'), JSON.stringify(merged, null, 1));

// carry over any creative already downloaded, so the merged run is self contained
const outCreative = path.join(OUT, 'creative');
const index = [];
for (const dir of INPUTS) {
  const src = path.join(dir, 'creative');
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(outCreative, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f === 'index.json') continue;
    const target = path.join(outCreative, f);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(src, f), target);
  }
  const idx = path.join(src, 'index.json');
  if (fs.existsSync(idx)) index.push(...JSON.parse(fs.readFileSync(idx, 'utf8')));
}
if (index.length) fs.writeFileSync(path.join(outCreative, 'index.json'), JSON.stringify(index, null, 1));

console.error(`[merge] ${merged.length} unique ads from ${sources.length} harvests -> ${OUT}`);
