import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Resolve a Chromium binary without downloading anything.
 * Order: newest playwright cache build -> system Chrome -> Chrome Canary.
 */
export function resolveChromium() {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(cache)) {
    const builds = fs
      .readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-linux']) {
        const candidates = [
          path.join(cache, b, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
          path.join(cache, b, arch, 'chrome'),
        ];
        for (const c of candidates) if (fs.existsSync(c)) return c;
      }
    }
  }
  const system = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const s of system) if (fs.existsSync(s)) return s;
  throw new Error('No Chromium binary found. Install one: npx playwright install chromium');
}

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
