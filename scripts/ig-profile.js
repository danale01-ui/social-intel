// social-intel: איסוף פוסטים מפרופיל אינסטגרם.
// מריצים דרך mcp__claude-in-chrome__javascript_tool כשהטאב פתוח על instagram.com/<handle>/
// מחזיר: כותרת הפרופיל, תיאור מטא (עוקבים, פוסטים), ורשימת פוסטים עם קישור, סוג וכיתוב.
// SCROLLS קובע כמה פעמים לגלול. כל גלילה מוסיפה בערך 12 פוסטים.
await (async () => {
  const SCROLLS = 6;
  const posts = new Map();
  const grab = () => {
    document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((a) => {
      const path = new URL(a.getAttribute('href'), location.origin).pathname;
      if (posts.has(path)) return;
      posts.set(path, {
        url: location.origin + path,
        type: path.includes('/reel/') ? 'reel' : 'post',
        caption: a.querySelector('img')?.alt || '',
      });
    });
  };
  await new Promise((r) => setTimeout(r, 2500));
  grab();
  for (let i = 0; i < SCROLLS; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 2000));
    grab();
  }
  return {
    platform: 'instagram',
    profile: location.pathname.split('/')[1],
    collected_at: new Date().toISOString(),
    header: document.querySelector('header')?.innerText || '',
    meta: document.querySelector('meta[name="description"]')?.content || '',
    count: posts.size,
    posts: [...posts.values()],
  };
})()
