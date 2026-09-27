// Where things live on disk (~/Documents/Lego Builder) and autosave + version history.

import * as platform from './platform.js';
import { parseLdr, serializeLdr } from './ldr.js';

export const HISTORY_KEEP = 100;
const HISTORY_EVERY_MS = 30_000;

let P;
export async function init() {
  P = await platform.paths();
}
const dirs = () => ({
  creations: P.data + '/Creations',
  pieces: P.data + '/My Pieces',
  displays: P.data + '/Displays',
  pictures: P.data + '/Pictures',
  history: P.data + '/.history',
  thumbs: P.cache + '/creation-thumbs',
});
export const folder = k => dirs()[k];

export function safeName(name) {
  return (name || 'Untitled').replace(/[\/\\:*?"<>|]+/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'Untitled';
}

async function listLdr(dir) {
  const items = (await platform.listDir(dir)).filter(e => !e.is_dir && /\.(ldr|mpd)$/i.test(e.name));
  items.sort((a, b) => b.modified - a.modified);
  return items.map(e => ({ name: e.name.replace(/\.(ldr|mpd)$/i, ''), file: dir + '/' + e.name, modified: e.modified }));
}

export const listCreations = () => listLdr(folder('creations'));
export const listPieces = () => listLdr(folder('pieces'));

export async function uniqueName(base) {
  const taken = new Set((await listCreations()).map(c => c.name.toLowerCase()));
  let n = safeName(base);
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${safeName(base)} ${i}`;
  return n;
}

export async function readModel(file) {
  const text = await platform.readText(file);
  if (text == null) throw new Error('File not found: ' + file);
  const name = file.split('/').pop().replace(/\.(ldr|mpd|dat)$/i, '');
  const m = parseLdr(text, name);
  m.name = name;
  return m;
}

const lastHistory = new Map();

/** Save a creation; also drops a timestamped copy into its history (at most every 30s unless forced). */
export async function saveCreation(model, { forceHistory = false } = {}) {
  const name = safeName(model.name);
  const text = serializeLdr({ ...model, name });
  await platform.writeText(`${folder('creations')}/${name}.ldr`, text);
  const now = Date.now();
  if (forceHistory || now - (lastHistory.get(name) || 0) > HISTORY_EVERY_MS) {
    lastHistory.set(name, now);
    const hdir = `${folder('history')}/${name}`;
    await platform.writeText(`${hdir}/${new Date(now).toISOString().replace(/[:.]/g, '-')}.ldr`, text);
    const old = (await platform.listDir(hdir)).filter(e => e.name.endsWith('.ldr')).sort((a, b) => b.name.localeCompare(a.name));
    for (const e of old.slice(HISTORY_KEEP)) await platform.removeFile(`${hdir}/${e.name}`);
  }
  return name;
}

export async function listHistory(name) {
  const hdir = `${folder('history')}/${safeName(name)}`;
  const items = (await platform.listDir(hdir)).filter(e => e.name.endsWith('.ldr')).sort((a, b) => b.name.localeCompare(a.name));
  return items.map(e => ({ file: `${hdir}/${e.name}`, when: e.modified }));
}

export async function trashCreation(name) {
  await platform.trashPath(`${folder('creations')}/${safeName(name)}.ldr`);
}

export async function savePiece(name, parts) {
  const n = safeName(name);
  await platform.writeText(`${folder('pieces')}/${n}.ldr`, serializeLdr({ name: n, parts, submodels: [] }));
  return n;
}

export async function saveThumb(kind, name, blob) {
  await platform.writeBytes(`${folder('thumbs')}/${kind}-${safeName(name)}.png`, await platform.blobToBytes(blob));
}
export function thumbUrl(kind, name, bust = '') {
  return platform.fileUrl(`${folder('thumbs')}/${kind}-${safeName(name)}.png`) + (bust ? '?v=' + bust : '');
}

export async function saveDisplay(name, data) {
  const n = safeName(name);
  await platform.writeText(`${folder('displays')}/${n}.json`, JSON.stringify(data, null, 1));
  return n;
}
export async function listDisplays() {
  return (await platform.listDir(folder('displays'))).filter(e => e.name.endsWith('.json')).map(e => e.name.replace(/\.json$/, ''));
}
export async function readDisplay(name) {
  const t = await platform.readText(`${folder('displays')}/${safeName(name)}.json`);
  return t ? JSON.parse(t) : null;
}

export async function saveBlob(kind, base, ext, blob) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const path = `${folder('pictures')}/${safeName(base)} ${stamp}.${ext}`;
  await platform.writeBytes(path, await platform.blobToBytes(blob));
  return path;
}
