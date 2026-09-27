// Run: node --test tests/
// Checks the fiddly logic against the real LDraw library on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLdr, serializeLdr, quarterTurn, mul3, IDENTITY } from '../app/js/ldr.js';
import { analyzePart, footprintSockets } from '../app/js/connectivity.js';

const LIB = path.join(os.homedir(), 'Library/Application Support/LegoBuilder/ldraw');

// Same lookup order as library.js resolve()
async function getText(name) {
  const n = name.replace(/\\/g, '/').toLowerCase();
  for (const c of ['parts/' + n, 'p/' + n, 'models/' + n, n]) {
    try {
      return await fs.readFile(path.join(LIB, c), 'utf8');
    } catch {}
  }
  return null;
}

const sortPts = a => [...a].sort((p, q) => p[0] - q[0] || p[2] - q[2]);

test('.ldr save -> open -> save is byte-stable', () => {
  const model = {
    name: 'Roundtrip',
    parts: [
      { id: 1, file: '3001.dat', color: 4, pos: [0, -24, 0], rot: [...IDENTITY], step: 0 },
      { id: 2, file: '3039.dat', color: 15, pos: [30, -48, -10], rot: quarterTurn('y', 1), step: 1 },
      { id: 3, file: '3024.dat', color: 334, pos: [10.5, -56, 10], rot: mul3(quarterTurn('y', 3), quarterTurn('x', 1)), step: 1 },
    ],
    submodels: [],
  };
  const a = serializeLdr(model);
  const back = parseLdr(a);
  assert.equal(back.name, 'Roundtrip');
  assert.equal(back.parts.length, 3);
  assert.deepEqual(back.parts[2].pos, [10.5, -56, 10]);
  assert.equal(back.parts[1].step, 1);
  assert.equal(serializeLdr(back), a);
});

test('mpd submodels survive a round trip', () => {
  const text = '0 FILE main.ldr\n0 Name: main.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n0 FILE sub.ldr\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n';
  const m = parseLdr(text);
  assert.equal(m.parts[0].file, 'sub.ldr');
  assert.equal(m.submodels.length, 1);
  const again = parseLdr(serializeLdr(m));
  assert.equal(again.submodels[0].file, 'sub.ldr');
  assert.match(again.submodels[0].text, /3001\.dat/);
});

test('quarter turns are exact and compose to identity', () => {
  let r = IDENTITY;
  for (let i = 0; i < 4; i++) r = mul3(quarterTurn('y', 1), r);
  assert.deepEqual(r, IDENTITY);
});

test('2x4 brick: 8 studs on top, 8 sockets underneath, 24 LDU tall', async () => {
  const i = await analyzePart('3001.dat', getText);
  assert.equal(i.studs.length, 8);
  assert.deepEqual(sortPts(i.studs).map(s => [s[0], s[2]]), [[-30, -10], [-30, 10], [-10, -10], [-10, 10], [10, -10], [10, 10], [30, -10], [30, 10]]);
  assert.ok(i.studs.every(s => s[1] === 0));
  assert.equal(i.sockets.length, 8);
  assert.ok(i.sockets.every(s => s[1] === 24));
  assert.equal(i.max[1] - Math.min(0, i.min[1] + 4), 24);
});

test('1x1 plate and 2x2 slope', async () => {
  const plate = await analyzePart('3024.dat', getText);
  assert.equal(plate.studs.length, 1);
  assert.deepEqual(plate.sockets, [[0, 8, 0]]);
  const slope = await analyzePart('3039.dat', getText);
  assert.equal(slope.studs.length, 2, 'a 2x2 45° slope has one row of 2 studs');
  assert.equal(slope.sockets.length, 4);
});

test('16x16 baseplate has 256 studs on the lattice (x,z = 10 mod 20)', async () => {
  const b = await analyzePart('3867.dat', getText);
  assert.equal(b.studs.length, 256);
  assert.ok(b.studs.every(s => ((s[0] - 10) % 20 + 20) % 20 === 0 && ((s[2] - 10) % 20 + 20) % 20 === 0));
});

test('tile has no studs but still has sockets', async () => {
  const t = await analyzePart('3068b.dat', getText);
  assert.equal(t.studs.length, 0);
  assert.equal(t.sockets.length, 4);
});

test('footprint of an odd-shaped part falls back to one centre socket', () => {
  assert.deepEqual(footprintSockets([-7, 0, -7], [7, 10, 7]), [[0, 10, 0]]);
});

test('flattenModel expands MPD submodels into library parts with composed placement + colour', async () => {
  const { flattenModel, parseLdr } = await import('../app/js/ldr.js');
  const text = [
    '0 FILE main.ldr',
    '1 4 100 0 0 0 0 1 0 1 0 -1 0 0 wing.ldr', // wing rotated a quarter turn about y, colour red
    '1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat',
    '0 FILE wing.ldr',
    '1 16 20 0 0 1 0 0 0 1 0 0 0 1 3003.dat', // inherits red
    '1 1 0 0 0 1 0 0 0 1 0 0 0 1 custom.dat',
    '0 FILE custom.dat',
    '3 16 0 0 0 10 0 0 0 0 10',
  ].join('\n');
  const f = flattenModel(parseLdr(text));
  const byFile = Object.fromEntries(f.parts.map(p => [p.file, p]));
  assert.equal(f.parts.length, 3);
  assert.equal(byFile['3003.dat'].color, 4);
  assert.deepEqual(byFile['3003.dat'].pos, [100, 0, -20]); // (20,0,0) turned: x->-z
  assert.equal(byFile['3001.dat'].color, 15);
  assert.equal(byFile['custom.dat'].color, 1);
  assert.deepEqual(f.submodels.map(s => s.file), ['custom.dat']);
});

test('turning a selection keeps every stud on the lattice', async () => {
  // builder.js imports three via the browser import map; test the pure helper by extracting it.
  const src = await fs.readFile(new URL('../app/js/builder.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function latticeCentre'), src.indexOf('export class Builder'));
  const latticeCentre = new Function(body.replace('export ', '') + '; return latticeCentre;')();
  const onLattice = v => ((v - 10) % 20 + 20) % 20 === 0;
  for (const origins of [[[0, -24, 0], [20, -48, 0]], [[10, 0, 10]], [[0, 0, 0], [40, 0, 60], [-20, 0, 20]]]) {
    const c = latticeCentre(origins);
    for (let sx = -50; sx <= 50; sx += 20)
      for (let sz = -50; sz <= 50; sz += 20) {
        // stud (sx, sz) turned a quarter about c
        const x = c[0] + (sz - c[2]);
        const z = c[2] - (sx - c[0]);
        assert.ok(onLattice(x) && onLattice(z), `stud ${sx},${sz} -> ${x},${z} off lattice for centre ${c}`);
      }
  }
});
