// Puts Claude's three machines into your Lego Builder as creations, plus a saved display
// "Claude's workshop" with all three out on the table in the evening light.
// Never overwrites: skips any creation or display that already exists.
// Run: node tools/install-workshop.mjs

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLdr, flattenModel, serializeLdr } from '../app/js/ldr.js';

const DATA = process.env.LEGO_DATA || path.join(os.homedir(), 'Documents/Lego Builder');
const PRESETS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../app/presets');

const machines = [
  ['carousel', 'Carousel', [0, 0, -15]],
  ['windmill', 'Windmill', [-48, 0, -10]],
  ['propeller-gearbox', 'Propeller gearbox', [52, 0, 22]],
];

const exists = p => fs.access(p).then(() => true, () => false);
await fs.mkdir(path.join(DATA, 'Creations'), { recursive: true });
await fs.mkdir(path.join(DATA, 'Displays'), { recursive: true });

for (const [file, name] of machines) {
  const out = path.join(DATA, 'Creations', name + '.ldr');
  if (await exists(out)) {
    console.log('kept existing', out);
    continue;
  }
  const m = flattenModel(parseLdr(await fs.readFile(path.join(PRESETS, file + '.ldr'), 'utf8')));
  m.name = name;
  await fs.writeFile(out, serializeLdr(m));
  console.log('wrote', out, `(${m.parts.length} parts, ${m.parts.filter(p => p.motor).length} motor)`);
}

const display = path.join(DATA, 'Displays', "Claude's workshop.json");
if (await exists(display)) console.log('kept existing', display);
else {
  const data = { furniture: 'table', light: 'evening', items: machines.map(([, name, pos]) => ({ name, pos, rotY: 0 })) };
  await fs.writeFile(display, JSON.stringify(data, null, 1));
  console.log('wrote', display);
}
