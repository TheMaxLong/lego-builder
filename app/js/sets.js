// Browser for the LDraw Official Model Repository (official Lego sets as model files).
// The site has no bulk download or API, so: index its 25-row list pages once (cached),
// then fetch one set's page + model file when picked. Downloads are kept for offline use.

import * as platform from './platform.js';
import { parseLdr } from './ldr.js';

const SITE = 'https://library.ldraw.org';
const INDEX_VERSION = 1;

let index = null; // [{ id, num, name, theme, year, models }]

function rowsFrom(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const tr of doc.querySelectorAll('tr')) {
    const a = tr.querySelector('a[href*="/omr/sets/"]');
    if (!a) continue;
    const id = (a.getAttribute('href').match(/omr\/sets\/(\d+)/) || [])[1];
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const numIdx = cells.findIndex(c => /^[\w.]+-\d+$/.test(c));
    if (!id || numIdx < 0) continue;
    const [num, name, theme, year, models] = cells.slice(numIdx);
    out.push({ id, num, name, theme: theme || '', year: Number(year) || 0, models: Number(models) || 1 });
  }
  const total = Number((doc.body.textContent.match(/of\s+([\d,]+)\s+results/) || [])[1]?.replace(/,/g, '')) || 0;
  return { rows: out, total };
}

export async function loadIndex(onProgress, { refresh = false } = {}) {
  const p = await platform.paths();
  const path = p.cache + '/omr-index.json';
  if (!refresh) {
    if (index) return index;
    try {
      const c = JSON.parse((await platform.readText(path)) || 'null');
      if (c?.version === INDEX_VERSION && c.sets?.length) return (index = c.sets);
    } catch {}
  }
  const seen = new Map();
  let page = 1;
  let pages = 1;
  do {
    const { rows, total } = rowsFrom(await platform.httpGet(`${SITE}/omr/sets?page=${page}`));
    if (total) pages = Math.ceil(total / 25);
    for (const r of rows) seen.set(r.id, r);
    onProgress?.(page, pages);
    if (!rows.length) break;
    page++;
  } while (page <= pages);
  index = [...seen.values()];
  await platform.writeText(path, JSON.stringify({ version: INDEX_VERSION, fetched: Date.now(), sets: index }));
  return index;
}

export function themes() {
  const t = new Map();
  for (const s of index || []) {
    const top = s.theme.split('>')[0].trim() || 'Other';
    t.set(top, (t.get(top) || 0) + 1);
  }
  return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
}

export function search(q, theme) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (index || [])
    .filter(s => !theme || s.theme.split('>')[0].trim() === theme)
    .filter(s => terms.every(t => `${s.num} ${s.name} ${s.theme} ${s.year}`.toLowerCase().includes(t)))
    .sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
}

/** Model files listed on a set's page. */
export async function modelFiles(set) {
  const html = await platform.httpGet(`${SITE}/omr/sets/${set.id}`);
  const files = [...new Set([...html.matchAll(/library\/omr\/([^"'<>\s]+\.(?:mpd|ldr))/gi)].map(m => m[1]))];
  return files;
}

/** Download (or reuse the saved copy of) one model file and parse it. */
export async function fetchModel(set, file) {
  const p = await platform.paths();
  const local = `${p.data}/Lego Sets/${file}`;
  let text = await platform.readText(local);
  if (text == null) {
    text = await platform.httpGet(`${SITE}/library/omr/${encodeURIComponent(file)}`);
    await platform.writeText(local, text);
  }
  const m = parseLdr(text, `${set.num} ${set.name}`);
  m.name = `${set.num} ${set.name}`;
  return m;
}
