// Small offscreen renderer for part and creation thumbnails, cached as PNGs on disk.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as platform from './platform.js';
import * as lib from './library.js';

const SIZE = 192;
let renderer, scene, camera, root, dir;
const have = new Set();
const pending = new Map();
let queue = Promise.resolve();

function setup() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 5000);
  root = new THREE.Group();
  root.rotation.x = Math.PI;
  scene.add(root);
}

/** Render any LDraw-space object to a PNG blob, framed from the front-left-above. */
export async function renderObject(obj, size = SIZE) {
  setup();
  renderer.setSize(size, size, false);
  root.add(obj);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const d = r / Math.sin((camera.fov * Math.PI) / 360) * 1.02;
  camera.position.copy(c).add(new THREE.Vector3(-0.62, 0.55, 0.9).normalize().multiplyScalar(d));
  camera.near = d / 50;
  camera.far = d * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(c);
  renderer.render(scene, camera);
  root.remove(obj);
  const blob = await new Promise(ok => renderer.domElement.toBlob(ok, 'image/png'));
  renderer.setSize(SIZE, SIZE, false);
  return blob;
}

export async function init() {
  const p = await platform.paths();
  dir = p.cache + '/thumbs';
  for (const e of await platform.listDir(dir)) have.add(e.name);
}

const THUMB_COLOR = 4;
const nameFor = file => file.toLowerCase().replace(/[\\/]/g, '_').replace(/\.dat$/, '') + '.png';

/** URL of a part thumbnail; renders + caches it the first time. */
export function partThumb(file) {
  const name = nameFor(file);
  if (have.has(name)) return Promise.resolve(platform.fileUrl(dir + '/' + name));
  if (pending.has(name)) return pending.get(name);
  const job = (queue = queue.then(async () => {
    const obj = await lib.partObject(file, THUMB_COLOR);
    const blob = await renderObject(obj);
    await platform.writeBytes(dir + '/' + name, await platform.blobToBytes(blob));
    have.add(name);
    return platform.fileUrl(dir + '/' + name) + '?v=1';
  }).catch(e => {
    console.warn('thumb failed', file, e);
    return null;
  }));
  pending.set(name, job);
  return job;
}
