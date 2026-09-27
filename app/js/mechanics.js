// Mechanisms: works out which parts turn together and how fast, from nothing but geometry.
//   shaft  = rotating parts sharing one axis line (axles, gears, bushes, wheels, propellers)
//   mesh   = two spur gears on parallel shafts whose centres sit one pitch-radius-sum apart
//   motor  = any part with part.motor (rpm) set; it drives its shaft, meshes pass it on
// Pure logic (no three.js) so it runs in tests. All units LDraw.

import { apply3 } from './ldr.js';

const ROTOR = /\b(Gear|Axle|Propeller|Bush|Wheel|Rim|Tyre|Tire|Hub|Rotor|Pulley|Turntable)\b/i;
const NOT_SPUR = /Bevel|Crown|Worm|Rack|Differential|Knob|Clutch Ring|Driving Ring/i;
const FIXED = /Turntable.*Base|Base.*Turntable/i; // the half of a turntable that stays put
const TOOTH_RADIUS = 1.25; // Technic spur gears: pitch radius = teeth * 1.25 LDU (8t=10, 24t=30, 40t=50)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** Canonical direction so two parallel axes compare with the same sign. */
function canon(v) {
  const l = len(v) || 1;
  let u = scale(v, 1 / l);
  const k = Math.abs(u[0]) > 1e-6 ? 0 : Math.abs(u[1]) > 1e-6 ? 1 : 2;
  if (u[k] < 0) u = scale(u, -1);
  return u;
}

export function gearTeeth(title) {
  if (!title || NOT_SPUR.test(title)) return 0;
  const m = title.match(/Gear\s+(\d+)\s+Tooth/i);
  return m ? Number(m[1]) : 0;
}

/**
 * parts: [{id, file, pos, rot, motor?}], info(file) -> {min,max}, title(file) -> string.
 * Returns { shafts: [{ axis, point, omega, ids, driven }], meshes, gears }.
 */
export async function analyze(parts, info, title) {
  const rotors = [];
  for (const p of parts) {
    const t = title(p.file) || '';
    if ((!ROTOR.test(t) || FIXED.test(t)) && !p.motor) continue;
    const i = await info(p.file);
    const ext = [0, 1, 2].map(k => i.max[k] - i.min[k]);
    // Axles turn about their long dimension; discs (gears, wheels, bushes, propellers) about their thin one.
    const k = /\bAxle\b/i.test(t) && !/Gear|Wheel|Bush/i.test(t) ? ext.indexOf(Math.max(...ext)) : ext.indexOf(Math.min(...ext));
    const e = [0, 0, 0];
    e[k] = 1;
    const centreLocal = [0, 1, 2].map(n => (i.min[n] + i.max[n]) / 2);
    const c = apply3(p.rot, centreLocal);
    const axis = canon(apply3(p.rot, e));
    const teeth = gearTeeth(t);
    rotors.push({ id: p.id, axis, centre: [c[0] + p.pos[0], c[1] + p.pos[1], c[2] + p.pos[2]], half: ext[k] / 2, teeth, radius: teeth * TOOTH_RADIUS, motor: p.motor || 0 });
  }

  // Union coaxial rotors whose spans along the axis touch or overlap.
  const parent = rotors.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < rotors.length; a++)
    for (let b = a + 1; b < rotors.length; b++) {
      const A = rotors[a];
      const B = rotors[b];
      if (Math.abs(dot(A.axis, B.axis)) < 0.995) continue;
      const d = sub(B.centre, A.centre);
      const along = dot(d, A.axis);
      const off = len(sub(d, scale(A.axis, along)));
      if (off > 2.5) continue;
      if (Math.abs(along) > A.half + B.half + 2) continue;
      parent[find(a)] = find(b);
    }
  const groups = new Map();
  rotors.forEach((r, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  });
  const shafts = [...groups.values()].map(rs => ({ axis: rs[0].axis, point: rs[0].centre, ids: rs.map(r => r.id), rotors: rs, omega: 0, driven: false }));
  // Riders: anything whose underside sits on the studs of a turning part turns with it (and so on up).
  const placeAll = (p, pts) => pts.map(v => {
    const w = apply3(p.rot, v);
    return [w[0] + p.pos[0], w[1] + p.pos[1], w[2] + p.pos[2]];
  });
  const assigned = new Set(rotors.map(r => r.id));
  const byId = new Map(parts.map(p => [p.id, p]));
  const infos = new Map();
  for (const p of parts) if (!infos.has(p.file)) infos.set(p.file, await info(p.file));
  if (rotors.length)
    for (const s of shafts) {
      const studs = [];
      for (const id of s.ids) studs.push(...placeAll(byId.get(id), infos.get(byId.get(id).file).studs));
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of parts) {
          if (assigned.has(p.id)) continue;
          const i = infos.get(p.file);
          const socks = placeAll(p, i.sockets);
          const loose = i.sockets.length === 1 ? 12 : 1.5; // one-socket parts (minifig legs) sit between studs
          let sits = socks.some(k => studs.some(t => Math.abs(t[1] - k[1]) < 1.5 && Math.hypot(t[0] - k[0], t[2] - k[2]) < loose));
          // Minifig pieces join by pegs, not studs: same centre line (or a held item beside a torso) = same figure.
          if (!sits && /^Minifig/i.test(title(p.file) || '')) {
            const reach = /Accessory/i.test(title(p.file)) ? 45 : 4;
            sits = s.ids.some(id => {
              const q = byId.get(id);
              return /^Minifig/i.test(title(q.file) || '') && Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]) < reach && Math.abs(q.pos[1] - p.pos[1]) <= 60;
            });
          }
          if (!sits) continue;
          assigned.add(p.id);
          s.ids.push(p.id);
          studs.push(...placeAll(p, i.studs));
          grew = true;
        }
      }
    }

  const shaftOf = new Map();
  shafts.forEach((s, i) => s.rotors.forEach(r => shaftOf.set(r, i)));

  // Gear meshes between different shafts.
  const gears = rotors.filter(r => r.teeth);
  const meshes = [];
  for (let a = 0; a < gears.length; a++)
    for (let b = a + 1; b < gears.length; b++) {
      const A = gears[a];
      const B = gears[b];
      const sa = shaftOf.get(A);
      const sb = shaftOf.get(B);
      if (sa === sb || Math.abs(dot(A.axis, B.axis)) < 0.995) continue;
      const d = sub(B.centre, A.centre);
      const along = dot(d, A.axis);
      if (Math.abs(along) > 8) continue; // not in the same plane
      const dist = len(sub(d, scale(A.axis, along)));
      if (Math.abs(dist - (A.radius + B.radius)) > 3) continue;
      meshes.push({ a: sa, b: sb, ratio: -A.radius / B.radius, ids: [A.id, B.id] });
    }

  // Motors drive their shafts; meshes pass rotation on (first come wins if a train is over-constrained).
  const queue = [];
  shafts.forEach((s, i) => {
    const m = s.rotors.find(r => r.motor);
    if (m) {
      s.omega = (m.motor * 2 * Math.PI) / 60;
      s.driven = true;
      queue.push(i);
    }
  });
  while (queue.length) {
    const i = queue.shift();
    for (const m of meshes) {
      const [from, to, k] = m.a === i ? [m.a, m.b, m.ratio] : m.b === i ? [m.b, m.a, 1 / m.ratio] : [null];
      if (from == null || shafts[to].driven) continue;
      shafts[to].omega = shafts[from].omega * k;
      shafts[to].driven = true;
      queue.push(to);
    }
  }
  return { shafts: shafts.map(({ rotors, ...s }) => s), meshes, gears: gears.length };
}
