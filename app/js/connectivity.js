// Works out where a part connects, straight from its LDraw geometry.
// LDraw has no connection data, so: studs = every stud primitive the part references
// (directly or through stud groups / subparts); sockets = the stud grid on the part's
// flat bottom face. Anything irregular falls back to grid snapping in the builder.

import { mul3, apply3 } from './ldr.js';

const TOP_STUD = /^(stud|studa|stud2|stud2a|stud6|stud6a|stud10|stud13|stud15|stud17a|stud-logo\d*|stud2-logo\d*)\.dat$/i;

const STUD = 20; // LDU between stud centres

const cache = new Map(); // lowercased file -> Promise<{studs, sideStuds, min, max, hull}>

// 26 directions: axes, edge diagonals, corner diagonals. Each file keeps only its most extreme
// point along each, so a sub-part turned by quarter or eighth turns still measures exactly
// (turning a plain bounding box instead over-measures sloped faces: a ridge read 40 tall, not 24).
const DIRS = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) DIRS.push([x, y, z]);
function extremes(points) {
  if (!points.length) return [];
  const keep = new Set();
  for (const d of DIRS) {
    let best = 0;
    let bv = -Infinity;
    points.forEach((p, i) => {
      const v = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
      if (v > bv) {
        bv = v;
        best = i;
      }
    });
    keep.add(best);
  }
  return [...keep].map(i => points[i]);
}

function baseName(f) {
  return f.replace(/\\/g, '/').toLowerCase();
}

/**
 * Raw analysis of one file in its own coordinates.
 * getText(name) -> Promise<string|null>
 */
function analyzeFile(file, getText) {
  const key = baseName(file);
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const shortName = key.split('/').pop();
    const res = { studs: [], sideStuds: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], hull: [] };
    const pts = [];
    const grow = v => {
      pts.push(v);
      for (let i = 0; i < 3; i++) {
        if (v[i] < res.min[i]) res.min[i] = v[i];
        if (v[i] > res.max[i]) res.max[i] = v[i];
      }
    };
    if (TOP_STUD.test(shortName)) {
      // A stud primitive: its origin is the base centre, it rises 4 LDU along -Y.
      res.studs.push([0, 0, 0]);
      for (const x of [-6, 6]) for (const y of [-4, 0]) for (const z of [-6, 6]) grow([x, y, z]);
      res.hull = extremes(pts);
      return res;
    }
    const text = await getText(file);
    if (text == null) return res;
    const subs = [];
    for (const raw of text.split(/\r?\n/)) {
      const tok = raw.trim().split(/\s+/);
      const type = tok[0];
      if (type === '1' && tok.length >= 15) {
        const n = tok.slice(2, 14).map(Number);
        subs.push({ pos: n.slice(0, 3), rot: n.slice(3, 12), file: tok.slice(14).join(' ') });
      } else if (type === '3' || type === '4') {
        const nv = type === '3' ? 3 : 4;
        for (let k = 0; k < nv; k++) grow(tok.slice(2 + k * 3, 5 + k * 3).map(Number));
      }
    }
    const results = await Promise.all(subs.map(s => analyzeFile(s.file, getText)));
    subs.forEach((s, i) => {
      const r = results[i];
      const place = v => {
        const w = apply3(s.rot, v);
        return [w[0] + s.pos[0], w[1] + s.pos[1], w[2] + s.pos[2]];
      };
      for (const st of r.studs) {
        const up = apply3(s.rot, [0, -1, 0]);
        const len = Math.hypot(...up) || 1;
        if (up[1] / len < -0.9) res.studs.push(place(st));
        else res.sideStuds.push({ pos: place(st), dir: up.map(x => x / len) });
      }
      for (const ss of r.sideStuds) {
        const d = apply3(s.rot, ss.dir);
        res.sideStuds.push({ pos: place(ss.pos), dir: d });
      }
      for (const h of r.hull) grow(place(h));
    });
    res.hull = extremes(pts);
    return res;
  })();
  cache.set(key, job);
  return job;
}

function round(v, q = 1000) {
  return Math.round(v * q) / q;
}

/**
 * Connection info for a library part, in the part's own coordinates.
 * Returns { studs:[[x,y,z]], sockets:[[x,y,z]], sideStuds, min, max }.
 */
export async function analyzePart(file, getText) {
  const r = await analyzeFile(file, getText);
  const seen = new Set();
  const studs = [];
  for (const s of r.studs) {
    const p = s.map(v => round(v));
    const k = p.join(',');
    if (!seen.has(k)) {
      seen.add(k);
      studs.push(p);
    }
  }
  const min = r.min.map(v => (v === Infinity ? 0 : round(v)));
  const max = r.max.map(v => (v === -Infinity ? 0 : round(v)));
  return { studs, sockets: footprintSockets(min, max, studs), sideStuds: r.sideStuds, min, max };
}

/**
 * Socket grid on the flat bottom (max Y) of the bounding box.
 * Width that is not a whole number of studs gets a single centre socket.
 */
export function footprintSockets(min, max, studs = []) {
  const y = max[1];
  const w = max[0] - min[0];
  const d = max[2] - min[2];
  const nx = Math.round(w / STUD);
  const nz = Math.round(d / STUD);
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  if (nx < 1 || nz < 1 || Math.abs(w - nx * STUD) > 4 || Math.abs(d - nz * STUD) > 4) {
    // Odd outline (round plates, dishes): its studs show where the anti-studs are underneath.
    if (studs.length > 1) return studs.map(s => [s[0], y, s[2]]);
    return [[round(cx), y, round(cz)]];
  }
  // Align to the part's own stud columns when it has studs (so off-centre parts line up).
  let ox = cx - ((nx - 1) * STUD) / 2;
  let oz = cz - ((nz - 1) * STUD) / 2;
  // (a lone centre stud, as on a 4x4 dish, says nothing about the grid underneath)
  if (studs.length > 1) {
    const fx = studs[0][0] - ox;
    const fz = studs[0][2] - oz;
    ox += fx - Math.round(fx / STUD) * STUD;
    oz += fz - Math.round(fz / STUD) * STUD;
  }
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push([round(ox + i * STUD), y, round(oz + j * STUD)]);
  return out;
}

/** Places local points into the world by an LDraw placement (pos + 3x3 rot). */
export function toWorld(points, pos, rot) {
  return points.map(p => {
    const w = apply3(rot, p);
    return [w[0] + pos[0], w[1] + pos[1], w[2] + pos[2]];
  });
}

/** World-space axis-aligned box of a placed part. */
export function worldBox(info, pos, rot) {
  const pts = [];
  for (const x of [info.min[0], info.max[0]])
    for (const y of [info.min[1], info.max[1]])
      for (const z of [info.min[2], info.max[2]]) pts.push([x, y, z]);
  const w = toWorld(pts, pos, rot);
  const min = [0, 1, 2].map(i => Math.min(...w.map(p => p[i])));
  const max = [0, 1, 2].map(i => Math.max(...w.map(p => p[i])));
  return { min, max };
}

export function boxesOverlap(a, b, shrink = 1) {
  for (let i = 0; i < 3; i++) if (a.max[i] - shrink <= b.min[i] || b.max[i] - shrink <= a.min[i]) return false;
  return true;
}

export { mul3 };
