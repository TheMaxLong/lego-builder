// The display table: a small room with a wooden table (and optional shelves) where saved
// creations are put out together. Displays save as JSON in ~/Documents/Lego Builder/Displays.

import * as THREE from 'three';
import { Stage } from './scene.js';
import { modelObject } from './models.js';
import * as store from './store.js';

const TABLE = { w: 280, d: 150, top: 0, thick: 5, legH: 80 };
const FLOOR_Y = -TABLE.legH - TABLE.thick;
const WALL_Z = -120;
const SHELVES = [34, 68]; // board heights above the table top
const SHELF = { w: 250, d: 30 };

function woodTexture(base = '#a8733f', dark = '#8a5a2e') {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  // planks + grain
  for (let p = 0; p < 4; p++) {
    const y0 = p * 128;
    g.fillStyle = p % 2 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    g.fillRect(0, y0, 512, 128);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = dark;
      g.globalAlpha = 0.12 + Math.random() * 0.18;
      g.lineWidth = 0.6 + Math.random() * 1.6;
      g.beginPath();
      const y = y0 + Math.random() * 128;
      g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / 60 + i) * 3 + (Math.random() - 0.5) * 2);
      g.stroke();
    }
    g.globalAlpha = 0.5;
    g.fillStyle = dark;
    g.fillRect(0, y0, 512, 1.5);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export class DisplayRoom {
  constructor(canvas) {
    this.stage = new Stage(canvas, { background: 0xcfc6bb });
    const s = this.stage;
    s.useAO = true;
    s.controls.maxPolarAngle = Math.PI * 0.49;
    s.controls.minDistance = 20;
    s.controls.maxDistance = 600;
    s.camera.position.set(130, 140, 240);
    s.controls.target.set(0, 12, -25);
    this.items = []; // { name, holder, rotY }
    this.selected = null;
    this.furniture = 'table';
    this.light = 'day';
    this._buildRoom();
    this.setLight('day');
    this._bindInput();
  }

  _buildRoom() {
    const scene = this.stage.scene;
    const room = new THREE.Group();
    this.room = room;
    scene.add(room);
    const wood = woodTexture();
    wood.repeat.set(2, 1);
    const tableMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.55, metalness: 0 });
    const floorTex = woodTexture('#7a5431', '#5b3c20');
    floorTex.repeat.set(6, 6);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.7 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e1d6, roughness: 0.95 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    floor.receiveShadow = true;
    room.add(floor);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(900, 400), wallMat);
    back.position.set(0, FLOOR_Y + 200, WALL_Z - 30);
    back.receiveShadow = true;
    room.add(back);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(900, 400), wallMat);
    side.rotation.y = Math.PI / 2;
    side.position.set(-320, FLOOR_Y + 200, 0);
    side.receiveShadow = true;
    room.add(side);

    // table
    this.table = new THREE.Group();
    const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.w, TABLE.thick, TABLE.d), tableMat);
    top.position.y = TABLE.top - TABLE.thick / 2;
    top.castShadow = top.receiveShadow = true;
    top.userData.surface = true;
    this.table.add(top);
    const legMat = tableMat.clone();
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(6, TABLE.legH, 6), legMat);
      leg.position.set(x * (TABLE.w / 2 - 8), TABLE.top - TABLE.thick - TABLE.legH / 2, z * (TABLE.d / 2 - 8));
      leg.castShadow = true;
      this.table.add(leg);
    }
    room.add(this.table);

    // wall shelves behind the table
    this.shelves = new THREE.Group();
    for (const h of SHELVES) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(SHELF.w, 3, SHELF.d), tableMat);
      board.position.set(0, TABLE.top + h - 1.5, WALL_Z - 30 + SHELF.d / 2);
      board.castShadow = board.receiveShadow = true;
      board.userData.surface = true;
      this.shelves.add(board);
      for (const x of [-1, 1]) {
        const br = new THREE.Mesh(new THREE.BoxGeometry(2, 8, SHELF.d - 4), legMat);
        br.position.set(x * (SHELF.w / 2 - 12), TABLE.top + h - 7, WALL_Z - 30 + SHELF.d / 2 - 2);
        this.shelves.add(br);
      }
    }
    room.add(this.shelves);

    // lights used by the evening/spot moods
    this.lamp = new THREE.PointLight(0xffb36b, 0, 500, 1.6);
    this.lamp.position.set(-120, 90, 40);
    this.lamp.castShadow = true;
    scene.add(this.lamp);
    this.spot = new THREE.SpotLight(0xfff4e0, 0, 600, 0.42, 0.45, 1.2);
    this.spot.position.set(40, 190, 90);
    this.spot.target.position.set(0, 0, 0);
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(2048, 2048);
    this.spot.shadow.bias = -0.0005;
    scene.add(this.spot, this.spot.target);
    this.setFurniture('table');
  }

  surfaces() {
    const out = [];
    this.table.traverse(o => o.userData.surface && o.visible && out.push(o));
    if (this.shelves.visible) this.shelves.traverse(o => o.userData.surface && out.push(o));
    return out;
  }

  setFurniture(kind) {
    this.furniture = kind;
    this.table.visible = kind !== 'shelves';
    this.shelves.visible = kind !== 'table';
  }

  setLight(mood) {
    this.light = mood;
    const s = this.stage;
    const presets = {
      day: { bg: 0xd8d2c8, hemi: 0.9, sun: 2.4, sunColor: 0xffffff, env: 0.55, lamp: 0, spot: 0, exposure: 1.0 },
      evening: { bg: 0x4a3a2e, hemi: 0.25, sun: 0.7, sunColor: 0xff9a55, env: 0.18, lamp: 26000, spot: 0, exposure: 1.05 },
      spot: { bg: 0x121212, hemi: 0.06, sun: 0, sunColor: 0xffffff, env: 0.08, lamp: 0, spot: 180000, exposure: 1.1 },
    }[mood];
    s.scene.background = new THREE.Color(presets.bg);
    s.hemi.intensity = presets.hemi;
    s.sun.intensity = presets.sun;
    s.sun.color.setHex(presets.sunColor);
    s.scene.environmentIntensity = presets.env;
    this.lamp.intensity = presets.lamp;
    this.spot.intensity = presets.spot;
    s.renderer.toneMappingExposure = presets.exposure;
    this._refit();
  }

  _refit() {
    const box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(0, 30, -40), new THREE.Vector3(320, 140, 230));
    this.stage.fitShadows(box);
  }

  /** Put a saved creation out. pos/rotY given when restoring a saved display. */
  async add(name, { pos = null, rotY = 0 } = {}) {
    const model = await store.readModel(`${store.folder('creations')}/${store.safeName(name)}.ldr`);
    const obj = await modelObject(model);
    // Centre the model on its footprint and stand it on y=0.
    obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    const inner = new THREE.Group();
    inner.rotation.x = Math.PI;
    inner.scale.setScalar(0.1);
    inner.add(obj);
    obj.position.set(-(b.min.x + b.max.x) / 2, -b.max.y, -(b.min.z + b.max.z) / 2);
    const holder = new THREE.Group();
    holder.add(inner);
    holder.userData.item = true;
    holder.rotation.y = rotY;
    this.stage.scene.add(holder);
    const item = { name, holder };
    this.items.push(item);
    holder.traverse(o => (o.userData.owner = item));
    if (pos) holder.position.fromArray(pos);
    else holder.position.copy(this._freeSpot(holder));
    this.select(item);
    return item;
  }

  _footprint(holder) {
    holder.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(holder);
  }

  _freeSpot(holder) {
    const size = this._footprint(holder).getSize(new THREE.Vector3());
    const others = this.items.filter(i => i.holder !== holder).map(i => this._footprint(i.holder));
    const onTable = this.table.visible;
    const y = onTable ? TABLE.top : TABLE.top + SHELVES[0];
    const zc = onTable ? 0 : WALL_Z - 30 + SHELF.d / 2;
    const halfW = (onTable ? TABLE.w : SHELF.w) / 2;
    const halfD = (onTable ? TABLE.d : SHELF.d) / 2;
    const overlap = box =>
      others.reduce((sum, o) => {
        const i = o.clone().intersect(box);
        return sum + (i.isEmpty() ? 0 : i.getSize(new THREE.Vector3()).x * i.getSize(new THREE.Vector3()).z);
      }, 0);
    // Scan a grid across the surface; take the free spot nearest the middle, else the least-crowded one.
    let best = null;
    for (let x = -halfW + size.x / 2; x <= halfW - size.x / 2 + 0.01; x += 6)
      for (let z = zc - halfD + size.z / 2; z <= zc + halfD - size.z / 2 + 0.01; z += 6) {
        const box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, y + size.y / 2, z), size);
        const score = overlap(box) * 1000 + Math.hypot(x, z - zc);
        if (!best || score < best.score) best = { score, p: new THREE.Vector3(x, y, z) };
      }
    return best ? best.p : new THREE.Vector3(0, y, zc);
  }

  select(item) {
    this.selected = item;
    this.stage.outline.selectedObjects = item ? [item.holder] : [];
  }

  removeSelected() {
    if (!this.selected) return;
    this.stage.scene.remove(this.selected.holder);
    this.items = this.items.filter(i => i !== this.selected);
    this.select(null);
  }

  clear() {
    for (const i of this.items) this.stage.scene.remove(i.holder);
    this.items = [];
    this.select(null);
  }

  turnSelected(n = 1) {
    if (this.selected) this.selected.holder.rotation.y += (n * Math.PI) / 2;
  }

  toJSON() {
    return {
      furniture: this.furniture,
      light: this.light,
      items: this.items.map(i => ({ name: i.name, pos: i.holder.position.toArray().map(v => Math.round(v * 100) / 100), rotY: i.holder.rotation.y })),
    };
  }

  async restore(data) {
    this.clear();
    this.setFurniture(data.furniture || 'table');
    this.setLight(data.light || 'day');
    const missing = [];
    for (const it of data.items || []) {
      try {
        await this.add(it.name, { pos: it.pos, rotY: it.rotY });
      } catch {
        missing.push(it.name);
      }
    }
    this.select(null);
    return missing;
  }

  _bindInput() {
    const c = this.stage.canvas;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const aim = e => {
      const r = c.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.stage.camera);
    };
    let drag = null;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      aim(e);
      const hit = ray.intersectObjects(this.items.map(i => i.holder), true).find(h => h.object.isMesh);
      if (hit) {
        const item = hit.object.userData.owner;
        this.select(item);
        drag = { item, moved: false };
        this.stage.controls.enabled = false;
        c.setPointerCapture(e.pointerId);
      } else {
        drag = { item: null, x: e.clientX, y: e.clientY };
      }
    });
    c.addEventListener('pointermove', e => {
      if (!drag?.item) return;
      aim(e);
      const hit = ray.intersectObjects(this.surfaces(), false)[0];
      if (!hit) return;
      drag.moved = true;
      drag.item.holder.position.set(hit.point.x, hit.object.position.y + (hit.object.geometry.parameters.height || 0) / 2, hit.point.z);
    });
    c.addEventListener('pointerup', e => {
      if (drag && !drag.item && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) this.select(null);
      drag = null;
      this.stage.controls.enabled = true;
    });
  }
}
