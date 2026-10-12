#!/usr/bin/env node
// ============================================================================
// Package the Python + Arcade desktop client so the web UI can offer it as a
// download. Writes gpd/public/gpd-desktop.zip, which `vite dev` serves at
// /gpd-desktop.zip and `vite build` copies into dist/.
//
// Dependency-free: the ZIP is assembled here with node:zlib, so `npm install`
// does not grow by a compression library just to ship a download.
//
// Usage: node tools/build-desktop-zip.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const SRC = path.join(ROOT, 'desktop');
const OUT = path.join(ROOT, 'gpd', 'public', 'gpd-desktop.zip');
const PREFIX = 'gpd-desktop/';
const SKIP_DIRS = new Set(['.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.git']);
const SKIP_EXT = new Set(['.pyc', '.pyo', '.zip']);

const README = `GPD — Geo-Political Domination, desktop client (Python + Arcade)
=================================================================

Requirements: Python 3.11 or newer.

  cd gpd-desktop
  python -m venv .venv
  . .venv/bin/activate          # Windows: .venv\\Scripts\\activate
  pip install -r requirements.txt

  python -m gpd_desktop                                   # play
  python -m gpd_desktop --simulate --preset World --players 8 --seed 5
  pytest tests -q

The desktop client plays every offline mode, with the same rules engine, the
same 175-country map and the same seeded PRNG as the web client, so a seed
replays identically on both.

Online multiplayer (lobbies, chat, leaderboard) is web-only — the Supabase
backend and the Realtime transport live in the web client.
`;

/** Walk the tree, skipping caches and virtualenvs. */
function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collect(full, rel));
    else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name))) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal ZIP writer: local headers, deflated payloads, central directory. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(PREFIX + file.rel, 'utf8');
    const raw = file.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x21, 12);         // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(0, 38);              // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const files = collect(SRC).map((f) => ({ rel: f.rel, data: fs.readFileSync(f.full) }));
files.push({ rel: 'README.txt', data: Buffer.from(README, 'utf8') });
files.sort((a, b) => a.rel.localeCompare(b.rel));

const archive = zip(files);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, archive);

const kb = (archive.length / 1024).toFixed(1);
console.log(`gpd-desktop.zip — ${files.length} files, ${kb} KiB -> ${path.relative(ROOT, OUT)}`);
