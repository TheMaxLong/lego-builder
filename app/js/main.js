// App shell: boots the library, wires every panel, button and key to the builder.

import * as platform from './platform.js';
import * as lib from './library.js';
import * as catalog from './catalog.js';
import * as thumbs from './thumbs.js';
import * as store from './store.js';
import * as sets from './sets.js';
import * as minifig from './minifig.js';
import * as media from './media.js';
import { Stage } from './scene.js';
import { Builder } from './builder.js';
import { DisplayRoom } from './display.js';
import { modelObject, missingParts } from './models.js';
import { mechanismFor, Spinner } from './spin.js';
import { parseLdr, flattenModel, newId, IDENTITY } from './ldr.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem('lego.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('lego.' + k, JSON.stringify(v));
    } catch {}
  },
};

let stage, builder, room;
const bootErrors = [];
addEventListener('error', e => bootErrors.push(String(e.message)));
addEventListener('unhandledrejection', e => bootErrors.push(String(e.reason?.message || e.reason)));
let busy = null; // running replay
let spinner = null; // running machines in the builder
const partTitle = file => catalog.byFile(file)?.title || '';

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function loading(text, progress = null) {
  $('#loading').hidden = text == null;
  if (text != null) $('#loading-text').textContent = text;
  const bar = $('#loading-bar');
  bar.hidden = progress == null;
  if (progress != null) bar.value = progress;
}

// ---------------- boot ----------------

async function ensureLibrary() {
  let s = await platform.libraryStatus();
  if (s.state === 'ready') return;
  await platform.downloadLibrary();
  for (;;) {
    s = await platform.libraryStatus();
    if (s.state === 'ready') return;
    if (s.state === 'error') throw new Error('Could not download the parts library: ' + s.error);
    if (s.state === 'downloading') loading(`Downloading the Lego parts library… ${(s.bytes / 1e6).toFixed(0)} of ${(s.total / 1e6).toFixed(0)} MB`, s.total ? s.bytes / s.total : null);
    else loading('Unpacking 37,000 parts…');
    await new Promise(r => setTimeout(r, 400));
  }
}

async function boot() {
  loading('Opening the brick box…');
  await ensureLibrary();
  await lib.init();
  await store.init();
  await thumbs.init();
  await catalog.load(lib.libraryDir(), (await platform.paths()).cache, msg => loading(msg));

  stage = new Stage($('#view'));
  builder = new Builder(stage);
  window.app = { lib, stage, builder, catalog, store };

  buildColorPanel();
  buildPartsDrawer();
  wireTopbar();
  wireSide();
  wireKeys();
  wireTabs();
  builder.addEventListener('change', onModelChange);
  builder.addEventListener('select', updateSelection);
  builder.addEventListener('tool', updateTool);
  builder.addEventListener('ghost', updateHint);

  const last = ls.get('lastCreation', null) || (await store.listCreations())[0]?.name;
  let opened = false;
  if (last) {
    try {
      await openCreation(last);
      opened = true;
    } catch {}
  }
  if (!opened) await newCreation('My first build');
  updateTool();
  updateSelection();
  loading(null);
  window.appReady = true;
  // Small health report next to the caches: proves a launch worked without anyone looking at the window.
  setTimeout(async () => {
    const p = await platform.paths();
    const report = {
      at: new Date().toISOString(),
      app: platform.isApp,
      catalogParts: catalog.parts.length,
      colors: lib.colors.length,
      creation: builder.model.name,
      modelParts: builder.model.parts.length,
      partsOnScreen: builder.objects.size,
      errors: bootErrors.slice(0, 20),
    };
    await platform.writeText(p.cache + '/last-boot.json', JSON.stringify(report, null, 1)).catch(() => {});
    if (await platform.readText(p.cache + '/selftest.flag')) selfTest(p);
  }, 4000);
}

/** Exercises the Mac-only bridges (binary writes, web fetch, video) when cache/selftest.flag exists. */
async function selfTest(p) {
  const r = {};
  const step = async (name, fn) => {
    try {
      r[name] = (await fn()) ?? 'ok';
    } catch (e) {
      r[name] = 'FAIL: ' + (e.message || e);
    }
  };
  await platform.removeFile(p.cache + '/selftest.flag');
  await step('thumbnail_write', async () => {
    const url = await thumbs.partThumb('3001.dat');
    const ok = url && (await fetch(url)).ok;
    return ok ? 'ok' : 'FAIL: thumbnail not readable';
  });
  await step('web_fetch', async () => {
    const html = await platform.httpGet('https://library.ldraw.org/omr/sets?page=1');
    return html.includes('omr/sets/') ? 'ok' : 'FAIL: unexpected page';
  });
  await step('carry_and_place', async () => {
    await builder.carryPart('3003.dat');
    builder._setPointer({ clientX: innerWidth / 2 + 150, clientY: innerHeight / 2 });
    const before = builder.model.parts.length;
    await builder._dropGhost({ altKey: true });
    const placed = builder.model.parts.length - before;
    await builder.undo();
    return placed === 1 && builder.model.parts.length === before ? 'ok' : `FAIL: placed ${placed}, after undo ${builder.model.parts.length}`;
  });
  await step('video', async () => (await platform.hasFfmpeg() ? media.turntable(stage, 'selftest', { seconds: 1, fps: 4, width: 320, height: 200, outDir: p.cache + '/selftest' }).then(async v => {
            await platform.removeFile(v);
            await platform.removeFile(p.cache + '/selftest');
            const left = (await platform.listDir(p.cache)).filter(e => e.name.startsWith('frames-'));
            return left.length ? 'FAIL: temp frames left behind' : 'ok (video made, temp frames cleaned)';
          }) : 'skipped: no ffmpeg'));
  await platform.writeText(p.cache + '/last-selftest.json', JSON.stringify({ at: new Date().toISOString(), ...r }, null, 1));
}

// ---------------- creations: new / open / save ----------------

let saving = Promise.resolve();
const autosave = debounce(() => save(), 700);
const refreshThumb = debounce(async () => {
  if (!builder.model.parts.length) return;
  const blob = await thumbs.renderObject(await modelObject(builder.model), 256);
  await store.saveThumb('creation', builder.model.name, blob);
}, 4000);

function save({ forceHistory = false } = {}) {
  saving = saving.then(async () => {
    $('#save-state').textContent = 'Saving…';
    try {
      await store.saveCreation(builder.model, { forceHistory });
      $('#save-state').textContent = 'Saved';
      ls.set('lastCreation', builder.model.name);
      refreshThumb();
    } catch (e) {
      $('#save-state').textContent = 'Not saved!';
      toast('Could not save: ' + e.message, 6000);
    }
  });
  return saving;
}

async function newCreation(base = 'Untitled', parts = null) {
  const name = await store.uniqueName(base);
  const start = parts || [{ id: newId(), file: '3867.dat', color: 2, pos: [0, 0, 0], rot: [...IDENTITY], step: 0 }];
  await builder.load({ name, parts: start, submodels: [] });
  $('#model-name').value = name;
  await save({ forceHistory: true });
}

async function openCreation(name) {
  const m = await store.readModel(`${store.folder('creations')}/${store.safeName(name)}.ldr`);
  await openModel(m);
}

async function openModel(m) {
  for (const s of m.submodels || []) lib.registerInline(s.file, s.text);
  const missing = missingParts(m);
  await builder.load(m);
  $('#model-name').value = m.name;
  $('#save-state').textContent = 'Saved';
  ls.set('lastCreation', m.name);
  if (missing.length) toast(`${missing.length} part type(s) not in the library were skipped: ${missing.slice(0, 3).join(', ')}…`, 7000);
}

async function renameTo(raw) {
  const name = store.safeName(raw);
  const old = builder.model.name;
  if (!name || name === old) return ($('#model-name').value = old);
  const taken = (await store.listCreations()).some(c => c.name.toLowerCase() === name.toLowerCase());
  if (taken) {
    toast(`There is already a creation called “${name}”.`);
    $('#model-name').value = old;
    return;
  }
  builder.model.name = name;
  await save({ forceHistory: true });
  await store.trashCreation(old).catch(() => {});
  toast(`Renamed to “${name}”`);
}

async function setRunning(on) {
  spinner?.stop();
  spinner = null;
  const btn = $('[data-act="run"]');
  btn.classList.toggle('on', on);
  btn.textContent = on ? '■ Stop' : '▶ Run';
  if (!on) return;
  builder.cancelGhost();
  const { entries, report } = await mechanismFor(builder.model.parts, builder.objects, lib.partInfo, partTitle);
  if (!entries.length) {
    btn.classList.remove('on');
    btn.textContent = '▶ Run';
    return toast(report.gears ? 'Nothing is driving the gears — select a gear or axle and press Motor.' : 'No machines here yet — try the Workshop presets, or add Technic gears and a motor.', 6000);
  }
  spinner = new Spinner(stage, entries);
  const turning = report.shafts.filter(s => s.omega).length;
  toast(`${turning} shaft${turning === 1 ? '' : 's'} turning · ${report.meshes.length} gear mesh${report.meshes.length === 1 ? '' : 'es'}`);
}

function onModelChange() {
  if (spinner) setRunning(false);
  $('#save-state').textContent = 'Editing…';
  autosave();
  updateStats();
  updateSelection();
  $('#show-all').hidden = !builder.hidden.size;
}

// ---------------- dialogs ----------------

function dialog(title, bodyHtml, buttons = []) {
  const d = $('#dlg');
  d.innerHTML = `<div class="dh"><span>${esc(title)}</span><button data-x aria-label="Close">✕</button></div><div class="db">${bodyHtml}</div>${
    buttons.length ? `<div class="df">${buttons.map((b, i) => `<button data-b="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div>` : ''
  }`;
  d.querySelector('[data-x]').onclick = () => d.close();
  buttons.forEach((b, i) => (d.querySelector(`[data-b="${i}"]`).onclick = () => b.onClick?.(d)));
  d.showModal();
  return d;
}

/** In-app name box (the Mac app's web view has no native prompt dialog). */
function askName(title, value) {
  return new Promise(resolve => {
    const d = dialog(title, `<input id="ask-name" value="${esc(value)}" spellcheck="false" aria-label="Name">`, [
      { label: 'Cancel', onClick: dd => (dd.close(), resolve(null)) },
      { label: 'Save', cls: 'accent', onClick: dd => (dd.close(), resolve(dd.querySelector('#ask-name').value.trim() || null)) },
    ]);
    const input = d.querySelector('#ask-name');
    input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        d.close();
        resolve(input.value.trim() || null);
      }
    });
    d.addEventListener('close', () => resolve(null), { once: true });
  });
}

async function openDialog() {
  const list = await store.listCreations();
  const rows = list
    .map(
      c => `<div class="file-row" data-open="${esc(c.name)}"><img src="${store.thumbUrl('creation', c.name, c.modified)}" alt="" onerror="this.style.visibility='hidden'"><div class="t"><b>${esc(c.name)}</b><br><small>${new Date(c.modified).toLocaleString()}</small></div><button data-versions="${esc(c.name)}">Versions</button><button data-trash="${esc(c.name)}" class="danger">Delete</button></div>`,
    )
    .join('');
  const d = dialog('Open a creation', `${rows || '<p class="muted">Nothing saved yet.</p>'}<label class="file-row" style="justify-content:center"><input type="file" id="import-file" accept=".ldr,.mpd,.dat" hidden>Import an .ldr / .mpd file…</label>`);
  d.querySelectorAll('[data-open]').forEach(el =>
    el.addEventListener('click', async e => {
      if (e.target.closest('button')) return;
      d.close();
      await openCreation(el.dataset.open);
    }),
  );
  d.querySelectorAll('[data-trash]').forEach(el =>
    el.addEventListener('click', async () => {
      const n = el.dataset.trash;
      await store.trashCreation(n);
      toast(`“${n}” moved to the .trash folder`);
      if (n === builder.model.name) await newCreation();
      d.close();
      openDialog();
    }),
  );
  d.querySelectorAll('[data-versions]').forEach(el => el.addEventListener('click', () => versionsDialog(el.dataset.versions)));
  d.querySelector('#import-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    d.close();
    const m = flattenModel(parseLdr(await f.text(), f.name.replace(/\.\w+$/, '')));
    m.name = await store.uniqueName(f.name.replace(/\.\w+$/, ''));
    await openModel(m);
    await save({ forceHistory: true });
    toast(`Imported ${m.parts.length} parts`);
  });
}

async function versionsDialog(name) {
  const hist = await store.listHistory(name);
  const rows = hist.map((h, i) => `<div class="file-row" data-v="${i}"><div class="t"><b>${new Date(h.when).toLocaleString()}</b></div><button>Restore</button></div>`).join('');
  const d = dialog(`Versions of “${name}”`, rows || '<p class="muted">No versions yet.</p>');
  d.querySelectorAll('[data-v]').forEach(el =>
    el.addEventListener('click', async () => {
      const h = hist[Number(el.dataset.v)];
      const m = await store.readModel(h.file);
      m.name = name;
      d.close();
      await builder.load(m);
      $('#model-name').value = name;
      await save({ forceHistory: true });
      toast('Restored the version from ' + new Date(h.when).toLocaleString());
    }),
  );
}

// ---------------- parts drawer ----------------

let chip = null;
const thumbObserver = new IntersectionObserver(
  entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const tile = en.target;
      thumbObserver.unobserve(tile);
      thumbs.partThumb(tile.dataset.file).then(url => {
        if (!url) return;
        const img = new Image();
        img.alt = '';
        img.src = url;
        img.onload = () => tile.querySelector('.ph')?.replaceWith(img);
      });
    }
  },
  { root: null, rootMargin: '200px' },
);

function partTile(p) {
  const el = document.createElement('button');
  el.className = 'tile';
  el.dataset.file = p.file;
  el.title = `${p.title} (${p.file.replace(/\.dat$/, '')})`;
  el.innerHTML = `<div class="ph"></div><span>${esc(p.title)}</span>`;
  el.addEventListener('click', () => pickPart(p.file));
  thumbObserver.observe(el);
  return el;
}

async function pickPart(file) {
  const recent = [file, ...ls.get('recent', []).filter(f => f !== file)].slice(0, 12);
  ls.set('recent', recent);
  renderRecent();
  await builder.carryPart(file);
  $('#view').focus();
}

function renderRecent() {
  const box = $('#recent');
  box.innerHTML = '';
  for (const f of ls.get('recent', [])) {
    const p = catalog.byFile(f);
    if (p) box.appendChild(partTile(p));
  }
}

function renderParts() {
  const q = $('#part-search').value;
  const printed = !!q || chip === 'Minifig';
  const { total, items } = catalog.find({ query: q, chip, printed, limit: 240 });
  const grid = $('#part-grid');
  grid.innerHTML = '';
  for (const p of items) grid.appendChild(partTile(p));
  $('#part-count').textContent = total > items.length ? `Showing ${items.length} of ${total.toLocaleString()} — search to narrow down` : `${total.toLocaleString()} parts`;
  $('#recent-wrap').hidden = !!q || !!chip;
}

function buildPartsDrawer() {
  const chips = $('#categories');
  const all = document.createElement('button');
  all.textContent = 'Popular';
  all.className = 'on';
  chips.appendChild(all);
  for (const [name] of [...catalog.CHIPS, ['Other']]) {
    const b = document.createElement('button');
    b.textContent = name;
    chips.appendChild(b);
  }
  chips.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    chips.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    chip = b === all ? null : b.textContent;
    renderParts();
  });
  $('#part-search').addEventListener('input', debounce(renderParts, 150));
  $('#part-search').placeholder = `Search ${catalog.parts.length.toLocaleString()} parts… (e.g. 2x4, slope, door)`;
  renderRecent();
  renderParts();
}

// ---------------- colors ----------------

const KINDS = [
  ['solid', 'Solid'],
  ['trans', 'See-through'],
  ['metal', 'Metal'],
  ['pearl', 'Pearl'],
  ['glow', 'Glow'],
  ['other', 'Other'],
];
const kindOf = c => (c.kind === 'chrome' ? 'metal' : ['solid', 'trans', 'metal', 'pearl', 'glow'].includes(c.kind) ? c.kind : 'other');
let colorKind = 'solid';
let showAllColors = false;
// The everyday Lego palette, in a pleasant order: neutrals, reds/oranges/yellows, greens, blues, purples/pinks, browns/tans.
const COMMON = [15, 71, 72, 0, 4, 320, 25, 191, 14, 18, 2, 10, 288, 27, 326, 378, 1, 73, 322, 272, 321, 379, 212, 5, 13, 26, 85, 22, 6, 70, 308, 19, 28, 84, 92, 450];

function buildColorPanel() {
  const kinds = $('#color-kinds');
  for (const [k, label] of KINDS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.kind = k;
    kinds.appendChild(b);
  }
  kinds.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    colorKind = b.dataset.kind;
    renderSwatches();
  });
  setColor(ls.get('color', 4), { quiet: true });
}

function renderSwatches() {
  $$('#color-kinds button').forEach(b => b.classList.toggle('on', b.dataset.kind === colorKind));
  const box = $('#colors');
  box.innerHTML = '';
  const all = lib.colors.filter(c => kindOf(c) === colorKind && c.code !== 16 && c.code !== 24);
  const common = colorKind === 'solid' ? COMMON.map(code => all.find(c => c.code === code)).filter(Boolean) : all;
  const shown = colorKind === 'solid' && !showAllColors ? common : all;
  for (const c of shown) {
    const b = document.createElement('button');
    b.className = `swatch ${c.kind}` + (c.code === builder.color ? ' on' : '');
    b.style.backgroundColor = c.hex;
    b.style.color = c.hex;
    b.title = `${c.name} (${c.code})`;
    b.setAttribute('aria-label', c.name);
    b.addEventListener('click', () => setColor(c.code));
    box.appendChild(b);
  }
  if (colorKind === 'solid') {
    const more = document.createElement('button');
    more.className = 'more-colors';
    more.textContent = showAllColors ? 'Fewer' : `+${all.length - common.length}`;
    more.title = showAllColors ? 'Show the common colours only' : 'Show every solid colour';
    more.addEventListener('click', () => {
      showAllColors = !showAllColors;
      renderSwatches();
    });
    box.appendChild(more);
  }
}

async function setColor(code, { quiet = false } = {}) {
  const c = lib.colorByCode.get(code) || lib.colorByCode.get(4);
  builder.color = c.code;
  ls.set('color', c.code);
  $('#color-current .swatch').style.backgroundColor = c.hex;
  $('#color-current .name').textContent = c.name;
  colorKind = kindOf(c);
  renderSwatches();
  if (quiet) return;
  // Re-colour the piece in hand when it is a single fresh part from the drawer.
  const g = builder.ghost;
  if (g && !g.keepIds && g.items.length === 1 && builder.lastPart === g.items[0].file) await builder.carryPart(g.items[0].file);
  if (builder.tool === 'select' && builder.selection.size && !builder.ghost) {
    /* colour applies on "Paint" button, never silently */
  }
}

// ---------------- side panel ----------------

function colorName(code) {
  return lib.colorByCode.get(Number(code))?.name || `colour ${code}`;
}

function updateSelection() {
  const sel = builder.selectedParts();
  const info = $('#selection-info');
  if (!sel.length) info.textContent = builder.ghost ? 'Holding a piece — click to place' : 'Nothing selected';
  else if (sel.length === 1) {
    const p = sel[0];
    info.innerHTML = `<b>${esc(catalog.byFile(p.file)?.title || p.file)}</b><br>${esc(colorName(p.color))} · ${esc(p.file.replace(/\.dat$/i, ''))}${p.motor ? ` · <b>motor ${p.motor} rpm</b>` : ''}`;
  } else info.textContent = `${sel.length} parts selected`;
  $$('#selection-actions button').forEach(b => (b.disabled = !sel.length));
}

const updateStats = debounce(async () => {
  const s = await builder.stats();
  const colors = [...s.byColor.entries()].sort((a, b) => b[1] - a[1]);
  $('#stats').innerHTML =
    `<b>${s.count}</b> pieces · <b>${s.unique}</b> kinds<br>` +
    `<b>${Math.round(s.size[0])}</b> × <b>${Math.round(s.size[2])}</b> studs, <b>${(s.size[1] / 3).toFixed(1)}</b> bricks tall<br>` +
    `<div class="swatches" style="grid-template-columns:repeat(auto-fill,minmax(18px,1fr))">${colors
      .slice(0, 24)
      .map(([c, n]) => `<span class="swatch" title="${esc(colorName(c))}: ${n}" style="background:${lib.colorByCode.get(Number(c))?.hex || '#888'}"></span>`)
      .join('')}</div>`;
}, 300);

function updateTool() {
  $$('#tool-group button').forEach(b => b.classList.toggle('on', b.dataset.tool === builder.tool));
  updateHint();
}

function updateHint() {
  const h = $('#hint');
  if (builder.ghost) h.textContent = 'Click to place · R turn · T/Y tip · ⌥click place & stop · Esc put down';
  else if (builder.tool === 'build') h.textContent = 'Pick a part or preset on the left · drag to spin, scroll to zoom';
  else if (builder.tool === 'select') h.textContent = 'Click parts to select (⇧ to add) · G move · R turn · ⌫ delete';
  else h.textContent = `Click parts to paint them ${colorName(builder.color)}`;
  updateSelection();
}

function setEdges(on) {
  builder.showEdges = on;
  stage.root.traverse(o => o.isLineSegments && (o.visible = on));
}

function wireSide() {
  $('#side').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    await act(b.dataset.act);
  });
  $('#opt-edges').addEventListener('change', e => setEdges(e.target.checked));
  $('#opt-ao').addEventListener('change', e => (stage.useAO = e.target.checked));
}

// ---------------- actions ----------------

async function act(a) {
  const B = builder;
  switch (a) {
    case 'new':
      return newCreation();
    case 'open':
      return openDialog();
    case 'save':
      await save({ forceHistory: true });
      return toast(`Saved “${B.model.name}”`);
    case 'undo':
      return B.undo();
    case 'redo':
      return B.redo();
    case 'move':
      return B.moveSelection();
    case 'rotate':
      return B.ghost ? B.rotateGhost('y', 1) : B.rotateSelection('y', 1);
    case 'mirror':
      return B.mirrorSelection();
    case 'duplicate':
      return B.duplicate();
    case 'paint-sel':
      return B.paint([...B.selection]);
    case 'hide':
      return B.hideSelection();
    case 'isolate':
      return B.isolateSelection();
    case 'show-all':
      return B.showAll();
    case 'delete':
      return B.deleteSelection();
    case 'frame':
      return B.frameAll();
    case 'save-group': {
      const sel = B.selectedParts();
      if (!sel.length) return;
      const name = await askName('Name this piece', 'My piece');
      if (!name) return;
      const n = await store.savePiece(name, sel);
      toast(`Saved “${n}” to My pieces (Presets tab)`);
      return renderPresets();
    }
    case 'screenshot': {
      const path = await media.picture(stage, B.model.name);
      toast('Picture saved to Pictures');
      return platform.reveal(path);
    }
    case 'turntable':
      return runTurntable(stage, B.model.name);
    case 'replay':
      if (busy) return busy.stop();
      B.cancelGhost();
      busy = media.replay(B);
      $('[data-act="replay"]').textContent = 'Stop';
      await busy.done;
      busy = null;
      $('[data-act="replay"]').textContent = 'Replay';
      return;
    case 'display':
      return openDisplay();
    case 'run':
      return setRunning(!spinner);
    case 'motor': {
      const sel = B.selectedParts();
      if (!sel.length) return;
      const on = !sel.some(p => p.motor);
      const ids = new Set(sel.map(p => p.id));
      await B.commit(parts => parts.forEach(p => ids.has(p.id) && (on ? (p.motor = 12) : delete p.motor)));
      return toast(on ? 'Motor on — press ▶ Run to see it go' : 'Motor removed');
    }
  }
}

async function runTurntable(st, name) {
  try {
    loading('Filming the turntable…', 0);
    const path = await media.turntable(st, name, { onProgress: (i, n) => loading(`Filming the turntable… frame ${i} of ${n}`, i / n) });
    loading(null);
    toast('Turntable video saved to Pictures');
    platform.reveal(path);
  } catch (e) {
    loading(null);
    toast(e.message, 6000);
  }
}

function wireTopbar() {
  $('#topbar').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) builder.setTool(b.dataset.tool);
    if (b.dataset.act) act(b.dataset.act);
  });
  const name = $('#model-name');
  name.addEventListener('change', () => renameTo(name.value));
  name.addEventListener('keydown', e => e.key === 'Enter' && name.blur());
}

function wireKeys() {
  window.addEventListener('keydown', async e => {
    if (!$('#display').hidden) return displayKey(e);
    const t = e.target;
    if (t.matches('input, select, textarea') || $('#dlg').open) return;
    const B = builder;
    const cmd = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (cmd && k === 'z') await (e.shiftKey ? B.redo() : B.undo());
    else if (cmd && k === 's') act('save');
    else if (cmd && k === 'o') act('open');
    else if (cmd && k === 'n') act('new');
    else if (cmd && k === 'c') B.copy() && toast('Copied');
    else if (cmd && k === 'v') B.paste();
    else if (cmd && k === 'd') B.duplicate();
    else if (cmd && k === 'a') B.selectAll();
    else if (cmd) handled = false;
    else if (k === ' ') act('run');
    else if (k === 'escape') {
      if (busy) busy.stop();
      else if (B.ghost) B.cancelGhost(), updateHint();
      else B.select([]);
    } else if (k === 'r') B.ghost ? B.rotateGhost('y', e.shiftKey ? -1 : 1) : B.rotateSelection('y', e.shiftKey ? -1 : 1);
    else if (k === 't') B.ghost ? B.rotateGhost('x', 1) : B.rotateSelection('x', 1);
    else if (k === 'y') B.ghost ? B.rotateGhost('z', 1) : B.rotateSelection('z', 1);
    else if (k === 'g') B.moveSelection();
    else if (k === 'x') B.mirrorSelection();
    else if (k === 'h') e.shiftKey ? B.showAll() : B.hideSelection();
    else if (k === 'i') B.isolateSelection();
    else if (k === 'f') B.frameAll();
    else if (k === 'delete' || k === 'backspace') B.deleteSelection();
    else if (k === '1') B.setTool('build');
    else if (k === '2') B.setTool('select');
    else if (k === '3') B.setTool('paint');
    else if (k === 'arrowleft') B.nudge(-20, 0, 0);
    else if (k === 'arrowright') B.nudge(20, 0, 0);
    else if (k === 'arrowup') B.nudge(0, 0, -20);
    else if (k === 'arrowdown') B.nudge(0, 0, 20);
    else if (k === 'q') B.nudge(0, -8, 0);
    else if (k === 'e') B.nudge(0, 8, 0);
    else handled = false;
    if (handled) e.preventDefault();
  });
}

// ---------------- tabs: presets / sets / minifig ----------------

function wireTabs() {
  $('#drawer .tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    $$('#drawer .tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('#drawer .pane').forEach(p => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
    if (b.dataset.tab === 'presets') renderPresets();
    if (b.dataset.tab === 'sets') renderSets();
    if (b.dataset.tab === 'minifig') renderMinifig();
  });
}

const presetThumbCache = new Map();
async function presetThumb(key, getModel) {
  if (!presetThumbCache.has(key)) {
    presetThumbCache.set(
      key,
      (async () => URL.createObjectURL(await thumbs.renderObject(await modelObject(await getModel()), 200)))().catch(() => null),
    );
  }
  return presetThumbCache.get(key);
}

let presetIndex = null;
async function loadPresetModel(file) {
  return parseLdr(await (await fetch('presets/' + file)).text());
}

function presetTile(key, title, desc, getModel, { onOpen } = {}) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.title = desc || title;
  el.innerHTML = `<div class="ph"></div><span>${esc(title)}</span><div class="row"><button data-place>Place</button>${onOpen ? '<button data-openp>Open</button>' : ''}</div>`;
  presetThumb(key, getModel).then(url => {
    if (!url) return;
    const img = new Image();
    img.src = url;
    img.alt = '';
    el.querySelector('.ph').replaceWith(img);
  });
  el.querySelector('[data-place]').addEventListener('click', async () => {
    const m = flattenModel(await getModel());
    builder.setTool('build');
    await builder.carry(m.parts);
    toast(`Holding “${title}” — click to place it, R to turn`);
    $('#view').focus();
  });
  el.querySelector('[data-openp]')?.addEventListener('click', onOpen);
  return el;
}

async function renderPresets() {
  const box = $('#preset-list');
  if (!presetIndex) presetIndex = await (await fetch('presets/index.json')).json();
  box.innerHTML = '';
  const addCat = (name, blurb, tiles) => {
    const cat = document.createElement('div');
    cat.className = 'preset-cat';
    cat.innerHTML = `<h4>${esc(name)} <span class="muted" style="font-weight:400">${esc(blurb || '')}</span></h4><div class="grid"></div>`;
    tiles.forEach(t => cat.querySelector('.grid').appendChild(t));
    box.appendChild(cat);
  };
  const pieces = await store.listPieces();
  if (pieces.length)
    addCat(
      'My pieces',
      'saved with “Save as piece”',
      pieces.map(p => presetTile('piece:' + p.name + p.modified, p.name, '', () => store.readModel(p.file))),
    );
  for (const c of presetIndex)
    addCat(
      c.name,
      c.blurb,
      c.items.map(it =>
        presetTile('preset:' + it.file, it.title, `${it.desc} · ${it.parts} pieces`, () => loadPresetModel(it.file), {
          onOpen: async () => newCreation(it.title, flattenModel(await loadPresetModel(it.file)).parts),
        }),
      ),
    );
  const mine = (await store.listCreations()).filter(c => c.name !== builder.model.name);
  if (mine.length)
    addCat(
      'My creations',
      'drop one creation into another',
      mine.slice(0, 30).map(c => presetTile('creation:' + c.name + c.modified, c.name, '', () => store.readModel(c.file))),
    );
}

let setsTheme = '';
async function renderSets() {
  const box = $('#sets');
  let idx = null;
  try {
    idx = await sets.loadIndex(null, { refresh: false }).catch(() => null);
  } catch {}
  if (!idx) {
    box.innerHTML = `<p>Browse <b>1,470 official Lego sets</b> from the LDraw Official Model Repository, and open any of them as a model you can build on.</p><button id="sets-load" class="accent">Load the set list</button><p class="muted">Needs the internet once; the list is kept afterwards.</p>`;
    box.querySelector('#sets-load').onclick = async () => {
      box.innerHTML = '<p>Fetching the set list…</p><progress max="1" value="0"></progress>';
      try {
        await sets.loadIndex((i, n) => {
          box.querySelector('p').textContent = `Fetching the set list… page ${i} of ${n}`;
          box.querySelector('progress').value = i / n;
        });
        renderSets();
      } catch (e) {
        box.innerHTML = `<p>Could not reach the set list: ${esc(e.message)}</p><button id="sets-retry">Try again</button>`;
        box.querySelector('#sets-retry').onclick = renderSets;
      }
    };
    return;
  }
  box.innerHTML = `<input type="search" id="sets-q" placeholder="Search ${idx.length.toLocaleString()} sets (name, number, year)…"><select id="sets-theme"><option value="">All themes</option>${sets
    .themes()
    .map(t => `<option ${t.name === setsTheme ? 'selected' : ''} value="${esc(t.name)}">${esc(t.name)} (${t.n})</option>`)
    .join('')}</select><div id="sets-list" style="display:grid;gap:6px"></div>`;
  const draw = () => {
    const res = sets.search($('#sets-q').value, setsTheme);
    $('#sets-list').innerHTML =
      res
        .slice(0, 150)
        .map(
          s => `<div class="set-row"><div class="t"><b title="${esc(s.name)}">${esc(s.name)}</b><small>${esc(s.num)} · ${esc(s.theme)} · ${s.year || ''}</small></div><button data-set="${esc(s.id)}">Open</button></div>`,
        )
        .join('') + (res.length > 150 ? `<p class="muted">${res.length - 150} more — search to narrow down</p>` : '');
  };
  $('#sets-q').addEventListener('input', debounce(draw, 150));
  $('#sets-theme').addEventListener('change', e => {
    setsTheme = e.target.value;
    draw();
  });
  $('#sets-list').addEventListener('click', async e => {
    const b = e.target.closest('button[data-set]');
    if (!b) return;
    const s = idx.find(x => x.id === b.dataset.set);
    b.disabled = true;
    b.textContent = 'Getting…';
    try {
      const files = await sets.modelFiles(s);
      if (!files.length) throw new Error('no model file on the set page');
      const m = flattenModel(await sets.fetchModel(s, files[0]));
      m.name = await store.uniqueName(`${s.num} ${s.name}`);
      await openModel(m);
      await save({ forceHistory: true });
      toast(`Opened ${s.name} — ${m.parts.length} pieces, saved as your own copy`);
    } catch (err) {
      toast('Could not open that set: ' + err.message, 6000);
    } finally {
      b.disabled = false;
      b.textContent = 'Open';
    }
  });
  draw();
}

let fig = null;
async function renderMinifig() {
  const box = $('#minifig');
  if (box.dataset.ready) return;
  box.dataset.ready = '1';
  fig = ls.get('minifig', null) || structuredClone(minifig.DEFAULTS);
  const colorOptions = sel =>
    lib.colors
      .filter(c => c.code !== 16 && c.code !== 24)
      .map(c => `<option value="${c.code}" ${c.code === sel ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('');
  let html = '<div id="mf-preview" role="img" aria-label="Minifigure preview"></div>';
  for (const [slot, def] of Object.entries(minifig.SLOTS)) {
    const opts = minifig.options(slot);
    html += `<div class="mf-slot"><label for="mf-${slot}">${def.label}</label><select id="mf-${slot}" data-slot="${slot}">${def.optional ? '<option value="">None</option>' : ''}${slot === 'legs' ? '<option value="plain">Plain legs</option>' : ''}${opts
      .map(p => `<option value="${esc(p.file)}">${esc(p.title.replace(/^Minifig /, ''))}</option>`)
      .join('')}</select><span></span><select data-color="${slot}" aria-label="${def.label} colour">${colorOptions(fig[slot]?.color)}</select></div>`;
  }
  html += `<div class="actions"><button id="mf-random">Surprise me</button><button id="mf-place" class="accent">Place in build</button></div><p class="muted">${minifig
    .options('torso')
    .length.toLocaleString()} torsos, ${minifig.options('head').length.toLocaleString()} heads, ${minifig.options('hat').length.toLocaleString()} hats and hair.</p>`;
  box.innerHTML = html;
  const sync = () => {
    for (const slot of Object.keys(minifig.SLOTS)) {
      box.querySelector(`[data-slot="${slot}"]`).value = fig[slot]?.file || '';
      box.querySelector(`[data-color="${slot}"]`).value = String(fig[slot]?.color ?? 0);
    }
  };
  const redraw = debounce(async () => {
    ls.set('minifig', fig);
    const blob = await minifig.preview(fig);
    let img = $('#mf-preview');
    if (img.tagName !== 'IMG') {
      const fresh = new Image();
      fresh.id = 'mf-preview';
      fresh.alt = 'Minifigure preview';
      img.replaceWith(fresh);
      img = fresh;
    } else URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
  }, 120);
  box.addEventListener('change', e => {
    const s = e.target.dataset.slot;
    const c = e.target.dataset.color;
    if (s) fig[s] = { ...(fig[s] || {}), file: e.target.value };
    if (c) fig[c] = { ...(fig[c] || { file: '' }), color: Number(e.target.value) };
    redraw();
  });
  box.querySelector('#mf-random').onclick = () => {
    fig = minifig.random(lib.colors);
    sync();
    redraw();
  };
  box.querySelector('#mf-place').onclick = async () => {
    builder.setTool('build');
    await builder.carry(minifig.assemble(fig), { grab: minifig.GRAB });
    toast('Holding your minifig — click a stud to stand it there');
    $('#view').focus();
  };
  sync();
  redraw();
}

// ---------------- display table ----------------

async function openDisplay() {
  builder.cancelGhost();
  await save();
  $('#display').hidden = false;
  stage.paused = true;
  if (!room) {
    room = new DisplayRoom($('#display-view'), { info: lib.partInfo, title: partTitle });
    window.app.room = room;
    wireDisplay();
    const last = ls.get('lastDisplay', null);
    const data = last && (await store.readDisplay(last).catch(() => null));
    if (data) await room.restore(data);
  }
  room.stage.paused = false;
  await renderDisplayList();
}

function closeDisplay() {
  $('#display').hidden = true;
  room.stage.paused = true;
  stage.paused = false;
}

async function renderDisplayList() {
  const list = await store.listCreations();
  $('#display-list').innerHTML = list
    .map(
      c => `<div class="file-row" data-put="${esc(c.name)}"><img src="${store.thumbUrl('creation', c.name, c.modified)}" alt="" onerror="this.style.visibility='hidden'"><div class="t"><b>${esc(c.name)}</b></div></div>`,
    )
    .join('');
  const names = await store.listDisplays();
  $('#display-choose').innerHTML = `<option value="">Saved displays…</option>${names.map(n => `<option>${esc(n)}</option>`).join('')}`;
}

function wireDisplay() {
  $('#display-list').addEventListener('click', async e => {
    const row = e.target.closest('[data-put]');
    if (!row) return;
    try {
      await room.add(row.dataset.put);
    } catch (err) {
      toast('Could not put that out: ' + err.message);
    }
  });
  $('#display-light').addEventListener('change', e => room.setLight(e.target.value));
  $('#display-run').addEventListener('change', e => room.setRunning(e.target.checked));
  $('#display-furniture').addEventListener('change', e => room.setFurniture(e.target.value));
  $('#display-choose').addEventListener('change', async e => {
    if (!e.target.value) return;
    const data = await store.readDisplay(e.target.value);
    const missing = await room.restore(data);
    $('#display-light').value = room.light;
    $('#display-furniture').value = room.furniture;
    ls.set('lastDisplay', e.target.value);
    if (missing.length) toast(`Not found any more: ${missing.join(', ')}`);
  });
  $('#display-bar').addEventListener('click', async e => {
    const a = e.target.closest('button')?.dataset.dact;
    if (a === 'back') closeDisplay();
    if (a === 'picture') {
      const p = await media.picture(room.stage, 'Display');
      toast('Picture saved to Pictures');
      platform.reveal(p);
    }
    if (a === 'turntable') runTurntable(room.stage, 'Display');
    if (a === 'save') {
      const name = await askName('Name this display', ls.get('lastDisplay', 'My display'));
      if (!name) return;
      const n = await store.saveDisplay(name, room.toJSON());
      ls.set('lastDisplay', n);
      toast(`Display “${n}” saved`);
      renderDisplayList();
    }
  });
}

function displayKey(e) {
  if (e.target.matches('input, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') room.selected ? room.select(null) : closeDisplay();
  else if (k === 'r') room.turnSelected(e.shiftKey ? -1 : 1);
  else if (k === 'delete' || k === 'backspace') room.removeSelected();
  else return;
  e.preventDefault();
}

boot().catch(e => {
  console.error(e);
  loading('Could not start: ' + e.message);
  $('.spinner').hidden = true;
});
