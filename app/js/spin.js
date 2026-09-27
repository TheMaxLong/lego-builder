// Turns analysed shafts on screen. Works on any map of part id -> Object3D whose matrices are in LDraw space.

import * as THREE from 'three';
import { analyze } from './mechanics.js';

export async function mechanismFor(parts, objects, info, title) {
  const r = await analyze(parts, info, title);
  const entries = [];
  for (const s of r.shafts) {
    if (!s.omega) continue;
    for (const id of s.ids) {
      const obj = objects.get(id);
      if (obj) entries.push({ obj, base: obj.matrix.clone(), axis: new THREE.Vector3(...s.axis), point: new THREE.Vector3(...s.point), omega: s.omega });
    }
  }
  return { entries, report: r };
}

export class Spinner {
  constructor(stage, entries) {
    this.stage = stage;
    this.entries = entries;
    this.t0 = performance.now();
    const m = new THREE.Matrix4();
    const a = new THREE.Matrix4();
    const b = new THREE.Matrix4();
    this.tick = t => {
      const sec = (t - this.t0) / 1000;
      for (const e of this.entries) {
        a.makeTranslation(e.point.x, e.point.y, e.point.z);
        m.makeRotationAxis(e.axis, e.omega * sec);
        b.makeTranslation(-e.point.x, -e.point.y, -e.point.z);
        e.obj.matrix.copy(a).multiply(m).multiply(b).multiply(e.base);
        e.obj.matrixWorldNeedsUpdate = true;
      }
    };
    stage.onFrame.push(this.tick);
  }

  stop() {
    this.stage.onFrame = this.stage.onFrame.filter(f => f !== this.tick);
    for (const e of this.entries) {
      e.obj.matrix.copy(e.base);
      e.obj.matrixWorldNeedsUpdate = true;
    }
  }
}
