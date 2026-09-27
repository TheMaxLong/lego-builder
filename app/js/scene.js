// Renderer, lights, camera, orbit controls and post-processing shared by the builder and the display table.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';

/**
 * PNG of a canvas. WKWebView sometimes hands toBlob a null (e.g. while the window is behind others),
 * so fall back to the synchronous data URL, which reads the preserved drawing buffer.
 */
export async function canvasToBlob(canvas) {
  const blob = await new Promise(ok => {
    const t = setTimeout(() => ok(null), 3000); // a hidden window can leave toBlob hanging
    canvas.toBlob(b => (clearTimeout(t), ok(b)), 'image/png');
  });
  if (blob) return blob;
  const url = canvas.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 100) throw new Error('the 3D view could not be captured');
  return new Blob([bytes], { type: 'image/png' });
}

export class Stage {
  constructor(canvas, { background = 0xdfe6ee } = {}) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    this.scene = scene;

    // LDraw has -Y up; this root flips it so everything inside uses raw LDraw units.
    this.root = new THREE.Group();
    this.root.rotation.x = Math.PI;
    this.root.scale.setScalar(0.1); // 1 stud = 2 world units
    scene.add(this.root);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8d7c6a, 0.9);
    scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(40, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 4;
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -60;
    sc.right = sc.top = 60;
    sc.near = 1;
    sc.far = 300;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;

    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 4000);
    camera.position.set(38, 34, 48);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 4;
    controls.maxDistance = 900;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls = controls;

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, 1, 1);
    this.ao.output = GTAOPass.OUTPUT.Default;
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1 });
    this.composer.addPass(this.ao);
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
    this.outline.edgeStrength = 4;
    this.outline.edgeThickness = 1.2;
    this.outline.visibleEdgeColor.set(0x1d8cff);
    this.outline.hiddenEdgeColor.set(0x0b4d99);
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());
    this.useAO = true;

    this.onFrame = [];
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop(t) {
    requestAnimationFrame(this._loop);
    if (this.paused) return;
    for (const f of this.onFrame) f(t);
    this.controls.update();
    this.render();
  }

  render() {
    if (this.useAO || this.outline.selectedObjects.length) {
      this.ao.enabled = this.useAO;
      this.composer.render();
    }
    else this.renderer.render(this.scene, this.camera);
  }

  /** LDraw coordinates -> world. */
  toWorld(v) {
    return this.root.localToWorld(new THREE.Vector3(v[0], v[1], v[2]));
  }

  /** World -> LDraw coordinates. */
  toLdraw(v) {
    const p = this.root.worldToLocal(v.clone());
    return [p.x, p.y, p.z];
  }

  /** Keep the shadow box around what's on screen. */
  fitShadows(box) {
    this.root.updateMatrixWorld(true);
    const size = box.getSize(new THREE.Vector3()).length() || 40;
    const c = box.getCenter(new THREE.Vector3());
    const half = Math.max(30, size * 0.7);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -half;
    sc.right = sc.top = half;
    sc.far = half * 6;
    sc.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(new THREE.Vector3(0.45, 1, 0.35).normalize().multiplyScalar(half * 2.5));
  }

  /** Frame the camera on a box, keeping the current viewing direction. */
  frame(box, { instant = false } = {}) {
    if (box.isEmpty()) return;
    this.root.updateMatrixWorld(true);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.25;
    const to = c.clone().add(dir.multiplyScalar(Math.max(dist, 12)));
    if (instant) {
      this.controls.target.copy(c);
      this.camera.position.copy(to);
      return;
    }
    const fromT = this.controls.target.clone();
    const fromP = this.camera.position.clone();
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 450);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(fromT, c, e);
      this.camera.position.lerpVectors(fromP, to, e);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** Render one frame at a given pixel size and return a PNG blob. */
  async snapshot(width, height) {
    const r = this.renderer;
    const oldSize = r.getSize(new THREE.Vector2());
    const oldRatio = r.getPixelRatio();
    this.paused = true;
    r.setPixelRatio(1);
    r.setSize(width, height, false);
    this.composer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
    const blob = await canvasToBlob(r.domElement);
    r.setPixelRatio(oldRatio);
    this.composer.setPixelRatio(oldRatio);
    r.setSize(oldSize.x, oldSize.y, false);
    this.composer.setSize(oldSize.x, oldSize.y);
    this.camera.aspect = oldSize.x / oldSize.y;
    this.camera.updateProjectionMatrix();
    this.paused = false;
    return blob;
  }
}
