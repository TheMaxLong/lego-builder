// Builds the preset catalog (app/presets/*.ldr + index.json) from real LDraw parts.
// Everything is laid out in STUDS and PLATES; the helper works out each part's LDraw position
// from its own geometry, so presets always sit exactly on the stud grid.
// Run: node tools/gen-presets.mjs

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzePart, toWorld } from '../app/js/connectivity.js';
import { serializeLdr, quarterTurn, mul3, IDENTITY } from '../app/js/ldr.js';

const LIB = path.join(os.homedir(), 'Library/Application Support/LegoBuilder/ldraw');
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../app/presets');

async function getText(name) {
  const n = name.replace(/\\/g, '/').toLowerCase();
  for (const c of ['parts/' + n, 'p/' + n, 'models/' + n, n]) {
    try {
      return await fs.readFile(path.join(LIB, c), 'utf8');
    } catch {}
  }
  return null;
}

// Colors (LDraw codes)
const C = {
  black: 0, blue: 1, green: 2, red: 4, brown: 6, brightGreen: 10, yellow: 14, white: 15, tan: 19, orange: 25, lime: 27,
  darkTan: 28, transRed: 36, transBlue: 41, transLightBlue: 43, transYellow: 46, clear: 47, reddishBrown: 70,
  lbg: 71, dbg: 72, mediumBlue: 73, nougat: 84, darkGreen: 288, darkRed: 320, azure: 322, pink: 13, darkPink: 5,
  lightYellow: 18, pearlGold: 297, chrome: 383, transGreen: 34, transOrange: 57, magenta: 26, sand: 379,
};

class Model {
  constructor(name) {
    this.name = name;
    this.parts = [];
    this.step = 0;
  }
  nextStep() {
    this.step++;
    return this;
  }
  /**
   * Put `file` with its footprint's min corner at stud (x, z), bottom at `level` plates above ground.
   * turn = quarter turns about vertical. extra = additional rotation matrix applied first.
   */
  async at(file, color, x, z, level = 0, turn = 0, extra = IDENTITY) {
    file = file.endsWith('.dat') ? file : file + '.dat';
    if ((await getText(file)) == null) throw new Error('missing part ' + file);
    const info = await analyzePart(file, getText);
    const rot = mul3(quarterTurn('y', turn), extra);
    let anchor;
    const irregular = info.sockets.length <= 1;
    const base = irregular && info.studs.length ? info.studs.map(s => [s[0], info.max[1], s[2]]) : info.sockets;
    const w = toWorld(base, [0, 0, 0], rot);
    const box = toWorld(
      [
        [info.min[0], info.max[1], info.min[2]],
        [info.max[0], info.max[1], info.max[2]],
      ],
      [0, 0, 0],
      rot,
    );
    const bottom = Math.max(...box.map(p => p[1]));
    if (w.length > 1 || info.studs.length) {
      anchor = [Math.min(...w.map(p => p[0])) - 10, bottom, Math.min(...w.map(p => p[2])) - 10];
    } else {
      // Odd shape with one centre socket: centre it on the given stud.
      anchor = [w[0][0] - 10, bottom, w[0][2] - 10];
    }
    const pos = [x * 20 - anchor[0], -level * 8 - anchor[1], z * 20 - anchor[2]].map(v => Math.round(v * 1000) / 1000);
    const p = { id: this.parts.length + 1, file, color, pos, rot, step: this.step };
    this.parts.push(p);
    return p;
  }
  /** Exact LDraw placement (Technic parts that sit in holes, not on studs). */
  raw(file, color, pos, rot = IDENTITY, motor = 0) {
    file = file.endsWith('.dat') ? file : file + '.dat';
    const p = { id: this.parts.length + 1, file, color, pos, rot: [...rot], step: this.step };
    if (motor) p.motor = motor;
    this.parts.push(p);
    return p;
  }
  /** Same position/rotation as another part (glass in a window, door in a frame). */
  with(host, file, color, offset = [0, 0, 0], extra = IDENTITY) {
    file = file.endsWith('.dat') ? file : file + '.dat';
    const o = host.rot;
    const off = [o[0] * offset[0] + o[1] * offset[1] + o[2] * offset[2], o[3] * offset[0] + o[4] * offset[1] + o[5] * offset[2], o[6] * offset[0] + o[7] * offset[1] + o[8] * offset[2]];
    const p = { id: this.parts.length + 1, file, color, pos: host.pos.map((v, i) => Math.round((v + off[i]) * 1000) / 1000), rot: mul3(host.rot, extra), step: this.step };
    this.parts.push(p);
    return p;
  }
}

// 1-wide bricks by length, and 2-wide
const B1 = { 1: '3005', 2: '3004', 3: '3622', 4: '3010', 6: '3009', 8: '3008' };
const B2 = { 2: '3003', 3: '3002', 4: '3001', 6: '2456', 8: '3007' };
const P1 = { 1: '3024', 2: '3023b', 3: '3623', 4: '3710', 6: '3666', 8: '3460' };
const P2 = { 2: '3022', 3: '3021', 4: '3020', 6: '3795', 8: '3034', 10: '3832' };
const T1 = { 1: '3070b', 2: '3069b', 3: '63864', 4: '2431', 6: '6636', 8: '4162' };

/** Split a run into piece lengths, preferring long ones; offset alternates joints between rows. */
function split(len, sizes, offset = 0) {
  const out = [];
  let left = len;
  if (offset && left > offset && sizes.includes(offset)) {
    out.push(offset);
    left -= offset;
  }
  const s = [...sizes].sort((a, b) => b - a);
  while (left > 0) {
    const k = s.find(v => v <= left);
    out.push(k);
    left -= k;
  }
  return out;
}

/** A 1-stud-thick wall along x (dir 'x') or z (dir 'z'), `rows` bricks tall, skipping openings [{from,to,rowFrom,rowTo}]. */
async function wall(m, color, x0, z0, len, dir, rows, level = 0, openings = []) {
  for (let r = 0; r < rows; r++) {
    // Segments of this row not blocked by an opening
    const blocked = openings.filter(o => r >= o.rowFrom && r < o.rowTo);
    let segs = [[0, len]];
    for (const o of blocked) segs = segs.flatMap(([a, b]) => (o.to <= a || o.from >= b ? [[a, b]] : [[a, Math.max(a, o.from)], [Math.min(b, o.to), b]].filter(([p, q]) => q > p)));
    for (const [a, b] of segs) {
      let at = a;
      for (const n of split(b - a, [1, 2, 3, 4, 6], r % 2 && b - a > 3 ? 2 : 0)) {
        if (dir === 'x') await m.at(B1[n], color, x0 + at, z0, level + r * 3);
        else await m.at(B1[n], color, x0, z0 + at, level + r * 3, 1);
        at += n;
      }
    }
  }
}

/** Fill a rectangle with plates (or tiles) at a level. */
async function slab(m, color, x0, z0, w, d, level, kind = 'plate') {
  const table = kind === 'tile' ? T1 : P1;
  if (kind === 'plate' && d % 2 === 0) {
    for (let z = 0; z < d; z += 2) {
      let x = 0;
      for (const n of split(w, [2, 3, 4, 6, 8])) {
        await m.at(P2[n], color, x0 + x, z0 + z, level);
        x += n;
      }
    }
    return;
  }
  for (let z = 0; z < d; z++) {
    let x = 0;
    for (const n of split(w, Object.keys(table).map(Number))) {
      await m.at(table[n], color, x0 + x, z0 + z, level);
      x += n;
    }
  }
}

/** Solid block of 2-wide bricks (for fills). */
async function block(m, color, x0, z0, w, d, level, rows = 1) {
  for (let r = 0; r < rows; r++)
    for (let z = 0; z < d; z += 2) {
      let x = 0;
      for (const n of split(w, [2, 3, 4, 6, 8], r % 2 && w > 3 ? 2 : 0)) {
        if (z + 1 < d) await m.at(B2[n], color, x0 + x, z0 + z, level + r * 3);
        else await m.at(B1[n] || B1[1], color, x0 + x, z0 + z, level + r * 3);
        x += n;
      }
    }
}

/** Pitched roof along x over a (w x d) footprint, d even. Slopes face front (-z) and back (+z). */
async function roof(m, color, x0, z0, w, d, level) {
  const courses = d / 2 - 1;
  for (let k = 0; k < courses; k++) {
    const lv = level + k * 3;
    let x = 0;
    for (const n of split(w, [2, 4])) {
      await m.at(n === 4 ? '3037' : '3039', color, x0 + x, z0 + k, lv, 0); // faces -z
      await m.at(n === 4 ? '3037' : '3039', color, x0 + x, z0 + d - k - 2, lv, 2); // faces +z
      x += n;
    }
    const inner = d - 2 * k - 4;
    if (inner > 0) await block(m, color, x0, z0 + k + 2, w, inner, lv);
    m.nextStep();
  }
  let x = 0;
  for (const n of split(w, [2, 4])) {
    await m.at(n === 4 ? '3041' : '3043', color, x0 + x, z0 + d / 2 - 1, level + courses * 3);
    x += n;
  }
}

/** 2x2 wheel-pin plate under a chassis at stud (x,z), pins sticking out along z, with rims and tyres. */
async function axle(m, x, z, level, rim = C.lbg) {
  const hub = await m.at('4600', C.black, x, z, level, 1);
  for (const side of [-1, 1]) {
    const w = m.with(hub, '4624', rim, [side * WHEEL_OUT, WHEEL_Y, 0], quarterTurn('y', side > 0 ? 1 : 3));
    m.with(w, '3641', C.black);
  }
}
const WHEEL_OUT = 26;
const WHEEL_Y = 6;

// ---------------- the catalog ----------------

const catalog = [];
function category(name, blurb) {
  const c = { name, blurb, items: [] };
  catalog.push(c);
  return c;
}
async function make(cat, file, title, desc, build) {
  const m = new Model(title);
  await build(m);
  m.name = title;
  const text = serializeLdr({ name: title, parts: m.parts, submodels: [] });
  await fs.writeFile(path.join(OUT, file + '.ldr'), text);
  cat.items.push({ file: file + '.ldr', title, desc, parts: m.parts.length });
  console.log(`${file}: ${m.parts.length} parts`);
}

await fs.mkdir(OUT, { recursive: true });

// ---- Town ----
const town = category('Town', 'Houses, streets and the bits in between');

await make(town, 'grass-plot', 'Grass plot', 'A green 16 × 16 baseplate', async m => {
  await m.at('3867', C.green, 0, 0, 0);
});

await make(town, 'house', 'House', 'Two windows, a front door and a pitched red roof', async m => {
  const W = 12, D = 8, rows = 6;
  await slab(m, C.lbg, 0, 0, W, D, -1); // floor plate one plate below the walls
  m.nextStep();
  // front wall with door (x 4..8) and two windows
  const door = { from: 4, to: 8, rowFrom: 0, rowTo: 6 };
  const winL = { from: 1, to: 3, rowFrom: 2, rowTo: 4 };
  const winR = { from: 9, to: 11, rowFrom: 2, rowTo: 4 };
  await wall(m, C.white, 0, 0, W, 'x', rows, 0, [door, winL, winR]);
  await wall(m, C.white, 0, D - 1, W, 'x', rows, 0, [{ from: 5, to: 7, rowFrom: 2, rowTo: 4 }]);
  await wall(m, C.white, 0, 1, D - 2, 'z', rows, 0, [{ from: 2, to: 4, rowFrom: 2, rowTo: 4 }]);
  await wall(m, C.white, W - 1, 1, D - 2, 'z', rows, 0, [{ from: 2, to: 4, rowFrom: 2, rowTo: 4 }]);
  m.nextStep();
  const frame = await m.at('60596', C.white, 4, 0, 0);
  m.with(frame, '60623', C.blue, [-30, 0, 0]);
  for (const [x, z, t] of [[1, 0, 0], [9, 0, 0], [5, D - 1, 2]]) {
    const w = await m.at('60592', C.white, x, z, 6, t);
    m.with(w, '60601', C.clear);
  }
  for (const x of [0, W - 1]) {
    const w = await m.at('60592', C.white, x, 3, 6, 1);
    m.with(w, '60601', C.clear);
  }
  m.nextStep();
  // ceiling plates then roof
  await slab(m, C.white, 0, 0, W, D, 18);
  m.nextStep();
  await roof(m, C.red, 0, 0, W, D, 19);
});

await make(town, 'fence', 'Fence', 'A 16-stud run of white lattice fence', async m => {
  for (let x = 0; x < 16; x += 4) await m.at('3185', C.white, x, 0, 0);
});

await make(town, 'picket-fence-corner', 'Fence corner', 'Two spindled fence runs meeting at a post', async m => {
  for (let x = 1; x < 9; x += 4) await m.at('30055', C.white, x, 0, 0);
  for (let z = 1; z < 9; z += 4) await m.at('30055', C.white, 0, z, 0, 1);
  await m.at('3062b', C.white, 0, 0, 0);
  await m.at('3062b', C.white, 0, 0, 3);
});

await make(town, 'road', 'Road', 'A 32 × 32 straight road baseplate', async m => {
  await m.at('44336p01', C.dbg, 0, 0, 0);
});

await make(town, 'crossroads', 'Crossroads', 'A 32 × 32 crossroads baseplate', async m => {
  await m.at('44343p01', C.dbg, 0, 0, 0);
});

await make(town, 'street-lamp', 'Street lamp', 'A tall black lamppost with a glowing top', async m => {
  await m.at('3022', C.dbg, 0, 0, 0);
  await m.at('2039', C.black, 0, 0, 1);
  await m.at('3062b', C.transYellow, 0.5, 0.5, 22);
});

await make(town, 'mailbox', 'Mailbox', 'Blue post box with a letter slot', async m => {
  await m.at('3022', C.dbg, 0, 0, 0);
  await m.at('3003', C.blue, 0, 0, 1);
  const box = await m.at('4345b', C.blue, 0, 0, 4);
  m.with(box, '4346', C.blue);
  await m.at('3068b', C.blue, 0, 0, 10);
});

await make(town, 'bench', 'Park bench', 'A brown wooden bench', async m => {
  await m.at('3005', C.dbg, 0, 0, 0);
  await m.at('3005', C.dbg, 5, 0, 0);
  await m.at('3666', C.reddishBrown, 0, 0, 3);
  await m.at('6636', C.reddishBrown, 0, 1, 3);
  await m.at('3004', C.reddishBrown, 0, 1, 4, 0);
  await m.at('3004', C.reddishBrown, 4, 1, 4, 0);
  await m.at('6636', C.reddishBrown, 0, 1, 7);
});

await make(town, 'car', 'Small car', 'A red two-seater with a clear windscreen', async m => {
  await m.at('3795', C.dbg, 0, 0, 0);
  for (const x of [0, 4]) await axle(m, x, 0, -1);
  m.nextStep();
  await m.at('3039', C.red, 0, 0, 1, 1); // hood, sloping to the front (-x)
  await m.at('3001', C.red, 2, 0, 1);
  m.nextStep();
  await m.at('3039', C.clear, 2, 0, 4, 1); // windscreen
  await m.at('3003', C.red, 4, 0, 4);
  await m.at('3068b', C.red, 4, 0, 7);
});

// ---- Nature ----
const nature = category('Nature', 'Trees, flowers, rocks and water');

await make(nature, 'oak-tree', 'Oak tree', 'Round leafy tree on a brown trunk', async m => {
  await m.at('3062b', C.reddishBrown, 1, 1, 0);
  await m.at('3062b', C.reddishBrown, 1, 1, 3);
  await m.at('3470', C.green, 1, 1, 6);
});

await make(nature, 'pine-tree', 'Pine tree', 'Tall pointed evergreen', async m => {
  await m.at('3062b', C.reddishBrown, 1, 1, 0);
  await m.at('2435', C.darkGreen, 1, 1, 3);
});

await make(nature, 'bush', 'Bush', 'Low round bush', async m => {
  await m.at('3022', C.green, 0, 0, 0);
  await m.at('2423', C.brightGreen, 0, 0, 1);
});

await make(nature, 'flower-bed', 'Flower bed', 'Brown soil with red, yellow and white flowers', async m => {
  await m.at('3020', C.reddishBrown, 0, 0, 0);
  const cols = [C.red, C.yellow, C.white, C.pink];
  let i = 0;
  for (let x = 0; x < 4; x++)
    for (let z = 0; z < 2; z++) {
      await m.at('3742', cols[i++ % cols.length], x, z, 1);
    }
});

await make(nature, 'pond', 'Pond', 'A little pond of see-through blue tiles', async m => {
  await m.at('3958', C.tan, 0, 0, 0);
  await slab(m, C.transLightBlue, 1, 1, 4, 4, 1, 'tile');
  for (const [x, z] of [[0, 0], [5, 0], [0, 5], [5, 5]]) await m.at('3070b', C.dbg, x, z, 1);
  for (const [x, z] of [[2, 0], [0, 3], [5, 2]]) await m.at('6255', C.green, x, z, 1);
});

await make(nature, 'rocks', 'Rocks', 'A pile of grey stone', async m => {
  await m.at('3003', C.dbg, 0, 0, 0);
  await m.at('3040b', C.lbg, 2, 0, 0, 3);
  await m.at('3039', C.dbg, 0, 0, 3, 2);
  await m.at('3688', C.lbg, 1, 1, 0);
  await m.at('3040b', C.dbg, 0, 2, 0, 0);
});

await make(nature, 'hill', 'Grassy hill', 'A stepped hill with sloped sides', async m => {
  await block(m, C.green, 0, 0, 8, 8, 0);
  m.nextStep();
  for (let x = 0; x < 8; x += 4) {
    await m.at('3037', C.green, x + 0, 2, 3, 0);
    await m.at('3037', C.green, x + 0, 4, 3, 2);
  }
  await m.at('3037', C.green, 0, 0, 3, 0);
  await m.at('3037', C.green, 4, 0, 3, 0);
  await m.at('3037', C.green, 0, 6, 3, 2);
  await m.at('3037', C.green, 4, 6, 3, 2);
  m.nextStep();
  await m.at('3041', C.green, 2, 3, 6);
  await m.at('3470', C.green, 6, 3, 3);
});

// ---- Castle ----
const castle = category('Castle', 'Walls, towers and a way in');

async function battlements(m, color, x0, z0, len, dir, level) {
  for (let i = 0; i < len; i += 2) {
    if (dir === 'x') await m.at('3005', color, x0 + i, z0, level);
    else await m.at('3005', color, x0, z0 + i, level);
  }
}

await make(castle, 'castle-wall', 'Wall section', 'Grey stone wall with battlements', async m => {
  await slab(m, C.dbg, 0, 0, 8, 2, 0);
  await block(m, C.lbg, 0, 0, 8, 2, 1, 4);
  await battlements(m, C.lbg, 0, 0, 8, 'x', 13);
  await battlements(m, C.lbg, 0, 1, 8, 'x', 13);
});

await make(castle, 'castle-tower', 'Corner tower', 'Square tower with arrow slits and a lookout mast', async m => {
  const S = 6;
  const slit = r => [{ from: 2, to: 4, rowFrom: 3, rowTo: 5 }];
  await slab(m, C.dbg, 0, 0, S, S, 0);
  await wall(m, C.lbg, 0, 0, S, 'x', 9, 1, slit());
  await wall(m, C.lbg, 0, S - 1, S, 'x', 9, 1, slit());
  await wall(m, C.lbg, 0, 1, S - 2, 'z', 9, 1, [{ from: 1, to: 3, rowFrom: 3, rowTo: 5 }]);
  await wall(m, C.lbg, S - 1, 1, S - 2, 'z', 9, 1, [{ from: 1, to: 3, rowFrom: 3, rowTo: 5 }]);
  m.nextStep();
  await slab(m, C.dbg, 0, 0, S, S, 28);
  await battlements(m, C.lbg, 0, 0, S, 'x', 29);
  await battlements(m, C.lbg, 1, S - 1, S, 'x', 29);
  await battlements(m, C.lbg, S - 1, 1, S - 1, 'z', 29);
  await battlements(m, C.lbg, 0, 2, S - 2, 'z', 29);
  await m.at('2039', C.black, 2, 2, 29);
});

await make(castle, 'gatehouse', 'Gatehouse', 'An arched gate between two pillars', async m => {
  await slab(m, C.dbg, 0, 0, 8, 2, 0);
  for (const x of [0, 6]) await block(m, C.lbg, x, 0, 2, 2, 1, 5);
  await m.at('3455', C.lbg, 1, 0, 10);
  await m.at('3455', C.lbg, 1, 1, 10);
  await block(m, C.lbg, 0, 0, 8, 2, 16, 1);
  await battlements(m, C.lbg, 0, 0, 8, 'x', 19);
  await battlements(m, C.lbg, 0, 1, 8, 'x', 19);
});

await make(castle, 'drawbridge', 'Drawbridge', 'Wooden bridge planks over a moat', async m => {
  await slab(m, C.transBlue, 0, 0, 8, 8, 0, 'tile');
  await m.nextStep();
  await slab(m, C.reddishBrown, 2, 0, 4, 8, 3);
  for (const z of [0, 7]) {
    await m.at('3005', C.reddishBrown, 2, z, 0);
    await m.at('3005', C.reddishBrown, 5, z, 0);
  }
  for (let z = 0; z < 8; z += 2) await m.at('3069b', C.nougat, 2, z, 4, 1);
});

// ---- Space ----
const space = category('Space', 'Pads, rovers and ships');

await make(space, 'landing-pad', 'Landing pad', 'Grey pad with yellow landing marks and lights', async m => {
  await slab(m, C.dbg, 0, 0, 12, 12, 0);
  await slab(m, C.lbg, 2, 2, 8, 8, 1, 'tile');
  for (const [x, z] of [[0, 0], [11, 0], [0, 11], [11, 11]]) await m.at('3062b', C.transGreen, x, z, 1);
  for (let i = 3; i < 9; i++) {
    await m.at('3070b', C.yellow, i, 5, 2);
    await m.at('3070b', C.yellow, 5, i, 2);
  }
});

await make(space, 'rover', 'Rover', 'Six-stud rover with a dish antenna', async m => {
  await m.at('3795', C.lbg, 0, 0, 0);
  for (const x of [0, 4]) await axle(m, x, 0, -1, C.dbg);
  await m.at('3001', C.lbg, 1, 0, 1);
  await m.at('3020', C.blue, 0, 0, 4, 1);
  await m.at('3020', C.blue, 3, 0, 4, 1);
  await m.at('3003', C.lbg, 1, 0, 5);
  await m.at('4740', C.chrome, 1, 0, 8);
  await m.at('3069b', C.transBlue, 5, 0, 5, 1);
});

await make(space, 'shuttle', 'Space shuttle', 'White shuttle with swept wings and a blue canopy', async m => {
  await slab(m, C.white, 2, 0, 4, 10, 0);
  await m.at('41769a', C.white, 0, 5, 0);
  await m.at('41770a', C.white, 6, 5, 0);
  m.nextStep();
  await m.at('3039', C.white, 2, 0, 1);
  await m.at('3039', C.white, 4, 0, 1);
  await block(m, C.white, 2, 2, 4, 8, 1, 2);
  m.nextStep();
  await m.at('3039', C.transBlue, 2, 2, 7);
  await m.at('3039', C.transBlue, 4, 2, 7);
  await block(m, C.white, 2, 4, 4, 6, 7, 1);
  await m.at('3068b', C.white, 2, 4, 10);
  await m.at('3068b', C.white, 4, 4, 10);
  await m.at('3039', C.white, 3, 7, 10, 2);
  for (const x of [2, 4]) await m.at('3062b', C.transOrange, x, 9, 10);
});

await make(space, 'antenna-tower', 'Antenna tower', 'Radar dish on a tall mast', async m => {
  await m.at('3031', C.dbg, 0, 0, 0);
  await m.at('2039', C.lbg, 1, 1, 1);
  await m.at('3960', C.chrome, 0, 0, 22);
  await m.at('3062b', C.transRed, 1, 1, 22);
});

// ---- Interiors ----
const home = category('Interiors', 'Furniture for inside the house');

await make(home, 'table', 'Table', 'Four-legged wooden table', async m => {
  for (const [x, z] of [[0, 0], [3, 0], [0, 3], [3, 3]]) {
    await m.at('3062b', C.reddishBrown, x, z, 0);
  }
  await m.at('3031', C.reddishBrown, 0, 0, 3);
  await slab(m, C.reddishBrown, 0, 0, 4, 4, 4, 'tile');
});

await make(home, 'chair', 'Chair', 'A wooden minifig chair', async m => {
  await m.at('4079', C.reddishBrown, 0, 0, 0);
});

await make(home, 'bed', 'Bed', 'Bed with a white sheet and red blanket', async m => {
  await slab(m, C.reddishBrown, 0, 0, 4, 6, 0);
  await block(m, C.reddishBrown, 0, 0, 4, 1, 1, 1);
  await slab(m, C.white, 0, 1, 4, 5, 1, 'tile');
  await m.at('3069b', C.white, 1, 1, 2, 0);
  await slab(m, C.red, 0, 3, 4, 3, 2, 'tile');
});

await make(home, 'kitchen-counter', 'Kitchen counter', 'Cupboards with a counter top and a tap', async m => {
  for (const x of [0, 3]) {
    const cup = await m.at('4532', C.white, x, 0, 0);
    m.with(cup, '4533', C.white);
  }
  await slab(m, C.dbg, 0, 0, 6, 2, 6, 'tile');
  await m.at('4599b', C.lbg, 2, 0, 7);
});

await make(home, 'bookshelf', 'Bookshelf', 'Tall shelf full of colourful books', async m => {
  const cols = [C.red, C.blue, C.yellow, C.green, C.white, C.orange];
  for (let s = 0; s < 3; s++) {
    await m.at('3710', C.reddishBrown, 0, 0, s * 4);
    for (let i = 0; i < 4; i++) await m.at('3024', cols[(i + s) % cols.length], i, 0, s * 4 + 1);
    for (let i = 0; i < 4; i++) await m.at('3024', cols[(i + s + 2) % cols.length], i, 0, s * 4 + 2);
  }
  await m.at('3710', C.reddishBrown, 0, 0, 12);
  for (const x of [0, 3]) for (let r = 0; r < 4; r++) await m.at('3005', C.reddishBrown, x, 1, r * 3);
  await m.at('3710', C.reddishBrown, 0, 1, 12);
});


// ---- Workshop: machines that actually move (press Run machines) ----
const workshop = category('Workshop', 'Machines with real gear trains — press ▶ Run');
const ALONG_Z = quarterTurn('y', 1); // turns an axle (long along x) to run front-to-back

/** A standing minifig: feet on y=0 at (x, z); x must be a multiple of 20, z = 10 mod 20. */
function figure(m, x, z, torso, torsoColor, legsColor, hat, hatColor, head = '3626c') {
  m.raw('970c00', legsColor, [x, -40, z]);
  m.raw(torso, torsoColor, [x, -72, z]);
  m.raw(head, C.yellow, [x, -96, z]);
  if (hat) m.raw(hat, hatColor, [x, -96, z]);
}

await make(workshop, 'propeller-gearbox', 'Propeller gearbox', 'Turn the red hand wheel: 40 → 8 → 24 → 24 teeth spins the propeller 5× faster', async m => {
  await slab(m, C.dbg, 0, -2, 12, 8, -1);
  m.nextStep();
  // Two side walls, three storeys; the top storey is a Technic brick with holes at y = -94.
  for (const z of [0, 4]) {
    await m.at('6112', C.lbg, 0, z, 0);
    await m.at('60479', C.lbg, 0, z, 3);
    await m.at('60479', C.lbg, 0, z, 4);
    await m.at('6112', C.lbg, 0, z, 5);
    await m.at('60479', C.lbg, 0, z, 8);
    await m.at('60479', C.lbg, 0, z, 9);
    await m.at('3895', C.dbg, 0, z, 10);
  }
  m.nextStep();
  const Y = -94;
  // Shaft 1 (x=60): hand wheel outside the front wall is the motor, 40-tooth gear inside.
  m.raw('3706', C.black, [60, Y, 40], ALONG_Z);
  m.raw('3648b', C.red, [60, Y, -10], IDENTITY, 10);
  m.raw('3649', C.lbg, [60, Y, 30]);
  // Shaft 2 (x=120): 8-tooth pinion on the 40, 24-tooth passes it along.
  m.raw('32073', C.black, [120, Y, 50], ALONG_Z);
  m.raw('3647', C.dbg, [120, Y, 30]);
  m.raw('3648b', C.lbg, [120, Y, 50]);
  // Shaft 3 (x=180): 24-tooth, propeller out front.
  m.raw('3706', C.black, [180, Y, 40], ALONG_Z);
  m.raw('3648b', C.lbg, [180, Y, 50]);
  m.raw('41530', C.yellow, [180, Y, -10]);
  m.nextStep();
  figure(m, 20, -30, '76382p7o', C.blue, C.blue, '3833', C.yellow);
});

await make(workshop, 'windmill', 'Windmill', 'Brick tower with four sails on a turning axle', async m => {
  await m.at('41539', C.green, 0, 0, -1);
  m.nextStep();
  const X0 = 1, Z0 = 1, S = 6, rows = 7;
  const door = [{ from: 2, to: 4, rowFrom: 0, rowTo: 2 }];
  await wall(m, C.white, X0, Z0, S, 'x', rows, 0, door);
  await wall(m, C.white, X0, Z0 + S - 1, S, 'x', rows, 0);
  await wall(m, C.white, X0, Z0 + 1, S - 2, 'z', rows, 0, [{ from: 1, to: 3, rowFrom: 3, rowTo: 5 }]);
  await wall(m, C.white, X0 + S - 1, Z0 + 1, S - 2, 'z', rows, 0, [{ from: 1, to: 3, rowFrom: 3, rowTo: 5 }]);
  await m.at('3659', C.white, X0 + 1, Z0, 6); // arch over the door
  m.nextStep();
  // Top storey: Technic bricks front and back carry the sail axle.
  const L = rows * 3;
  await m.at('3894', C.reddishBrown, X0, Z0, L);
  await m.at('3894', C.reddishBrown, X0, Z0 + S - 1, L);
  await m.at('3710', C.reddishBrown, X0, Z0 + 1, L, 1);
  await m.at('3710', C.reddishBrown, X0 + S - 1, Z0 + 1, L, 1);
  m.nextStep();
  await slab(m, C.reddishBrown, X0, Z0, S, S, L + 3);
  await roof(m, C.darkRed, X0, Z0, S, S, L + 4);
  m.nextStep();
  const cx = X0 * 20 + 60;
  const y = -(L + 3) * 8 + 10;
  const zf = Z0 * 20;
  m.raw('3707', C.black, [cx, y, zf + 30], ALONG_Z); // 8 long: from 50 in front to the back wall
  m.raw('3713', C.lbg, [cx, y, zf - 10]);
  m.raw('2952', C.white, [cx, y, zf - 30], IDENTITY, 8);
  m.raw('2952', C.white, [cx, y, zf - 30], quarterTurn('z', 1));
  m.nextStep();
  figure(m, 60, 150, '76382p0e', C.white, C.sand, '3901', C.reddishBrown); // the miller, behind the tower and clear of the sails
});

await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(catalog, null, 1));
console.log(`\n${catalog.reduce((n, c) => n + c.items.length, 0)} presets in ${catalog.length} catalogs -> ${OUT}`);
