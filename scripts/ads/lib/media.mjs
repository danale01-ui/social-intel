import fs from 'fs';
import path from 'path';

export const slug = (s) =>
  (s || 'ad')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'ad';

/**
 * Download creative files. Meta's CDN URLs are signed and expire within hours, so the
 * only reliable moment to fetch them is right after the harvest that produced them.
 *
 * items: [{ key, page_name, age_days, title, snapshot_url, videos: [], images: [] }]
 * Returns { ok, failed, index }.
 */
export async function downloadCreatives(items, dir, { images = false, imagesPerAd = 2 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
  const already = new Set(index.map((r) => r.file));
  let ok = 0;
  let failed = 0;

  for (const [i, item] of items.entries()) {
    const urls = [...(item.videos || []).map((u) => ({ u, ext: 'mp4' }))];
    if (images) urls.push(...(item.images || []).slice(0, imagesPerAd).map((u) => ({ u, ext: 'jpg' })));
    if (!urls.length) continue;

    for (const [j, { u, ext }] of urls.entries()) {
      const name = `${String(i + 1).padStart(2, '0')}-${slug(item.page_name)}-${item.age_days ?? 'x'}d${j ? `-${j}` : ''}.${ext}`;
      if (already.has(name)) continue;
      const dest = path.join(dir, name);
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error(`http ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest, buf);
        ok++;
        already.add(name);
        index.push({
          file: name,
          bytes: buf.length,
          ad_id: item.key || null,
          page_name: item.page_name,
          age_days: item.age_days ?? null,
          title: item.title || '',
          snapshot_url: item.snapshot_url || null,
        });
        console.error(`[media] ${name} (${Math.round(buf.length / 1024)} KB)`);
      } catch (e) {
        failed++;
        console.error(`[media] FAILED ${name}: ${e.message}`);
      }
    }
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
  return { ok, failed, index };
}
