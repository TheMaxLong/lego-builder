// The editor: model state, snapping ghost, selection, tools, undo/redo.
// Everything inside stage.root is in raw LDraw units (stud 20, plate 8, brick 24, -Y up).

import * as THREE from 'three';
import * as lib from './library.js';
import { IDENTITY, mul3, apply3, quarterTurn, roundRot, newId } from './ldr.js';
import { toWorld, worldBox, boxesOverlap } from './connectivity.js';

const STUD = 20;
const snapLattice = v => Math.round((v - 10) / STUD) * STUD + 10;
const snapPlate = v => Math.round(v / 8) * 8;

function placementMatrix(pos, rot) {
  return new THREE.Matrix4().set(rot[0], rot[1], rot[2], pos[0], rot[3], rot[4], rot[5], pos[1], rot[6], rot[7], rot[8], pos[2], 0, 0, 0, 1);
}

const clonePart = p => ({ ...p, pos: [...p.pos], rot: [...p.rot] });

export class Builder extends EventTarget {
  constructor(stage) {
    super();
    this.stage = stage;
    this.model = { name: 'Untitled', parts: [], submodels: [] };
    this.objects = new Map(); // part id -> Object3D
    this.selection = new Set();
    this.hidden = new Set();
    this.tool = 'build'; // build | select | paint
    this.color = 4; // red
    this.ghost = null; // { items, rot, grab, group, target, valid }
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = null;
    this.stepCounter = 0;
    this.worldStudCache = new Map();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.cursorGhost = new THREE.Group();
    stage.root.add(this.cursorGhost);
    this._bindInput();
  }

  // ---------- model changes ----------

  _snapshot() {
    return JSON.stringify(this.model.parts);
  }

  /** Every edit goes through here so undo, autosave and the 3D scene stay in step. */
  async commit(mutator, { undoable = true } = {}) {
    const before = this._snapshot();
    mutator(this.model.parts);
    if (undoable && this._snapshot() !== before) {
      this.undoStack.push(before);
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    await this.sync();
    this.dispatchEvent(new Event('change'));
  }

  async undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this.model.parts = JSON.parse(this.undoStack.pop());
    this._pruneSelection();
    await this.sync();
    this.dispatchEvent(new Event('change'));
  }

  async redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this.model.parts = JSON.parse(this.redoStack.pop());
    this._pruneSelection();
    await this.sync();
    this.dispatchEvent(new Event('change'));
  }

  _pruneSelection() {
    const ids = new Set(this.model.parts.map(p => p.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
    this._updateOutline();
  }

  /** Replace the whole model (open file, new, preset-as-model). */
  async load(model) {
    for (const o of this.objects.values()) this.stage.root.remove(o);
    this.objects.clear();
    this.worldStudCache.clear();
    this.model = model;
    this.selection.clear();
    this.hidden.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.stepCounter = Math.max(0, ...model.parts.map(p => p.step ?? 0)) + 1;
    await this.sync();
    this._updateOutline();
    this.frameAll(true);
    this.dispatchEvent(new Event('change'));
  }

  /** Bring the 3D scene in line with model.parts. */
  async sync() {
    const token = (this._syncToken = (this._syncToken || 0) + 1);
    const want = new Map(this.model.parts.map(p => [p.id, p]));
    for (const [id, obj] of this.objects) {
      if (!want.has(id)) {
        this.stage.root.remove(obj);
        this.objects.delete(id);
        this.worldStudCache.delete(id);
      }
    }
    const jobs = [];
    for (const p of this.model.parts) {
      const key = p.file.toLowerCase() + '|' + p.color;
      const obj = this.objects.get(p.id);
      const pose = p.pos.join(',') + '|' + p.rot.join(',');
      if (obj && obj.userData.key === key) {
        if (obj.userData.pose !== pose) {
          obj.matrix.copy(placementMatrix(p.pos, p.rot));
          obj.userData.pose = pose;
          obj.matrixWorldNeedsUpdate = true;
          this.worldStudCache.delete(p.id);
        }
        obj.visible = !this.hidden.has(p.id);
        continue;
      }
      jobs.push(
        lib
          .partObject(p.file, p.color)
          .then(o => {
            const cur = this.model.parts.find(x => x.id === p.id);
            if (!cur || cur.file.toLowerCase() + '|' + cur.color !== key) return; // changed while loading
            const old = this.objects.get(p.id);
            if (old) this.stage.root.remove(old);
            o.matrixAutoUpdate = false;
            o.matrix.copy(placementMatrix(p.pos, p.rot));
            o.userData = { partId: p.id, key, pose };
            o.visible = !this.hidden.has(p.id);
            this.stage.root.add(o);
            this.objects.set(p.id, o);
            this.worldStudCache.delete(p.id);
          })
          .catch(e => console.warn('part failed', p.file, e)),
      );
    }
    await Promise.all(jobs);
    this._updateOutline();
    this._fitShadows();
  }

  _fitShadows() {
    this.stage.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const o of this.objects.values()) if (o.visible) box.expandByObject(o);
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 10, 20));
    this.stage.fitShadows(box);
  }

  frameAll(instant = false) {
    this.stage.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const ids = this.selection.size ? [...this.selection] : [...this.objects.keys()];
    for (const id of ids) {
      const o = this.objects.get(id);
      if (o && o.visible) box.expandByObject(o);
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-16, 0, -16), new THREE.Vector3(16, 4, 16));
    this.stage.frame(box, { instant });
  }

  partById(id) {
    return this.model.parts.find(p => p.id === id);
  }

  // ---------- ghost (the see-through part following the cursor) ----------

  /** Start carrying parts. items are LDraw placements; they keep their relative layout. */
  async carry(items, { keepIds = false } = {}) {
    this.cancelGhost();
    if (!items.length) return;
    const infos = await Promise.all(items.map(i => lib.partInfo(i.file)));
    // Anchor frame = first item's position; ghost rotation starts at identity.
    const a = items[0].pos;
    const rel = items.map(i => ({ ...clonePart(i), pos: [i.pos[0] - a[0], i.pos[1] - a[1], i.pos[2] - a[2]] }));
    // All bottom sockets in anchor frame; grab the lowest one nearest the footprint centre.
    let sockets = [];
    rel.forEach((it, k) => (sockets = sockets.concat(toWorld(infos[k].sockets, it.pos, it.rot))));
    const lowest = Math.max(...sockets.map(s => s[1]));
    const low = sockets.filter(s => Math.abs(s[1] - lowest) < 0.5);
    const cx = low.reduce((s, v) => s + v[0], 0) / low.length;
    const cz = low.reduce((s, v) => s + v[2], 0) / low.length;
    low.sort((p, q) => Math.hypot(p[0] - cx, p[2] - cz) - Math.hypot(q[0] - cx, q[2] - cz));
    const group = new THREE.Group();
    const objs = await Promise.all(rel.map(it => lib.partObject(it.file, it.color)));
    objs.forEach((o, k) => {
      o.matrixAutoUpdate = false;
      o.matrix.copy(placementMatrix(rel[k].pos, rel[k].rot));
      o.traverse(m => {
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          const ghosted = mats.map(mt => {
            const c = mt.clone();
            c.transparent = true;
            c.opacity = Math.min(c.opacity ?? 1, 0.6);
            c.depthWrite = false;
            return c;
          });
          m.material = Array.isArray(m.material) ? ghosted : ghosted[0];
          m.castShadow = false;
        }
      });
      group.add(o);
    });
    group.visible = false;
    this.cursorGhost.add(group);
    this.ghost = { items: rel, infos, rot: [...IDENTITY], grab: low[0], group, target: null, valid: false, keepIds };
    this._updateGhost();
  }

  /** Carry a single library part (from the parts drawer). */
  carryPart(file) {
    this.setTool('build');
    this.lastPart = file;
    return this.carry([{ id: 0, file, color: this.color, pos: [0, 0, 0], rot: [...IDENTITY] }]);
  }

  cancelGhost() {
    if (!this.ghost) return;
    this.cursorGhost.remove(this.ghost.group);
    this.ghost.group.traverse(m => {
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => x.dispose());
    });
    this.ghost = null;
    this.dispatchEvent(new Event('ghost'));
  }

  rotateGhost(axis, n) {
    if (!this.ghost) return false;
    this.ghost.rot = roundRot(mul3(quarterTurn(axis, n), this.ghost.rot));
    this._updateGhost();
    return true;
  }

  /** Ghost's world placements for its current rotation and snap target. */
  _ghostPlacements() {
    const g = this.ghost;
    const grabW = apply3(g.rot, g.grab);
    const base = [g.target[0] - grabW[0], g.target[1] - grabW[1], g.target[2] - grabW[2]];
    return g.items.map(it => {
      const p = apply3(g.rot, it.pos);
      return { ...it, pos: [p[0] + base[0], p[1] + base[1], p[2] + base[2]].map(v => Math.round(v * 1000) / 1000), rot: roundRot(mul3(g.rot, it.rot)) };
    });
  }

  _updateGhost() {
    const g = this.ghost;
    if (!g) return;
    if (!g.target) {
      g.group.visible = false;
      return;
    }
    const grabW = apply3(g.rot, g.grab);
    const base = [g.target[0] - grabW[0], g.target[1] - grabW[1], g.target[2] - grabW[2]];
    g.group.matrixAutoUpdate = false;
    g.group.matrix.copy(placementMatrix(base, g.rot));
    g.group.matrixWorldNeedsUpdate = true;
    g.group.visible = true;
    // Overlap check against visible parts: tint red but still allow (doors sit inside frames).
    const placed = this._ghostPlacements();
    const boxes = placed.map((p, k) => worldBox(g.infos[k], p.pos, p.rot));
    let hit = false;
    for (const p of this.model.parts) {
      const info = this._infoNow(p.file);
      if (!info) continue;
      const b = worldBox(info, p.pos, p.rot);
      if (boxes.some(x => boxesOverlap(x, b, 2))) {
        hit = true;
        break;
      }
    }
    g.valid = !hit;
    g.group.traverse(m => {
      if (m.isMesh && m.material && !Array.isArray(m.material)) m.material.emissive?.setHex(hit ? 0x661100 : 0x000000);
    });
  }

  _infoNow(file) {
    // Synchronous peek at already-analysed parts (analysis is kicked off on first sight).
    const k = file.toLowerCase();
    this._infos ??= new Map();
    if (this._infos.has(k)) return this._infos.get(k);
    lib.partInfo(file).then(i => this._infos.set(k, i));
    return null;
  }

  async _worldStuds(part) {
    if (this.worldStudCache.has(part.id)) return this.worldStudCache.get(part.id);
    const info = await lib.partInfo(part.file);
    const w = toWorld(info.studs, part.pos, part.rot);
    this.worldStudCache.set(part.id, w);
    return w;
  }

  // ---------- picking ----------

  _setPointer(e) {
    const r = this.stage.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.stage.camera);
  }

  /** First visible part mesh under the pointer: { part, point(LDraw), normal(LDraw) } or null. */
  _pick() {
    const objs = [...this.objects.values()].filter(o => o.visible);
    const hits = this.raycaster.intersectObjects(objs, true).filter(h => h.object.isMesh && h.face);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.partId == null) o = o.parent;
      if (!o) continue;
      const part = this.partById(o.userData.partId);
      if (!part || this.hidden.has(part.id)) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      const inv = new THREE.Matrix4().copy(this.stage.root.matrixWorld).invert();
      const nl = n.transformDirection(inv);
      return { part, point: this.stage.toLdraw(h.point), normal: [nl.x, nl.y, nl.z] };
    }
    return null;
  }

  async _snapTarget() {
    this._side = null;
    const hit = this._pick();
    if (hit) {
      const [nx, ny, nz] = hit.normal;
      // Pointing at a stud itself (its round side or its top): snap onto that stud.
      for (const s of await this._worldStuds(hit.part)) {
        if (Math.hypot(s[0] - hit.point[0], s[2] - hit.point[2]) < 9 && hit.point[1] <= s[1] + 0.5 && hit.point[1] >= s[1] - 5) return [...s];
      }
      if (ny < -0.7) {
        // Top face: click onto the nearest stud of the part under the cursor.
        const studs = await this._worldStuds(hit.part);
        let best = null;
        let bd = 16;
        for (const s of studs) {
          const d = Math.hypot(s[0] - hit.point[0], s[2] - hit.point[2]);
          if (d < bd && Math.abs(s[1] - hit.point[1]) < 6) {
            bd = d;
            best = s;
          }
        }
        if (best) return [...best];
        return [snapLattice(hit.point[0]), snapPlate(hit.point[1]), snapLattice(hit.point[2])];
      }
      if (ny > 0.7) return null; // underside: nothing sensible to snap to
      // Side face: sit beside the part, level with its bottom.
      const info = await lib.partInfo(hit.part.file);
      const box = worldBox(info, hit.part.pos, hit.part.rot);
      const out = [hit.point[0] + nx * 10, 0, hit.point[2] + nz * 10];
      const axis = Math.abs(nx) >= Math.abs(nz) ? [Math.sign(nx), 0, 0] : [0, 0, Math.sign(nz)];
      this._side = { axis, box };
      return [snapLattice(out[0]), snapPlate(box.max[1]), snapLattice(out[2])];
    }
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, p)) return null;
    const l = this.stage.toLdraw(p);
    return [snapLattice(l[0]), 0, snapLattice(l[2])];
  }

  /** Point the ghost at the cursor; when placed beside a part, slide it out until it no longer overlaps. */
  async _aim() {
    const t = await this._snapTarget();
    const g = this.ghost;
    if (!g) return;
    g.target = t;
    if (t && this._side) {
      const { axis, box } = this._side;
      for (let i = 0; i < 16; i++) {
        const placed = this._ghostPlacements();
        if (!placed.some((p, k) => boxesOverlap(worldBox(g.infos[k], p.pos, p.rot), box, 2))) break;
        g.target = [g.target[0] + axis[0] * STUD, g.target[1], g.target[2] + axis[2] * STUD];
      }
    }
    this._updateGhost();
  }

  // ---------- input ----------

  _bindInput() {
    const c = this.stage.canvas;
    let down = null;
    c.addEventListener('pointerdown', e => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
    });
    c.addEventListener('pointermove', async e => {
      this._setPointer(e);
      if (this.ghost) {
        await this._aim();
      } else if (this.tool !== 'build') {
        const hit = this._pick();
        this.hoverId = hit?.part.id ?? null;
        c.style.cursor = hit ? (this.tool === 'paint' ? 'crosshair' : 'pointer') : 'default';
      }
    });
    c.addEventListener('pointerup', async e => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return; // that was an orbit drag
      this._setPointer(e);
      if (this.ghost) return this._dropGhost(e);
      const hit = this._pick();
      if (this.tool === 'paint') {
        if (hit) await this.paint([hit.part.id]);
        return;
      }
      if (!hit) {
        if (!e.shiftKey) this.select([]);
        return;
      }
      if (e.shiftKey || e.metaKey) {
        const s = new Set(this.selection);
        s.has(hit.part.id) ? s.delete(hit.part.id) : s.add(hit.part.id);
        this.select([...s]);
      } else this.select([hit.part.id]);
    });
    c.addEventListener('pointerleave', () => {
      if (this.ghost) this.ghost.group.visible = false;
    });
    c.addEventListener('contextmenu', e => e.preventDefault());
  }

  async _dropGhost(e) {
    const g = this.ghost;
    if (!g) return;
    await this._aim();
    if (!g.target) return;
    const placed = this._ghostPlacements();
    const step = this.stepCounter++;
    const newParts = placed.map(p => ({ id: newId(), file: p.file, color: p.color, pos: p.pos, rot: p.rot, step }));
    await this.commit(parts => parts.push(...newParts));
    if (g.keepIds) {
      // Moving existing parts: one drop, then back to select.
      this.cancelGhost();
      this.select(newParts.map(p => p.id));
    } else if (e?.altKey) {
      this.cancelGhost();
    } else {
      this._updateGhost(); // keep building with the same piece
    }
  }

  // ---------- tools ----------

  setTool(t) {
    this.tool = t;
    if (t !== 'build') this.cancelGhost();
    this.dispatchEvent(new Event('tool'));
  }

  select(ids) {
    this.selection = new Set(ids);
    this._updateOutline();
    this.dispatchEvent(new Event('select'));
  }

  selectAll() {
    this.select(this.model.parts.filter(p => !this.hidden.has(p.id)).map(p => p.id));
  }

  _updateOutline() {
    this.stage.outline.selectedObjects = [...this.selection].map(id => this.objects.get(id)).filter(Boolean);
  }

  selectedParts() {
    return this.model.parts.filter(p => this.selection.has(p.id));
  }

  async deleteSelection() {
    if (!this.selection.size) return;
    const ids = new Set(this.selection);
    this.selection.clear();
    await this.commit(parts => {
      for (let i = parts.length - 1; i >= 0; i--) if (ids.has(parts[i].id)) parts.splice(i, 1);
    });
  }

  async paint(ids, color = this.color) {
    const set = new Set(ids);
    await this.commit(parts => parts.forEach(p => set.has(p.id) && (p.color = color)));
  }

  /** Pick the selection up and carry it (move). */
  async moveSelection() {
    const sel = this.selectedParts().map(clonePart);
    if (!sel.length) return;
    await this.deleteSelection();
    this.tool = 'build';
    await this.carry(sel, { keepIds: true });
    this.dispatchEvent(new Event('tool'));
  }

  copy() {
    const sel = this.selectedParts().map(clonePart);
    if (sel.length) this.clipboard = sel;
    return sel.length;
  }

  async paste() {
    if (!this.clipboard) return;
    this.tool = 'build';
    await this.carry(this.clipboard.map(clonePart));
    this.dispatchEvent(new Event('tool'));
  }

  async duplicate() {
    if (this.copy()) await this.paste();
  }

  /** Rotate the selection in place about its footprint centre (quarter turns). */
  async rotateSelection(axis, n) {
    const sel = this.selectedParts();
    if (!sel.length) return;
    const q = quarterTurn(axis, n);
    const c = this._centre(sel);
    const ids = new Set(sel.map(p => p.id));
    await this.commit(parts =>
      parts.forEach(p => {
        if (!ids.has(p.id)) return;
        const d = apply3(q, [p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]]);
        p.pos = [d[0] + c[0], d[1] + c[1], d[2] + c[2]].map(v => Math.round(v * 1000) / 1000);
        p.rot = roundRot(mul3(q, p.rot));
      }),
    );
  }

  _centre(sel) {
    // Centre snapped so a quarter turn keeps studs on the lattice.
    const xs = sel.map(p => p.pos[0]);
    const zs = sel.map(p => p.pos[2]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    return [Math.round(cx / 10) * 10, 0, Math.round(cz / 10) * 10];
  }

  async nudge(dx, dy, dz) {
    const ids = new Set(this.selection);
    if (!ids.size) return;
    await this.commit(parts => parts.forEach(p => ids.has(p.id) && (p.pos = [p.pos[0] + dx, p.pos[1] + dy, p.pos[2] + dz])));
  }

  /** Mirror the arrangement left-right (parts keep their own shape). */
  async mirrorSelection() {
    const sel = this.selectedParts();
    if (!sel.length) return;
    const c = this._centre(sel);
    const S = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    const ids = new Set(sel.map(p => p.id));
    await this.commit(parts =>
      parts.forEach(p => {
        if (!ids.has(p.id)) return;
        p.pos = [2 * c[0] - p.pos[0], p.pos[1], p.pos[2]];
        p.rot = roundRot(mul3(mul3(S, p.rot), S));
      }),
    );
  }

  hideSelection() {
    for (const id of this.selection) this.hidden.add(id);
    this.select([]);
    this.sync();
    this.dispatchEvent(new Event('change'));
  }

  isolateSelection() {
    if (!this.selection.size) return;
    for (const p of this.model.parts) if (!this.selection.has(p.id)) this.hidden.add(p.id);
    this.sync();
    this.dispatchEvent(new Event('change'));
  }

  showAll() {
    this.hidden.clear();
    this.sync();
    this.dispatchEvent(new Event('change'));
  }

  // ---------- facts ----------

  async stats() {
    const parts = this.model.parts;
    const byColor = new Map();
    for (const p of parts) byColor.set(p.color, (byColor.get(p.color) || 0) + 1);
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const b = worldBox(await lib.partInfo(p.file), p.pos, p.rot);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], b.min[i]);
        max[i] = Math.max(max[i], b.max[i]);
      }
    }
    const size = parts.length ? [(max[0] - min[0]) / 20, (max[1] - min[1]) / 8, (max[2] - min[2]) / 20] : [0, 0, 0];
    return { count: parts.length, unique: new Set(parts.map(p => p.file.toLowerCase())).size, byColor, size };
  }
}
