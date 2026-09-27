// Reads and writes LDraw model files (.ldr / .mpd).
// A model is { name, parts: [{ id, file, color, pos:[x,y,z], rot:[9 numbers row-major], step }] }
// in raw LDraw units (1 stud = 20, brick = 24, plate = 8, -Y is up).

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

let nextId = 1;
export const newId = () => nextId++;

function fmt(n) {
  // Round away float noise from rotations; keep files byte-stable across save/load.
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Parse a single-file .ldr (or the first/main model of an .mpd).
 * Returns { name, parts, submodels } where submodels holds any extra "0 FILE" blocks verbatim
 * so an imported multi-part model round-trips even though we edit it flat.
 */
export function parseLdr(text, fallbackName = 'Untitled') {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^0\s+FILE\s+/i.test(t)) {
      cur = { file: t.replace(/^0\s+FILE\s+/i, '').trim(), lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) {
      cur = { file: null, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(line);
  }
  const main = blocks.find(b => b.lines.some(l => /^\s*1\s/.test(l))) || blocks[0] || { lines: [] };
  const submodels = blocks.filter(b => b !== main && b.file).map(b => ({ file: b.file, text: b.lines.join('\n') }));

  let name = fallbackName;
  let step = 0;
  let motor = 0; // "0 !BUILDER MOTOR <rpm>" marks the next part as a motor (other programs ignore it)
  const parts = [];
  for (const line of main.lines) {
    const t = line.trim();
    if (!t) continue;
    const tok = t.split(/\s+/);
    if (tok[0] === '0') {
      if (/^0\s+!BUILDER\s+MOTOR\s+/i.test(t)) motor = Number(tok[3]) || 0;
      else if (/^0\s+(STEP|ROTSTEP)\b/i.test(t)) step++;
      else if (/^0\s+Name:/i.test(t)) name = t.replace(/^0\s+Name:\s*/i, '').replace(/\.(ldr|mpd|dat)$/i, '') || name;
      continue;
    }
    if (tok[0] !== '1' || tok.length < 15) continue;
    const color = tok[1];
    const nums = tok.slice(2, 14).map(Number);
    if (nums.some(Number.isNaN)) continue;
    const file = tok.slice(14).join(' ').replace(/\\/g, '/');
    const part = {
      id: newId(),
      file,
      color: /^\d+$/.test(color) ? Number(color) : color,
      pos: nums.slice(0, 3),
      rot: nums.slice(3, 12),
      step,
    };
    if (motor) part.motor = motor;
    motor = 0;
    parts.push(part);
  }
  return { name, parts, submodels };
}

/** Serialize to .ldr. One STEP per recorded build step so build-replay order survives. */
export function serializeLdr(model) {
  const out = [`0 ${model.name}`, `0 Name: ${model.name}.ldr`, '0 Author: Lego Builder', ''];
  let step = null;
  const sorted = [...model.parts].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  for (const p of sorted) {
    if (step !== null && (p.step ?? 0) !== step) out.push('0 STEP');
    step = p.step ?? 0;
    if (p.motor) out.push(`0 !BUILDER MOTOR ${fmt(p.motor)}`);
    out.push(['1', p.color, ...p.pos.map(fmt), ...p.rot.map(fmt), p.file].join(' '));
  }
  if (sorted.length) out.push('0 STEP');
  let text = out.join('\n') + '\n';
  if (model.submodels?.length) {
    // Keep imported submodels: wrap as MPD so references still resolve.
    text = `0 FILE ${model.name}.ldr\n` + text + model.submodels.map(s => `0 FILE ${s.file}\n${s.text.trim()}\n`).join('');
  }
  return text;
}

// ---- 3x3 rotation helpers (row-major, LDraw order a b c / d e f / g h i) ----

export function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function apply3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Quarter-turn rotation about an LDraw axis ('x'|'y'|'z'), n quarter turns. Exact integers. */
export function quarterTurn(axis, n = 1) {
  const k = ((n % 4) + 4) % 4;
  const c = [1, 0, -1, 0][k];
  const s = [0, 1, 0, -1][k];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function roundRot(m) {
  return m.map(v => {
    const r = Math.round(v * 1e6) / 1e6;
    return Object.is(r, -0) ? 0 : r;
  });
}

/**
 * Expand references to submodels (MPD "0 FILE" blocks without their own geometry) into their
 * library parts, composing transforms and passing colour 16 down. Blocks that DO carry geometry
 * are embedded custom parts: they stay as parts and remain in `submodels` so they still load/save.
 */
export function flattenModel(model) {
  const blocks = new Map((model.submodels || []).map(s => [s.file.toLowerCase(), s.text]));
  const isAssembly = text => !/^\s*[2345]\s/m.test(text);
  const keep = [];
  const out = [];
  const walk = (parts, parentPos, parentRot, parentColor, step, depth) => {
    for (const p of parts) {
      const color = p.color === 16 || p.color === '16' ? parentColor : p.color;
      const w = apply3(parentRot, p.pos);
      const pos = [w[0] + parentPos[0], w[1] + parentPos[1], w[2] + parentPos[2]];
      const rot = mul3(parentRot, p.rot);
      const sub = blocks.get(p.file.toLowerCase());
      if (sub != null && isAssembly(sub) && depth < 32) {
        walk(parseLdr(sub).parts, pos, rot, color, step ?? p.step, depth + 1);
      } else {
        if (sub != null) keep.push(p.file.toLowerCase());
        const flat = { id: newId(), file: p.file, color, pos: pos.map(v => Math.round(v * 1000) / 1000), rot: roundRot(rot), step: step ?? p.step };
        if (p.motor) flat.motor = p.motor;
        out.push(flat);
      }
    }
  };
  walk(model.parts, [0, 0, 0], IDENTITY, 16, null, 0);
  const keepSet = new Set(keep);
  // embedded parts may reference each other; keep every geometry block to be safe
  const submodels = (model.submodels || []).filter(s => keepSet.has(s.file.toLowerCase()) || !isAssembly(s.text));
  return { name: model.name, parts: out, submodels };
}
