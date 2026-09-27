// Pictures, turntable videos and the build replay.

import * as THREE from 'three';
import * as platform from './platform.js';
import * as store from './store.js';

/** High-resolution PNG of the current view, saved to Pictures. */
export async function picture(stage, name, { width = 3200, height = 2000 } = {}) {
  const blob = await stage.snapshot(width, height);
  return store.saveBlob('picture', name, 'png', blob);
}

/**
 * Spin the camera once around its target and save an .mp4 (ffmpeg) to Pictures.
 * onProgress(done, total). Returns the video path.
 */
export async function turntable(stage, name, { seconds = 6, fps = 30, width = 1920, height = 1080, onProgress } = {}) {
  if (!(await platform.hasFfmpeg())) throw new Error('Turntable videos need ffmpeg (brew install ffmpeg).');
  const p = await platform.paths();
  const dir = `${p.cache}/frames-${Date.now()}`;
  const cam = stage.camera;
  const target = stage.controls.target.clone();
  const start = cam.position.clone();
  const offset = start.clone().sub(target);
  const radius = Math.hypot(offset.x, offset.z);
  const a0 = Math.atan2(offset.z, offset.x);
  const n = seconds * fps;
  stage.controls.enabled = false;
  try {
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      cam.position.set(target.x + Math.cos(a) * radius, start.y, target.z + Math.sin(a) * radius);
      cam.lookAt(target);
      const blob = await stage.snapshot(width, height);
      await platform.writeBytes(`${dir}/frame_${String(i).padStart(5, '0')}.png`, await platform.blobToBytes(blob));
      onProgress?.(i + 1, n);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const out = `${store.folder('pictures')}/${store.safeName(name)} turntable ${stamp}.mp4`;
    await platform.encodeVideo(dir, out, fps);
    for (let i = 0; i < n; i++) await platform.removeFile(`${dir}/frame_${String(i).padStart(5, '0')}.png`);
    return out;
  } finally {
    cam.position.copy(start);
    cam.lookAt(target);
    stage.controls.enabled = true;
  }
}

/**
 * Build replay: every part drops into place in build order (step, then bottom-up).
 * Returns a stop() function; resolves `done` when finished or stopped.
 */
export function replay(builder, { maxSeconds = 25 } = {}) {
  const parts = [...builder.model.parts].sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || b.pos[1] - a.pos[1]);
  const objs = parts.map(p => builder.objects.get(p.id)).filter(Boolean);
  const per = Math.max(35, Math.min(260, (maxSeconds * 1000) / Math.max(1, objs.length)));
  const fall = Math.min(420, per * 3);
  const base = objs.map(o => o.matrix.clone());
  for (const o of objs) o.visible = false;
  let stopped = false;
  const t0 = performance.now();
  let resolveDone;
  const done = new Promise(r => (resolveDone = r));
  const lift = new THREE.Matrix4();
  const finish = () => {
    objs.forEach((o, i) => {
      o.matrix.copy(base[i]);
      o.visible = !builder.hidden.has(o.userData.partId);
      o.matrixWorldNeedsUpdate = true;
    });
    builder.stage.onFrame = builder.stage.onFrame.filter(f => f !== tick);
    resolveDone();
  };
  const tick = t => {
    if (stopped) return finish();
    const el = t - t0;
    let allDone = true;
    objs.forEach((o, i) => {
      const k = (el - i * per) / fall;
      if (k < 0) {
        allDone = false;
        o.visible = false;
        return;
      }
      o.visible = !builder.hidden.has(o.userData.partId);
      const e = Math.min(1, k);
      const ease = 1 - Math.pow(1 - e, 3);
      lift.makeTranslation(0, -60 * (1 - ease), 0); // LDraw -Y is up
      o.matrix.multiplyMatrices(lift, base[i]);
      o.matrixWorldNeedsUpdate = true;
      if (e < 1) allDone = false;
    });
    if (allDone) finish();
  };
  builder.stage.onFrame.push(tick);
  return { stop: () => (stopped = true), done };
}
