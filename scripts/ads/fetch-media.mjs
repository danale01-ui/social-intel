#!/usr/bin/env node
/**
 * fetch-media.mjs — download the creative behind the winning ads, from a run's manifest.
 *
 * Reading an ad's copy tells you the hook. Watching it tells you the craft: the first
 * frame, the pacing, whether it is a talking head or a b-roll montage, where the text
 * sits. Once the files are local, hand them to the ai-video-analyzer skill.
 *
 * Prefer `harvest.mjs --with-media`. Meta's CDN URLs are signed and expire within hours,
 * so this only works if the run is fresh. If it is not, use `refresh-media.mjs`.
 *
 * Usage:
 *   node fetch-media.mjs --in ../runs/porto-il [--top 8] [--images]
 */
import fs from 'fs';
import path from 'path';
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
const items = manifest.slice(0, TOP).map((m) => ({ ...m, key: (m.ad_ids && m.ad_ids[0]) || m.concept_id }));

const r = await downloadCreatives(items, path.join(IN, 'creative'), { images: WANT_IMAGES });
console.error(`[media] ${r.ok} files -> ${path.join(IN, 'creative')}${r.failed ? `, ${r.failed} failed` : ''}`);
if (r.failed && !r.ok) {
  console.error('[media] every download failed. The signed URLs have expired: run refresh-media.mjs instead.');
  process.exit(2);
}
