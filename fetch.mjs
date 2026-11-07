// Collects new notifications from official regulator sources into updates.json.
// Runs on GitHub Actions every few hours; rrmohite.in/regulatory-updates reads the JSON.
// Only official sites that allow automated reading are used; a site that refuses is left out.
// Usage: node fetch.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = new URL('./updates.json', import.meta.url);
const UA = 'Mozilla/5.0 (compatible; rrmohite-updates/1.0; +https://rrmohite.in)';
const PER_SOURCE = 25;        // newest entries kept for each regulator
const ALERT_AFTER = 4;        // failed runs in a row (about 12 hours) before the run is marked failed
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CBIC = 'https://taxinformation.cbic.gov.in';

const get = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(40000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};
const getJson = async (url) => JSON.parse(await get(url));
const text = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&#x2013;/g, '-').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/​/g, '').replace(/\s+/g, ' ').trim();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const id = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
const abs = (base, u) => new URL(u.trim(), base).href;

// Accepts 2026-11-05, 05-11-2026, 05/11/2026, 05.11.2026, 05-Nov-2026, 05 November 2026, Tue, 05 Nov 2026
function date(s) {
  s = String(s ?? '');
  let m = s.match(/(20\d\d)-(\d\d)-(\d\d)/);
  if (m) return iso(m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d\d)\b/);
  if (m) return iso(m[3], +m[2], +m[1]);
  m = s.match(/\b(\d{1,2})[- ]([A-Za-z]{3})[a-z]*,?[- ](20\d\d)\b/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/\b([A-Za-z]{3})[a-z]* (\d{1,2}),? (20\d\d)\b/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}
const item = (source, d, t, url) => ({ id: id(source, url, t.slice(0, 80)), source, date: d, text: t, url });

// Income Tax Department: e-filing portal "Latest News"
async function incomeTax() {
  const page = 'https://www.incometax.gov.in/iec/foportal/latest-news';
  const html = await get(page);
  const out = [];
  for (const row of html.split('<div class="views-row">').slice(1)) {
    const d = date((row.match(/class="up-date">([^<]+)/) || [])[1]);
    const body = row.match(/class="d-flex gry-ft">([\s\S]*?)<\/div>/);
    if (!d || !body) continue;
    const link = (body[1].match(/href="(https:\/\/[^"]+)"/) || [])[1] || page;
    const t = text(body[1].replace(/<a\b[^>]*>\s*Click here\s*<\/a>/gi, ''));
    if (t) out.push(item('Income Tax', d, t, link));
  }
  return out;
}

// CBIC Tax Information Portal (GST and Customs): the portal's own public data service.
// Documents open inside the portal, so entries link to it with the number to search for.
async function cbicCirculars(taxId, source) {
  const rows = await getJson(`${CBIC}/api/cbic-circular-msts/fetchAllCircularsByTaxId/${taxId}`);
  return rows.filter((r) => r.circularDt && r.isActive === 'Y').map((r) =>
    item(source, date(r.circularDt), `Circular ${text(r.circularNo).replace(/\.$/, '')}: ${text(r.circularName)}`, CBIC + '/'));
}
async function cbicNotifications(taxId, source, categories) {
  const out = [];
  for (const c of categories) {
    const rows = await getJson(`${CBIC}/api/cbic-notification-msts/fetchNotificationByCategory/${taxId}/${encodeURIComponent(c)}`);
    for (const r of rows) if (r.notificationDt && r.isActive === 'Y')
      out.push(item(source, date(r.notificationDt), /^\d/.test(text(r.notificationNo))
        ? `Notification ${text(r.notificationNo)}: ${text(r.notificationName)}` : text(r.notificationName), CBIC + '/'));
  }
  return out;
}
const gst = async () => [...await cbicCirculars(1000001, 'GST'),
  ...await cbicNotifications(1000001, 'GST', ['Central Tax', 'Central Tax (Rate)', 'Integrated Tax', 'Integrated Tax (Rate)'])];
const customs = async () => [...await cbicCirculars(1000002, 'Customs'), ...await cbicNotifications(1000002, 'Customs', ['Tariff'])];

// RSS feeds (RBI, SEBI)
async function rss(url, source, skip) {
  const xml = await get(url);
  if (!xml.includes('<item>')) throw new Error(`${source}: feed has no items`);
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (k) => text(((m[1].match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, ''));
    const t = field('title'), link = field('link'), d = date(field('pubDate'));
    if (t && d && /^https:\/\//.test(link) && !skip.test(t)) out.push(item(source, d, t, link));
  }
  return out;
}
const rbi = () => rss('https://www.rbi.org.in/notifications_rss.xml', 'RBI', /UAPA|Sanctions List|UNSC/i);
// SEBI's feed is mostly orders against named persons; keep circulars, frameworks, regulations and press releases
const sebi = () => rss('https://www.sebi.gov.in/sebirss.xml', 'SEBI',
  /Recovery Certificate|Release Order|Completion Order|Notice of Demand|Appeal No|Adjudication Order|Settlement Order|Exemption Order|Order in the matter|Order for Compliance|Attachment|Summons|Show Cause|Interim Order|Confirmatory Order|Final Order/i);

// ICAI announcements (examination and student notices left out)
async function icai() {
  const base = 'https://www.icai.org/category/announcements';
  const html = await get(base);
  const out = [];
  for (const m of html.matchAll(/<li class='list-group-item'><a href\s*=\s*'([^']+)'>([\s\S]*?)<\/a><\/li>/g)) {
    const raw = text(m[2]);
    const d = date((raw.match(/\((\d\d-\d\d-20\d\d)\)\s*$/) || [])[1]);
    const t = raw.replace(/\s*-?\s*\(\d\d-\d\d-20\d\d\)\s*$/, '');
    if (d && t && !/examination|exam\b|result|student|admit card|articleship|coaching|mock test|campus/i.test(t)) out.push(item('ICAI', d, t, abs(base, m[1])));
  }
  if (!html.includes('list-group-item')) throw new Error('ICAI: list not found');
  return out;
}

// NFRA circulars (table: title, date, PDF)
async function nfra() {
  const html = await get('https://nfra.gov.in/document-category/circulars/');
  const out = [];
  for (const m of html.matchAll(/<tr>\s*<td role="rowheader"[^>]*>([\s\S]*?)<\/td>\s*<td>([^<]*)<\/td>([\s\S]*?)<\/tr>/g)) {
    const d = date(m[2]), link = (m[3].match(/href="(https:\/\/[^"]+\.pdf)"/i) || [])[1];
    if (d && link) out.push(item('NFRA', d, text(m[1]), link));
  }
  if (!out.length) throw new Error('NFRA: no circulars found (page layout may have changed)');
  return out;
}

// IRDAI circulars (Hindi / English titles: the English part is kept)
async function irdai() {
  const html = await get('https://irdai.gov.in/circulars');
  const out = [];
  for (const row of html.split('<tr').slice(1)) {
    const cell = (c) => (row.match(new RegExp(`table-col-${c}"[^>]*>([\\s\\S]*?)</td>`)) || [])[1];
    const title = text(cell('shortDesc')), d = date(text(cell('lastUpdated')));
    const link = ((cell('subTitle') || '').match(/href='([^']+)'/) || [])[1];
    if (!title || !d || !link) continue;
    const t = title.includes(' / ') ? title.split(' / ').pop() : title;
    out.push(item('IRDAI', d, t, link));
  }
  if (!out.length) throw new Error('IRDAI: no circulars found (page layout may have changed)');
  return out;
}

// IBBI "What's new" (orders on individual insolvency cases left out)
async function ibbi() {
  const base = 'https://ibbi.gov.in/whats-new';
  const html = await get(base);
  const out = [];
  for (const row of html.split('<tr>').slice(1)) {
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 3) continue;
    const d = date(cells[1]), link = (cells[2].match(/href="([^"]+)"/) || [])[1];
    const t = text(cells[2].replace(/<span style="margin-left[\s\S]*$/, ''));
    if (d && link && t && !/Resolution Plan|Order in the matter|Disciplinary|Show Cause|Liquidation|in C\.P\.|IA\(IBC\)/i.test(t)) out.push(item('IBBI', d, t, abs(base, link)));
  }
  if (!html.includes('<tbody>')) throw new Error('IBBI: table not found');
  return out;
}

// IFSCA circulars and notifications: the site's own public list service
async function ifsca() {
  const out = [];
  for (const [kind, enc] of [['Circular', 'wF6kttc1JR8='], ['Notification', 'zcGvy-Iqfcg=']]) {
    const q = new URLSearchParams({ start: 0, length: 25, PageNumber: 1, PageSize: 25, SearchText: '', EncryptedId: enc });
    const j = await getJson(`https://ifsca.gov.in/Legal/GetLegalData?${q}`);
    for (const r of j.data?.LegalMasterModelList || []) {
      const d = date(r.PublishDate || r.PublishDat || r.IssueDate);
      if (!d || !r.Title || !r.PhotoFileID) continue;
      const link = `https://ifsca.gov.in/CommonDirect/GetFileView?${new URLSearchParams({ id: r.PhotoFileID, fileName: r.PhotoFileName || '', TitleName: kind })}`;
      out.push(item('IFSCA', d, `${kind}: ${text(r.Title)}`, link));
    }
  }
  if (!out.length) throw new Error('IFSCA: no entries found');
  return out;
}

// NABARD circulars
async function nabard() {
  const base = 'https://www.nabard.org/circulars.aspx?cid=504&id=24';
  const html = await get(base);
  const out = [];
  for (const row of html.split('<div class="circulars_row">').slice(1)) {
    const d = date(text((row.match(/circulars_date">([\s\S]*?)<\/div>/) || [])[1]));
    const a = row.match(/<a href="([^"]+)"[^>]*class="pdfLink"[^>]*>([\s\S]*?)<\/(?:span|a)>/);
    if (d && a) out.push(item('NABARD', d, text(a[2]), abs(base, a[1])));
  }
  if (!out.length) throw new Error('NABARD: no circulars found (page layout may have changed)');
  return out;
}

const SOURCES = [['Income Tax', incomeTax], ['GST', gst], ['Customs', customs], ['RBI', rbi], ['SEBI', sebi], ['ICAI', icai],
  ['NFRA', nfra], ['IRDAI', irdai], ['IBBI', ibbi], ['IFSCA', ifsca], ['NABARD', nabard]];
// Tried every run, but a failure never sends an alert: NABARD does not answer GitHub's servers outside India
const BEST_EFFORT = new Set(['NABARD']);

const old = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { items: [], sources: {} };
const byId = new Map(old.items.map((i) => [i.id, i]));
const sources = {};
let alert = false;
await Promise.all(SOURCES.map(async ([name, fn]) => {
  try {
    const found = (await fn()).filter((i) => i.date && i.text);
    found.sort((a, b) => b.date.localeCompare(a.date));
    let added = 0;
    for (const i of found.slice(0, PER_SOURCE)) if (!byId.has(i.id)) { byId.set(i.id, i); added++; }
    sources[name] = { ok: true, found: found.length, added, failures: 0 };
  } catch (e) {
    const failures = (old.sources?.[name]?.failures || 0) + 1;
    // "fetch failed" hides the real network error (refused, reset, timeout) in e.cause
    const cause = e.cause ? ` (${e.cause.code || e.cause.name || ''} ${e.cause.message || ''})`.replace(/\s+\)/, ')') : '';
    sources[name] = { ok: false, error: e.message + cause, failures };
    if (failures >= ALERT_AFTER && !BEST_EFFORT.has(name)) alert = true;
    console.error(`${name} (${failures} in a row): ${e.message}${cause}`);
  }
}));

// Keep the newest entries of each regulator
const keep = [];
for (const [name] of SOURCES) keep.push(...[...byId.values()].filter((i) => i.source === name).sort((a, b) => b.date.localeCompare(a.date)).slice(0, PER_SOURCE));
const items = keep.sort((a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
fs.writeFileSync(FILE, JSON.stringify({ checked: new Date().toISOString(), sources, items }, null, 1) + '\n');
console.log(Object.entries(sources).map(([n, s]) => `${n}: ${s.ok ? `${s.found} found, ${s.added} new` : 'FAILED'}`).join('\n'));
// A source failing for about 12 hours fails the run, so GitHub emails the account owner.
if (alert) process.exit(1);
