// social-intel: קריאת פוסט או ריל בודד באינסטגרם.
// מריצים דרך mcp__claude-in-chrome__javascript_tool כשהטאב פתוח על /p/<id>/ או /reel/<id>/
// מחזיר: לייקים, מספר תגובות, תאריך וכיתוב (מתוך og:description), ואת התגובות שנטענו על המסך.
// אינסטגרם טוען בהתחלה רק את המנה הראשונה של התגובות. LOAD_MORE מנסה ללחוץ על "עוד תגובות".
await (async () => {
  const LOAD_MORE = 3;
  await new Promise((r) => setTimeout(r, 3000));
  for (let i = 0; i < LOAD_MORE; i++) {
    const more = [...document.querySelectorAll('button, div[role="button"]')].find((b) =>
      /^(טעינת תגובות נוספות|Load more comments)$/.test(b.getAttribute('aria-label') || b.innerText.trim()));
    if (!more) break;
    more.click();
    await new Promise((r) => setTimeout(r, 2000));
  }
  const og = document.querySelector('meta[property="og:description"]')?.content || '';
  const num = (re) => og.match(re)?.[1] || null;
  // כל בלוק = המיכל הגדול ביותר שמכיל time אחד בלבד. בלוק עם "השב" הוא תגובה, השאר הם הפוסט עצמו.
  const comments = [];
  let postTime = null;
  for (const t of document.querySelectorAll('time[datetime]')) {
    let el = t;
    while (el.parentElement && el.parentElement.querySelectorAll('time[datetime]').length === 1) el = el.parentElement;
    if (!/(השב|Reply)/.test(el.innerText)) {
      postTime = postTime || t.getAttribute('datetime');
      continue;
    }
    const lines = el.innerText.split('\n').map((s) => s.trim()).filter((s) => s && s !== '⁣');
    const user = el.querySelector('a[href^="/"] span')?.innerText || lines[0];
    const likes = lines.find((l) => /(לייקים|לייק אחד|likes?)$/.test(l)) || null;
    const text = lines.slice(2).filter((l) => !/(לייקים|לייק אחד|likes?$|^השב|^Reply|^הצגה של|^View all|^הצגת התרגום|^See translation|נערכה$|^Edited)/.test(l)).join(' ');
    comments.push({ user, when: t.getAttribute('datetime'), text, likes });
  }
  const caption = (og.match(/:\s*"([\s\S]*)"/)?.[1] || '').replace(/⁣/g, '').trim();
  return {
    platform: 'instagram',
    url: location.href.split('?')[0],
    collected_at: new Date().toISOString(),
    likes: num(/^\D*([\d.,]+[KM]?)\s*likes/),
    comments_total: num(/([\d.,]+[KM]?)\s*comments/),
    caption,
    posted_at: postTime,
    og_description: og,
    comments_loaded: comments.length,
    comments,
  };
})()
