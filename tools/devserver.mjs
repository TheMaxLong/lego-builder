// Browser twin of src-tauri/src/lib.rs so the frontend can run (and be screenshot-tested)
// outside the Mac app. Same commands, same folder guard.
// Run: node tools/devserver.mjs [port]   (default 5173)

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library/Application Support/LegoBuilder');
const DATA = process.env.LEGO_DATA || path.join(HOME, 'Documents/Lego Builder');
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../app');
const PORT = Number(process.argv[2] || 5173);

function guard(p) {
  const n = path.normalize(p);
  if (p.split('/').includes('..')) throw new Error('path not allowed: ' + p);
  if (n.startsWith(SUPPORT + '/') || n.startsWith(DATA + '/') || n === DATA) return n;
  throw new Error('path not allowed: ' + p);
}

async function writeAtomic(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-write';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

const commands = {
  async app_paths() {
    await fs.mkdir(DATA, { recursive: true });
    await fs.mkdir(path.join(SUPPORT, 'cache'), { recursive: true });
    return { library: path.join(SUPPORT, 'ldraw'), cache: path.join(SUPPORT, 'cache'), data: DATA };
  },
  async read_text({ path: p }) {
    try {
      return await fs.readFile(guard(p), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },
  async write_text({ path: p, text }) {
    await writeAtomic(guard(p), text);
    return null;
  },
  async list_dir({ path: p }) {
    let names;
    try {
      names = await fs.readdir(guard(p));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const out = [];
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(p, name));
        out.push({ name, is_dir: st.isDirectory(), modified: Math.round(st.mtimeMs), size: st.size });
      } catch {}
    }
    return out;
  },
  async trash_path({ path: p }) {
    const src = guard(p);
    const trash = path.join(DATA, '.trash');
    await fs.mkdir(trash, { recursive: true });
    await fs.rename(src, path.join(trash, `${Date.now()}-${path.basename(src)}`));
    return null;
  },
  async remove_file({ path: p }) {
    const g = guard(p);
    if (!(g.startsWith(path.join(SUPPORT, 'cache')) || g.startsWith(path.join(DATA, '.history')))) throw new Error('remove only allowed in cache/history');
    await fs.rm(g, { force: true });
    return null;
  },
  async scan_headers({ path: p }) {
    const dir = guard(p);
    const out = [];
    for (const file of await fs.readdir(dir)) {
      if (!file.toLowerCase().endsWith('.dat')) continue;
      const fh = await fs.open(path.join(dir, file));
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      await fh.close();
      const lines = [];
      for (const l of buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
        const t = l.trim();
        if (t && !t.startsWith('0')) break;
        lines.push(l);
      }
      out.push({ file, header: lines.join('\n') });
    }
    return out;
  },
  async http_get({ url }) {
    if (!url.startsWith('https://library.ldraw.org/')) throw new Error('only library.ldraw.org is allowed');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  },
  async library_status() {
    try {
      await fs.access(path.join(SUPPORT, 'ldraw/LDConfig.ldr'));
      return { state: 'ready', bytes: 0, total: 0, error: '' };
    } catch {
      return { state: 'missing', bytes: 0, total: 0, error: '' };
    }
  },
  async download_library() {
    throw new Error('download the library from the Mac app');
  },
  async has_ffmpeg() {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      try {
        await fs.access(p);
        return true;
      } catch {}
    }
    return false;
  },
  async encode_video({ framesDir, outPath, fps }) {
    const frames = guard(framesDir);
    const out = guard(outPath);
    await run('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'frame_%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out]);
    return null;
  },
  async reveal() {
    return null;
  },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const cmd = url.pathname.slice(5);
        let result;
        if (cmd === 'write_bytes') {
          const p = guard(decodeURIComponent(req.headers['x-path']));
          await writeAtomic(p, await body(req));
          result = null;
        } else {
          if (!commands[cmd]) throw new Error('unknown command ' + cmd);
          result = await commands[cmd](JSON.parse((await body(req)).toString() || '{}'));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ result }));
      }
      let file;
      if (url.pathname.startsWith('/fs/')) file = guard(decodeURIComponent(url.pathname.slice(3)));
      else file = path.join(APP, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(APP) && !url.pathname.startsWith('/fs/')) throw new Error('bad path');
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'text/plain', 'cache-control': 'no-store' });
      res.end(data);
    } catch (e) {
      const nf = e.code === 'ENOENT';
      res.writeHead(nf ? 404 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Lego Builder dev server on http://127.0.0.1:${PORT}`));
