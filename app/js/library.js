// The LDraw parts library: file lookup, colors, 3D part templates, connection info.

import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import * as platform from './platform.js';
import { analyzePart } from './connectivity.js';

let libDir = '';
let libBase = '';
const files = new Map(); // lowercased relative path -> real relative path
export const colors = []; // { code, name, hex, edge, kind }
export const colorByCode = new Map();
let loader;

const SUBDIRS = ['parts', 'parts/s', 'parts/textures', 'p', 'p/48', 'p/8', 'models'];

/** Real relative path for an LDraw reference name, or null. */
export function resolve(name) {
  const n = name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  for (const c of ['parts/' + n, 'p/' + n, 'models/' + n, n]) {
    const hit = files.get(c);
    if (hit) return hit;
  }
  return null;
}

export function exists(name) {
  return resolve(name) != null;
}

export function libraryDir() {
  return libDir;
}

const textCache = new Map();
/** Raw text of a library file (or null). */
export function getText(name) {
  const rel = resolve(name);
  if (!rel) return Promise.resolve(inlineFiles.get(name.toLowerCase()) ?? null);
  if (!textCache.has(rel)) {
    textCache.set(
      rel,
      fetch(libBase + rel).then(r => (r.ok ? r.text() : null)).catch(() => null),
    );
  }
  return textCache.get(rel);
}

// Models imported from .mpd files define their own sub-files; they live here.
const inlineFiles = new Map();
export function registerInline(name, text) {
  inlineFiles.set(name.toLowerCase(), text);
}

function parseColors(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})\s+EDGE\s+#?([0-9A-Fa-f]{6}|\d+)(.*)$/);
    if (!m) continue;
    const rest = m[5];
    let kind = 'solid';
    if (/ALPHA/.test(rest)) kind = 'trans';
    if (/CHROME/.test(rest)) kind = 'chrome';
    else if (/METAL/.test(rest)) kind = 'metal';
    else if (/PEARLESCENT/.test(rest)) kind = 'pearl';
    else if (/RUBBER/.test(rest)) kind = 'rubber';
    else if (/MATERIAL\s+GLITTER/.test(rest)) kind = 'glitter';
    else if (/MATERIAL\s+SPECKLE/.test(rest)) kind = 'speckle';
    if (/LUMINANCE/.test(rest)) kind = 'glow';
    const c = { code: Number(m[2]), name: m[1].replace(/_/g, ' '), hex: '#' + m[3], kind };
    colors.push(c);
    colorByCode.set(c.code, c);
  }
}

/** Boot: index files, read colors, set up the loader. */
export async function init() {
  const p = await platform.paths();
  libDir = p.library;
  libBase = platform.fileUrl(libDir + '/');
  const cachePath = p.cache + '/file-index.json';
  let index = null;
  try {
    const cached = await platform.readText(cachePath);
    if (cached) index = JSON.parse(cached);
  } catch {}
  if (!index || !index.length) {
    index = [];
    for (const dir of SUBDIRS) {
      for (const e of await platform.listDir(libDir + '/' + dir)) {
        if (!e.is_dir) index.push(dir + '/' + e.name);
      }
    }
    await platform.writeText(cachePath, JSON.stringify(index));
  }
  for (const rel of index) files.set(rel.toLowerCase(), rel);

  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (!url.startsWith(libBase)) return url;
    let rel = decodeURIComponent(url.slice(libBase.length));
    for (const pre of ['parts/', 'p/', 'models/']) {
      if (rel.toLowerCase().startsWith(pre)) {
        const r = resolve(rel.slice(pre.length)) || resolve(rel);
        if (r) return libBase + r;
      }
    }
    const r = resolve(rel);
    return r ? libBase + r : url;
  });
  loader = new LDrawLoader(manager);
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  loader.setPartsLibraryPath(libBase);
  loader.smoothNormals = true;

  const cfg = await (await fetch(libBase + 'LDConfig.ldr')).text();
  parseColors(cfg);
  await loader.preloadMaterials(libBase + 'LDConfig.ldr');
  for (const m of loader.materials) tuneMaterial(m);
}

function tuneMaterial(m) {
  if (!m.isMeshStandardMaterial) return;
  const code = Number(m.userData.code);
  const c = colorByCode.get(code);
  const kind = c?.kind || 'solid';
  // Glossy ABS by default; the loader already sets metal/chrome/rubber finishes.
  if (kind === 'solid' || kind === 'trans' || kind === 'glow') m.roughness = 0.22;
  if (kind === 'pearl') m.roughness = 0.3;
  if (kind === 'trans') {
    m.transparent = true;
    m.opacity = Math.min(m.opacity, 0.55);
    m.depthWrite = false;
  }
  m.envMapIntensity = 1.0;
}

// ---- part templates (one per file+color), cloned per placement ----

const templates = new Map();
let customResolver = null; // (file) -> text for sub-models of imported MPDs

function parseAsync(text) {
  return new Promise((ok, fail) => loader.parse(text, ok, fail));
}

/** A fresh Object3D for `file` in `color`. Cheap after the first call (shares geometry). */
export async function partObject(file, color) {
  const key = file.toLowerCase() + '|' + color;
  if (!templates.has(key)) {
    templates.set(
      key,
      (async () => {
        let text = `1 ${color} 0 0 0 1 0 0 0 1 0 0 0 1 ${file}\n`;
        const inline = inlineFiles.get(file.toLowerCase());
        if (inline) text = `0 FILE main.ldr\n${text}0 FILE ${file}\n${inline}\n`;
        const g = await parseAsync(text);
        g.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        return g;
      })().catch(e => {
        templates.delete(key);
        throw e;
      }),
    );
  }
  const t = await templates.get(key);
  return t.clone(true);
}

const infoCache = new Map();
/** Connection info { studs, sockets, min, max } in the part's own coordinates. */
export function partInfo(file) {
  const k = file.toLowerCase();
  if (!infoCache.has(k)) infoCache.set(k, analyzePart(file, getText));
  return infoCache.get(k);
}

export function material(code) {
  return loader.getMaterial(String(code));
}

export function getLoader() {
  return loader;
}
