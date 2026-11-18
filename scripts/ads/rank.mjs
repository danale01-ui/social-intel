#!/usr/bin/env node
/**
 * rank.mjs — turn a raw harvest into "which of these ads is probably working".
 *
 * The core bet: an ad that has been running for weeks is an ad someone keeps paying
 * for. That is the only performance signal the public Ad Library gives us, so we do
 * not pretend it is more than it is. Longevity alone can also mean a neglected
 * account, so every ad carries its corroborating signals next to its age, and an ad
 * that has nothing but age is labelled as such.
 *
 * Usage:
 *   node rank.mjs --in runs/porto [--min-age 30] [--top 15] [--out runs/porto]
 *                 [--exclude "פינת אוכל,רהיטי"] [--require "פורטוגל,פורטו"]
 *
 * The library matches on ad text, so a keyword can drag in a whole unrelated market:
 * searching "פורטו" returns dining tables sold under that model name. --exclude drops
 * concepts whose copy contains any of the terms, --require keeps only those that
 * contain at least one. Both are reported in the output, never dropped silently.
 */
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};

const IN = arg('in');
const OUT = arg('out') || IN;
const MIN_AGE = Number(arg('min-age', 30));
const TOP = Number(arg('top', 15));
const splitTerms = (s) => (s ? s.split(',').map((t) => t.trim()).filter(Boolean) : []);
const EXCLUDE = splitTerms(arg('exclude'));
const REQUIRE = splitTerms(arg('require'));
if (!IN) {
  console.error('Need --in <harvest dir>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(path.join(IN, 'raw-ads.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(IN, 'meta.json'), 'utf8'));
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

const txt = (v) => (typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : '');
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
/** Catalog and dynamic-creative ads ship `{{product.name}}` style placeholders. */
const isPlaceholder = (s) => !s || /\{\{[^}]+\}\}/.test(s);

/**
 * Pull the real creative out of a snapshot. DCO / catalog ads keep the ad-level
 * title and body as feed placeholders and put the actual copy in `cards[]`, so the
 * first real card wins and every other card is kept as an alternate angle.
 */
function resolveCreative(s) {
  const cards = s.cards || [];
  let title = norm(s.title);
  let body = norm(txt(s.body));
  let linkDesc = norm(s.link_description);
  let ctaText = s.cta_text || null;
  let templated = false;

  if (isPlaceholder(title) || isPlaceholder(body)) {
    const real = cards.find((c) => !isPlaceholder(norm(c.title)) || !isPlaceholder(norm(txt(c.body))));
    if (real) {
      templated = true;
      if (isPlaceholder(title)) title = norm(real.title);
      if (isPlaceholder(body)) body = norm(txt(real.body));
      if (isPlaceholder(linkDesc)) linkDesc = norm(real.link_description);
      ctaText = ctaText || real.cta_text || null;
    }
  }

  const alternates = cards
    .map((c) => ({ title: norm(c.title), body: norm(txt(c.body)) }))
    .filter((c) => (c.title || c.body) && !isPlaceholder(c.title || 'x') && c.title !== title);

  return { title, body, linkDesc, ctaText, templated, alternates, cardCount: cards.length };
}

// ---- flatten every ad into one comparable shape -----------------------------
const flat = raw.map((a) => {
  const s = a.snapshot || {};
  const cre = resolveCreative(s);
  const start = a.start_date || null;
  const end = a.end_date || null;
  const lastSeen = a.is_active ? Math.max(end || 0, now) : end || start || 0;
  const cards = s.cards || [];
  return {
    id: a.ad_archive_id,
    collation_id: a.collation_id || `solo-${a.ad_archive_id}`,
    page_id: a.page_id,
    page_name: a.page_name,
    is_active: !!a.is_active,
    start,
    end,
    age_days: start ? Math.round((lastSeen - start) / DAY) : null,
    collation_count: a.collation_count || 1,
    platforms: a.publisher_platform || [],
    format: s.display_format || null,
    title: cre.title,
    body: cre.body,
    caption: norm(s.caption),
    link_description: cre.linkDesc,
    templated: cre.templated,
    alternates: cre.alternates,
    cta_text: cre.ctaText,
    cta_type: s.cta_type || null,
    link_url: s.link_url || null,
    videos: [
      ...(s.videos || []).map((v) => v.video_hd_url || v.video_sd_url),
      ...cards.map((c) => c.video_hd_url || c.video_sd_url),
    ].filter(Boolean),
    video_thumb:
      (s.videos || []).map((v) => v.video_preview_image_url).filter(Boolean)[0] ||
      cards.map((c) => c.video_preview_image_url).filter(Boolean)[0] ||
      null,
    images: [
      ...(s.images || []).map((i) => i.original_image_url || i.resized_image_url),
      ...cards.map((c) => c.original_image_url || c.resized_image_url),
    ].filter(Boolean),
    cards: cards.length,
    snapshot_url: `https://www.facebook.com/ads/library/?id=${a.ad_archive_id}`,
  };
});

// ---- advertiser-level context ----------------------------------------------
const byPage = new Map();
for (const f of flat) {
  if (!byPage.has(f.page_id)) byPage.set(f.page_id, []);
  byPage.get(f.page_id).push(f);
}

// ---- cluster by creative concept --------------------------------------------
// Meta's collation_id groups one creative across placements, but the same copy often
// reappears under a fresh collation_id (relaunch, new campaign, catalog re-spin), so
// identical copy from the same advertiser is folded into one concept.
const clusters = new Map();
for (const f of flat) {
  const fingerprint = `${f.page_id}|${f.title.slice(0, 80)}|${f.body.slice(0, 120)}`;
  const key = f.title || f.body ? fingerprint : f.collation_id;
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(f);
}

const concepts = [...clusters.values()].map((group) => {
  const lead = group.slice().sort((a, b) => (a.start || 0) - (b.start || 0))[0];
  const ages = group.map((g) => g.age_days).filter((n) => n != null);
  const pageAds = byPage.get(lead.page_id) || [];
  const pageActive = pageAds.filter((p) => p.is_active).length;
  const pageOldest = Math.max(0, ...pageAds.map((p) => p.age_days || 0));
  // how many ads this advertiser runs behind the same headline (placeholders excluded,
  // otherwise every catalog ad would look like a repeated hook)
  const sameTitle = lead.title ? pageAds.filter((p) => p.title === lead.title).length : 1;

  return {
    concept_id: lead.collation_id,
    page_id: lead.page_id,
    page_name: lead.page_name,
    is_active: group.some((g) => g.is_active),
    age_days: ages.length ? Math.max(...ages) : null,
    first_seen: lead.start ? new Date(lead.start * 1000).toISOString().slice(0, 10) : null,
    last_seen: lead.end ? new Date(lead.end * 1000).toISOString().slice(0, 10) : null,
    variants: Math.max(group.length, lead.collation_count || 1),
    advertiser_active_ads: pageActive,
    advertiser_oldest_ad_days: pageOldest,
    same_headline_ads: sameTitle,
    format: lead.format,
    templated: !!lead.templated,
    alternates: (() => {
      const seen = new Set([lead.title]);
      const out = [];
      for (const g of group)
        for (const alt of g.alternates || []) {
          if (seen.has(alt.title)) continue;
          seen.add(alt.title);
          out.push(alt);
        }
      return out.slice(0, 5);
    })(),
    platforms: [...new Set(group.flatMap((g) => g.platforms))],
    title: lead.title,
    body: lead.body,
    cta_text: lead.cta_text,
    cta_type: lead.cta_type,
    link_url: lead.link_url,
    videos: [...new Set(group.flatMap((g) => g.videos))],
    video_thumb: lead.video_thumb,
    images: [...new Set(group.flatMap((g) => g.images))].slice(0, 4),
    ad_ids: group.map((g) => g.id),
    snapshot_url: lead.snapshot_url,
  };
});

// ---- scoring ---------------------------------------------------------------
// Every term is bounded and named so the number can be argued with, not trusted blindly.
for (const c of concepts) {
  const age = c.age_days || 0;
  const s_age = Math.min(age / 60, 1) * 50; // 60 days = full marks
  const s_variants = Math.min((c.variants - 1) / 4, 1) * 20; // iterating on a winner
  const s_page = Math.min(c.advertiser_active_ads / 10, 1) * 15; // serious spender
  const s_repeat = Math.min((c.same_headline_ads - 1) / 2, 1) * 15; // doubling down on a hook
  c.score = Math.round(s_age + s_variants + s_page + s_repeat);
  c.signals = {
    age: Math.round(s_age),
    variants: Math.round(s_variants),
    advertiser: Math.round(s_page),
    headline_repeat: Math.round(s_repeat),
  };

  if (!c.is_active) c.tier = 'retired';
  else if (age >= MIN_AGE) c.tier = 'proven';
  else if (age >= 14 && c.variants >= 3) c.tier = 'scaling';
  else c.tier = 'fresh';

  // honesty flag: long-running but nothing else corroborates it
  c.age_only = c.tier === 'proven' && c.variants < 2 && c.advertiser_active_ads < 3 && c.same_headline_ads < 2;
}

// Relevance. A keyword search hits ad text, so an unrelated market can ride in on a
// shared word. Whatever gets filtered here is counted and listed, not quietly dropped.
const haystack = (c) => `${c.page_name} ${c.title} ${c.body}`.toLowerCase();
const irrelevant = [];
for (const c of concepts) {
  const hay = haystack(c);
  const hitExclude = EXCLUDE.find((t) => hay.includes(t.toLowerCase()));
  const missesRequire = REQUIRE.length && !REQUIRE.some((t) => hay.includes(t.toLowerCase()));
  if (hitExclude) c.filtered_out = `excluded on "${hitExclude}"`;
  else if (missesRequire) c.filtered_out = `no required term (${REQUIRE.join(', ')})`;
  if (c.filtered_out) irrelevant.push(c);
}

concepts.sort((a, b) => b.score - a.score || (b.age_days || 0) - (a.age_days || 0));

const survivors = concepts.filter((c) => !c.filtered_out && (c.tier === 'proven' || c.tier === 'scaling'));
const winners = survivors.slice(0, TOP);

const summary = {
  ...meta,
  ranked_at: new Date().toISOString(),
  min_age_days: MIN_AGE,
  ads_harvested: flat.length,
  concepts: concepts.length,
  proven: concepts.filter((c) => c.tier === 'proven').length,
  scaling: concepts.filter((c) => c.tier === 'scaling').length,
  fresh: concepts.filter((c) => c.tier === 'fresh').length,
  retired: concepts.filter((c) => c.tier === 'retired').length,
  advertisers: byPage.size,
  filtered_as_irrelevant: irrelevant.length,
  exclude_terms: EXCLUDE,
  require_terms: REQUIRE,
};

fs.writeFileSync(path.join(OUT, 'ranked.json'), JSON.stringify({ summary, concepts }, null, 1));
fs.writeFileSync(
  path.join(OUT, 'media-manifest.json'),
  JSON.stringify(
    winners.map((w) => ({
      concept_id: w.concept_id,
      ad_ids: w.ad_ids,
      page_name: w.page_name,
      age_days: w.age_days,
      title: w.title,
      videos: w.videos,
      images: w.images,
      snapshot_url: w.snapshot_url,
    })),
    null,
    1
  )
);

// ---- Hebrew report ---------------------------------------------------------
const fmtPlatforms = (p) =>
  p
    .map((x) => ({ FACEBOOK: 'פייסבוק', INSTAGRAM: 'אינסטגרם', MESSENGER: 'מסנג׳ר', WHATSAPP: 'וואטסאפ', AUDIENCE_NETWORK: 'רשת קהלים', THREADS: 'ת׳רדס' }[x] || x))
    .join(', ');
const fmtFormat = (f) => ({ VIDEO: 'וידאו', IMAGE: 'תמונה', DCO: 'דינמי', CAROUSEL: 'קרוסלה', MULTI_IMAGES: 'ריבוי תמונות', MULTI_VIDEOS: 'ריבוי סרטונים' }[f] || f || 'לא ידוע');

const lines = [];
lines.push(`# מודיעין ספריית המודעות`);
lines.push('');
lines.push(`**חיפוש:** ${meta.query ? `"${meta.query}"` : `עמוד ${meta.page_id}`} · **מדינה:** ${meta.country} · **סטטוס:** ${meta.status}`);
lines.push(`**נאסף:** ${new Date(meta.harvested_at).toLocaleString('he-IL')} · **סף ותק:** ${MIN_AGE} ימים`);
lines.push('');
lines.push(`נאספו ${summary.ads_harvested} מודעות מ-${summary.advertisers} מפרסמים, שהתכנסו ל-${summary.concepts} קונספטים.`);
lines.push(`מתוכם: **${summary.proven} מוכחים** (רצים ${MIN_AGE}+ ימים), **${summary.scaling} בהרחבה** (14+ ימים עם 3+ וריאציות), ${summary.fresh} חדשים, ${summary.retired} כבויים.`);
lines.push('');
lines.push('> **מה הסיגנל אומר ומה לא.** ותק הוא ראיה שמישהו ממשיך לשלם, לא ראיה שהמודעה טובה.');
lines.push('> מודעה יכולה לרוץ חודשיים כי אף אחד לא נגע בחשבון. לכן כל קונספט מציג גם את');
lines.push('> מספר הווריאציות ואת רוחב הפעילות של המפרסם, וקונספט שמחזיק רק על ותק מסומן במפורש.');
lines.push('');
lines.push('---');
lines.push('');

if (!winners.length) {
  lines.push('**לא נמצא אף קונספט ששרד את הסינון.** או שהקטגוריה צעירה, או שסף הוותק גבוה מדי לשוק הזה.');
} else {
  lines.push(`## ${winners.length} הקונספטים ששרדו`);
  lines.push('');
  winners.forEach((w, i) => {
    lines.push(`### ${i + 1}. ${w.page_name}`);
    lines.push('');
    lines.push(`**ותק:** ${w.age_days} ימים (מ-${w.first_seen}) · **ציון:** ${w.score}/100 · **דירוג:** ${{ proven: 'מוכח', scaling: 'בהרחבה' }[w.tier]}`);
    lines.push(`**וריאציות:** ${w.variants} · **מודעות פעילות של המפרסם:** ${w.advertiser_active_ads} · **כותרת חוזרת ב:** ${w.same_headline_ads} מודעות`);
    lines.push(`**פורמט:** ${fmtFormat(w.format)} · **פלטפורמות:** ${fmtPlatforms(w.platforms)} · **קריאה לפעולה:** ${w.cta_text || 'ללא'}`);
    if (w.age_only) lines.push(`> ⚠️ **ותק בלבד.** אין וריאציות ואין רוחב פעילות שתומכים בו. יכול להיות מודעה שנשכחה פעילה.`);
    lines.push('');
    if (w.title) lines.push(`**ההוק:** ${w.title}`);
    if (w.body) {
      lines.push('');
      lines.push('**הקופי:**');
      lines.push('');
      lines.push(w.body.slice(0, 700).split('\n').map((l) => `> ${l}`).join('\n'));
    }
    if (w.templated) {
      lines.push('');
      lines.push('*מודעת קטלוג. הטקסט נשלף מהכרטיסים, לא מכותרת המודעה.*');
    }
    if (w.alternates && w.alternates.length) {
      lines.push('');
      lines.push(`**הוקים נוספים באותה מודעה (${w.alternates.length}):**`);
      for (const alt of w.alternates) lines.push(`- ${alt.title}`);
    }
    lines.push('');
    lines.push(`**במודעה:** ${w.snapshot_url}`);
    if (w.videos.length) lines.push(`**וידאו:** ${w.videos.length} קבצים (ראה \`media-manifest.json\`)`);
    lines.push('');
    lines.push('---');
    lines.push('');
  });
}

// advertiser roll-up
const pages = [...byPage.entries()]
  .map(([id, ads]) => ({
    id,
    name: ads[0].page_name,
    total: ads.length,
    active: ads.filter((a) => a.is_active).length,
    oldest: Math.max(0, ...ads.map((a) => a.age_days || 0)),
  }))
  .sort((a, b) => b.active - a.active || b.oldest - a.oldest);

if (irrelevant.length) {
  lines.push(`## ${irrelevant.length} קונספטים שסוננו כלא רלוונטיים`);
  lines.push('');
  lines.push('חיפוש בספרייה מתאים על טקסט המודעה, ולכן מילה משותפת גוררת פנימה שוק אחר.');
  lines.push('אלה סוננו במפורש ולא נעלמו בשקט:');
  lines.push('');
  for (const c of irrelevant.slice(0, 15)) {
    lines.push(`- **${c.page_name}** · ${c.filtered_out} · ${(c.title || c.body || '').slice(0, 60)}`);
  }
  if (irrelevant.length > 15) lines.push(`- ועוד ${irrelevant.length - 15}, ראה \`ranked.json\``);
  lines.push('');
  lines.push('---');
  lines.push('');
}

lines.push('## מי מפרסם בקטגוריה');
lines.push('');
for (const p of pages.slice(0, 20)) {
  lines.push(`- **${p.name}** · ${p.active} מודעות פעילות מתוך ${p.total} · הוותיקה: ${p.oldest} ימים`);
}
lines.push('');
lines.push('---');
lines.push('');
lines.push('*הופק על ידי `ad-library-intel`. המקור: ספריית המודעות הציבורית של Meta.*');

fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));

console.error(
  `[rank] ${summary.concepts} concepts | proven ${summary.proven} | scaling ${summary.scaling} | fresh ${summary.fresh} | retired ${summary.retired}`
);
console.error(`[rank] -> ${OUT}/report.md, ranked.json, media-manifest.json`);
