// One door to the disk. Inside the Mac app it talks to the Rust backend (src-tauri/src/lib.rs);
// in a plain browser it talks to tools/devserver.mjs, which implements the same commands.

const T = globalThis.__TAURI__;
export const isApp = !!T;

async function call(cmd, args = {}) {
  if (isApp) return T.core.invoke(cmd, args);
  const r = await fetch('/api/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body.result;
}

let pathsCache = null;
export async function paths() {
  if (!pathsCache) pathsCache = await call('app_paths');
  return pathsCache;
}

/** URL the browser/webview can fetch for an absolute file path. Folder paths keep a trailing slash. */
export function fileUrl(absPath) {
  if (isApp) {
    const trailing = absPath.endsWith('/');
    const url = T.core.convertFileSrc(trailing ? absPath.slice(0, -1) : absPath);
    return trailing ? url + '/' : url;
  }
  return '/fs' + absPath.split('/').map(encodeURIComponent).join('/');
}

export const readText = path => call('read_text', { path });
export const writeText = (path, text) => call('write_text', { path, text });
export const listDir = path => call('list_dir', { path });
export const trashPath = path => call('trash_path', { path });
export const removeFile = path => call('remove_file', { path });
export const scanHeaders = path => call('scan_headers', { path });
export const httpGet = url => call('http_get', { url });
export const libraryStatus = () => call('library_status');
export const downloadLibrary = () => call('download_library');
export const hasFfmpeg = () => call('has_ffmpeg');
export const encodeVideo = (framesDir, outPath, fps) => call('encode_video', { framesDir, outPath, fps });
export const reveal = path => call('reveal', { path });

export async function writeBytes(path, bytes) {
  if (isApp) {
    return T.core.invoke('write_bytes', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
  }
  const r = await fetch('/api/write_bytes', { method: 'POST', headers: { 'x-path': encodeURIComponent(path) }, body: bytes });
  if (!r.ok) throw new Error((await r.json()).error);
}

export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
