// Searchable parts catalog built from the library's file headers (cached after first run).

import * as platform from './platform.js';

const CATALOG_VERSION = 3;

// Library categories grouped into the drawer's chips, in display order.
export const CHIPS = [
  ['Brick', ['Brick']],
  ['Plate', ['Plate']],
  ['Tile', ['Tile']],
  ['Slope', ['Slope']],
  ['Wedge', ['Wedge']],
  ['Arch', ['Arch']],
  ['Round', ['Cylinder', 'Cone', 'Dish', 'Round', 'Turntable']],
  ['Baseplate', ['Baseplate']],
  ['Window', ['Window', 'Windscreen', 'Glass']],
  ['Door', ['Door']],
  ['Panel', ['Panel', 'Support']],
  ['Fence', ['Fence', 'Ladder', 'Roadsign']],
  ['Plant', ['Plant', 'Rock', 'Flower']],
  ['Bracket', ['Bracket']],
  ['Hinge', ['Hinge']],
  ['Bar', ['Bar', 'Antenna', 'Hose']],
  ['Wheels', ['Wheel', 'Tyre']],
  ['Vehicle', ['Vehicle', 'Car', 'Train', 'Boat', 'Plane', 'Wing', 'Tail', 'Propeller', 'Monorail']],
  ['Minifig', ['Minifig', 'Minifig Accessory', 'Minifig Headwear', 'Minifig Neckwear', 'Minifig Hipwear', 'Minifig Footwear']],
  ['Figure', ['Figure', 'Figure Accessory', 'Animal']],
  ['Container', ['Container', 'Flag', 'Sheet Fabric', 'Sheet Plastic']],
  ['Technic', ['Technic', 'Electric']],
];
const chipOf = new Map();
for (const [chip, cats] of CHIPS) for (const c of cats) chipOf.set(c, chip);

const HIDDEN_CATS = new Set(['Sticker', 'Sticker Shortcut']);

export let parts = []; // { file, title, cat, chip, printed, keys, search }

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1x')
    .replace(/\s+/g, ' ')
    .trim();
}

function fromHeaders(list) {
  const out = [];
  for (const { file, header } of list) {
    const lines = header.split(/\r?\n/).map(l => l.trim());
    const title = (lines[0] || '').replace(/^0\s*/, '').trim();
    if (!title || /^[~=_|]/.test(title)) continue;
    const org = lines.find(l => /^0\s+!LDRAW_ORG/.test(l)) || '';
    if (!/!LDRAW_ORG\s+(Unofficial_)?(Part|Shortcut)\b(?!\s+(Alias|Physical_Colour|Flexible_Section))/i.test(org)) continue;
    const catLine = lines.find(l => /^0\s+!CATEGORY/.test(l));
    const cat = catLine ? catLine.replace(/^0\s+!CATEGORY\s+/, '').trim() : title.split(/\s+/)[0];
    if (HIDDEN_CATS.has(cat)) continue;
    const keys = lines
      .filter(l => /^0\s+!KEYWORDS/.test(l))
      .map(l => l.replace(/^0\s+!KEYWORDS\s+/, ''))
      .join(', ');
    const printed = /pattern|print|sticker/i.test(title) || /^\d+[a-z]?p[a-z0-9]{2,}\.dat$/i.test(file);
    out.push({ file, title, cat, chip: chipOf.get(cat) || 'Other', printed, keys });
  }
  return out;
}

/** Load the cached catalog or build it by scanning the parts folder once. */
export async function load(libraryDir, cacheDir, onProgress) {
  const path = cacheDir + '/catalog.json';
  try {
    const cached = JSON.parse((await platform.readText(path)) || 'null');
    if (cached?.version === CATALOG_VERSION) parts = cached.parts;
  } catch {}
  if (!parts.length) {
    onProgress?.('Cataloguing the parts library (first run only)…');
    parts = fromHeaders(await platform.scanHeaders(libraryDir + '/parts'));
    await platform.writeText(path, JSON.stringify({ version: CATALOG_VERSION, parts }));
  }
  for (const p of parts) p.search = normalize(`${p.file.replace(/\.dat$/i, '')} ${p.title} ${p.cat} ${p.keys}`);
  return parts;
}

const BASIC = /^(brick|plate|tile|slope|baseplate) +\d+x\d+( x \d+)?$/;
const CHIP_RANK = new Map(CHIPS.map(([c], i) => [c, i]));

/** Search + filter. Empty query lists the chip (or basics first) in a sensible order. */
export function find({ query = '', chip = null, printed = false, limit = 300 } = {}) {
  const q = normalize(query);
  const terms = q ? q.split(' ') : [];
  const res = [];
  for (const p of parts) {
    if (chip && p.chip !== chip) continue;
    if (!printed && p.printed && !q) continue;
    if (terms.length && !terms.every(t => p.search.includes(t))) continue;
    let score = 0;
    const t = normalize(p.title);
    const num = p.file.replace(/\.dat$/i, '').toLowerCase();
    if (q && num === q) score -= 1000;
    if (q && t.startsWith(q)) score -= 200;
    if (BASIC.test(t)) score -= 150;
    if (p.printed) score += 300;
    if (/duplo|modulex|scala|znap|constraction|quatro/i.test(p.cat + ' ' + p.title)) score += 400;
    score += (CHIP_RANK.get(p.chip) ?? 40) * 3;
    score += t.length * 0.5;
    res.push([score, p]);
  }
  res.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title, undefined, { numeric: true }));
  return { total: res.length, items: res.slice(0, limit).map(r => r[1]) };
}

export function byFile(file) {
  const f = file.toLowerCase();
  return parts.find(p => p.file.toLowerCase() === f);
}

/** Parts whose title matches a regex, for the minifig builder. */
export function where(test) {
  return parts.filter(test);
}
