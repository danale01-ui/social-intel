/**
 * Fallback extraction: read ads straight out of the page's embedded payload.
 *
 * The harvester normally replays the list's own pagination request. But a search with
 * few enough results never needs a second page, so that request is never issued and
 * there is nothing to capture, even though the ads are right there on screen. The
 * initial payload is embedded in a script tag, so we parse it directly.
 *
 * This is also the safety net if Meta renames or restructures the search query: as long
 * as the page still renders ads, this path still returns them.
 */

/**
 * Walk a balanced JSON object starting at `start` (which must point at '{'),
 * respecting strings and escapes. Returns the object text, or null if unbalanced.
 */
function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    // A single ad object is large but bounded; bail out rather than scan a whole bundle.
    if (i - start > 400000) return null;
  }
  return null;
}

/**
 * Pull every ad record out of raw page text. Ad objects in the payload begin with
 * `{"ad_archive_id":`, which gives us a reliable anchor to parse from.
 */
export function extractAdsFromText(text) {
  const ads = new Map();
  const anchor = '{"ad_archive_id":';
  let idx = text.indexOf(anchor);
  while (idx !== -1) {
    const objText = balancedObject(text, idx);
    if (objText) {
      try {
        const obj = JSON.parse(objText);
        if (obj.ad_archive_id && obj.snapshot) ads.set(obj.ad_archive_id, obj);
      } catch {
        /* truncated or escaped differently, skip */
      }
    }
    idx = text.indexOf(anchor, idx + anchor.length);
  }
  return [...ads.values()];
}
