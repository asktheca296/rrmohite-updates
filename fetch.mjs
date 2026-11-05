// Collects new notifications from official regulator sources into updates.json.
// Runs on GitHub Actions every few hours; rrmohite.in/regulatory-updates reads the JSON.
// Usage: node fetch.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = new URL('./updates.json', import.meta.url);
const UA = 'Mozilla/5.0 (compatible; rrmohite-updates/1.0; +https://rrmohite.in)';
const KEEP = 80;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

const get = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const id = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

// Income Tax Department: e-filing portal "Latest News" (date, official summary, link to the PDF)
async function incomeTax() {
  const page = 'https://www.incometax.gov.in/iec/foportal/latest-news';
  const html = await get(page);
  const items = [];
  for (const row of html.split('<div class="views-row">').slice(1)) {
    const d = row.match(/class="up-date">\s*(\d{2})-([A-Za-z]{3})-(\d{4})/);
    const body = row.match(/class="d-flex gry-ft">([\s\S]*?)<\/div>/);
    if (!d || !body || !MONTHS[d[2]]) continue;
    const link = (body[1].match(/href="(https:\/\/[^"]+)"/) || [])[1] || page;
    const t = text(body[1].replace(/<a\b[^>]*>\s*Click here\s*<\/a>/gi, ''));
    if (!t) continue;
    items.push({ id: id('it', link, t.slice(0, 80)), source: 'Income Tax', date: iso(d[3], MONTHS[d[2]], d[1]), text: t, url: link });
  }
  if (!items.length) throw new Error('Income Tax: no entries found (page layout may have changed)');
  return items;
}

// Reserve Bank of India: notifications RSS, without the routine UAPA sanctions-list notices
async function rbi() {
  const xml = await get('https://www.rbi.org.in/notifications_rss.xml');
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (k) => text(((m[1].match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, ''));
    const title = field('title'), link = field('link'), pub = field('pubDate');
    if (!title || /UAPA|Sanctions List|UNSC/i.test(title)) continue;
    const d = pub.match(/(\d{1,2}) ([A-Za-z]{3}) (\d{4})/);
    if (!d || !MONTHS[d[2]] || !/^https:\/\/(www\.)?rbi\.org\.in\//.test(link)) continue;
    items.push({ id: id('rbi', link), source: 'RBI', date: iso(d[3], MONTHS[d[2]], d[1]), text: title, url: link });
  }
  if (!xml.includes('<item>')) throw new Error('RBI: feed has no items');
  return items;
}

const old = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { items: [] };
const byId = new Map(old.items.map((i) => [i.id, i]));
const sources = {};
let failed = false;
for (const [name, fn] of [['Income Tax', incomeTax], ['RBI', rbi]]) {
  try {
    const found = await fn();
    let added = 0;
    for (const i of found) if (!byId.has(i.id)) { byId.set(i.id, i); added++; }
    sources[name] = { ok: true, found: found.length, added };
  } catch (e) {
    failed = true;
    sources[name] = { ok: false, error: e.message };
    console.error(e.message);
  }
}
const items = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, KEEP);
const changed = JSON.stringify(items) !== JSON.stringify(old.items);
const out = { checked: new Date().toISOString(), sources, items };
fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(sources), changed ? 'list changed' : 'no new items');
// A failed source fails the run, so GitHub emails the account owner.
if (failed) process.exit(1);
