// Turning whole models into 3D objects (for thumbnails, the display table and previews).

import * as THREE from 'three';
import * as lib from './library.js';

export function placementMatrix(pos, rot) {
  return new THREE.Matrix4().set(rot[0], rot[1], rot[2], pos[0], rot[3], rot[4], rot[5], pos[1], rot[6], rot[7], rot[8], pos[2], 0, 0, 0, 1);
}

/** One Group (in LDraw space) holding every part of a model. Parts that fail to load are skipped. */
export async function modelObject(model) {
  for (const s of model.submodels || []) lib.registerInline(s.file, s.text);
  const g = new THREE.Group();
  const objs = await Promise.all(model.parts.map(p => lib.partObject(p.file, p.color).catch(() => null)));
  objs.forEach((o, i) => {
    if (!o) return;
    const p = model.parts[i];
    o.matrixAutoUpdate = false;
    o.matrix.copy(placementMatrix(p.pos, p.rot));
    o.userData.step = p.step ?? 0;
    g.add(o);
  });
  return g;
}

/** Which referenced files the library cannot find (checks a model is complete). */
export function missingParts(model) {
  const inline = new Set((model.submodels || []).map(s => s.file.toLowerCase()));
  return [...new Set(model.parts.map(p => p.file))].filter(f => !inline.has(f.toLowerCase()) && !lib.exists(f));
}
