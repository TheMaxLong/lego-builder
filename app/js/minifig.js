// Minifigure builder: pick head, torso, legs, headwear and a held accessory; drop it in as parts.
// Offsets are the standard LDraw minifig stack (torso origin at the neck, hips 32 below).

import * as catalog from './catalog.js';
import { IDENTITY, mul3, apply3 } from './ldr.js';
import { modelObject } from './models.js';
import { renderObject } from './thumbs.js';

// Everything relative to the feet (y = 0 at the bottom of the legs).
const LEGS_Y = -40;
const TORSO_Y = -72;
const HEAD_Y = -96;
// Right hand of a standard torso-with-arms shortcut (from 973c01.dat), relative to the torso.
const HAND_POS = [-23.6904, 26.774, -9.8982];
const HAND_ROT = [0.985, -0.1202, 0.1202, 0.17, 0.6964, -0.6964, 0, 0.707, 0.707];
// Held items are modelled with their grip on the hand's clip axis, turned into the hand.
export const ACCESSORY_ROT = [1, 0, 0, 0, 0, 1, 0, -1, 0];
export const ACCESSORY_OFFSET = [0, 0, -10];

export const SLOTS = {
  head: { label: 'Head', test: p => /^Minifig Head\b/i.test(p.title) && !/Modified|Cover/i.test(p.title) },
  torso: { label: 'Torso', test: p => /^Minifig Torso with Arms/i.test(p.title) && /Hands/i.test(p.title) },
  legs: { label: 'Legs', test: p => /^Minifig (Hips and Legs|Legs)\b/i.test(p.title) && p.cat.startsWith('Minifig') },
  hat: { label: 'Hair / hat', test: p => p.cat === 'Minifig Headwear', optional: true },
  item: { label: 'In hand', test: p => p.cat === 'Minifig Accessory' && !/Stand|Base/i.test(p.title), optional: true },
};

export const DEFAULTS = {
  head: { file: '3626c.dat', color: 14 },
  torso: { file: '973c01.dat', color: 4 },
  legs: { file: 'plain', color: 1 },
  hat: { file: '3901.dat', color: 6 },
  item: { file: '', color: 0 },
};

export function options(slot) {
  return catalog.where(SLOTS[slot].test).sort((a, b) => Number(a.printed) - Number(b.printed) || a.title.localeCompare(b.title, undefined, { numeric: true }));
}

/** LDraw parts for a figure standing with its feet at y=0, left foot socket on the lattice. */
export function assemble(fig) {
  const parts = [];
  const add = (file, color, pos, rot = IDENTITY) => file && parts.push({ id: 0, file, color, pos, rot: [...rot], step: 0 });
  if (fig.legs.file === 'plain' || !fig.legs.file) {
    add('3815b.dat', fig.legs.color, [0, LEGS_Y, 0]);
    add('3816c.dat', fig.legs.color, [0, LEGS_Y + 12, 0]);
    add('3817c.dat', fig.legs.color, [0, LEGS_Y + 12, 0]);
  } else add(fig.legs.file, fig.legs.color, [0, LEGS_Y, 0]);
  add(fig.torso.file, fig.torso.color, [0, TORSO_Y, 0]);
  add(fig.head.file, fig.head.color, [0, HEAD_Y, 0]);
  if (fig.hat?.file) add(fig.hat.file, fig.hat.color, [0, HEAD_Y, 0]);
  if (fig.item?.file) {
    const rot = mul3(HAND_ROT, ACCESSORY_ROT);
    const off = apply3(HAND_ROT, ACCESSORY_OFFSET);
    add(fig.item.file, fig.item.color, [HAND_POS[0] + off[0], TORSO_Y + HAND_POS[1] + off[1], HAND_POS[2] + off[2]], rot);
  }
  return parts;
}

/** Grab point for snapping: under the left foot, relative to the legs part (the first item). */
export const GRAB = [-10, -LEGS_Y, 0];

export async function preview(fig, size = 320) {
  return renderObject(await modelObject({ parts: assemble(fig), submodels: [] }), size);
}

export function random(colors) {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const solid = colors.filter(c => c.kind === 'solid').map(c => c.code);
  const fig = {};
  for (const slot of Object.keys(SLOTS)) {
    const opts = options(slot);
    fig[slot] = { file: pick(opts)?.file || DEFAULTS[slot].file, color: pick(solid) };
  }
  fig.head.color = 14;
  if (Math.random() < 0.5) fig.item = { file: '', color: 0 };
  return fig;
}
