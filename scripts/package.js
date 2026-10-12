'use strict';

// Builds dist/AlexaControl.tpp
//
// Touch Portal's plugin file rules (docs: "The Plugin File (.tpp)"):
// - a .tpp is a zip file whose root is ONE folder without spaces
// - entry.tp sits directly inside that folder
// - Touch Portal stores the plugin under %APPDATA%\TouchPortal\plugins\<folder>
//
// Steps: copy the plugin files into build/AlexaControl, install production
// dependencies there (so the user never runs npm install), then zip it.
// The zip writer below uses only Node's built-in zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FOLDER = 'AlexaControl';
const BUILD = path.join(ROOT, 'build', FOLDER);
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, `${FOLDER}.tpp`);
const COPY = ['entry.tp', 'package.json', 'package-lock.json', 'README.md', 'src', 'images'];

function main() {
  fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  for (const item of COPY) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) throw new Error(`Missing ${item}`);
    fs.cpSync(from, path.join(BUILD, item), { recursive: true });
  }

  console.log('Installing production dependencies into the build folder...');
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: BUILD, stdio: 'inherit' });

  const native = listFiles(BUILD).filter((f) => f.endsWith('.node'));
  if (native.length > 0) {
    throw new Error(`Native modules found; they would only work on the build OS:\n${native.join('\n')}`);
  }

  const files = listFiles(BUILD);
  const entries = files.map((full) => ({
    name: `${FOLDER}/${path.relative(BUILD, full).split(path.sep).join('/')}`,
    data: fs.readFileSync(full),
    mtime: fs.statSync(full).mtime,
  }));
  fs.writeFileSync(OUT, buildZip(FOLDER, entries));
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${entries.length} files, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------- zip writer
// Standard zip (PKWARE APPNOTE): local headers + data, central directory,
// end of central directory record. Deflate compression, UTF-8 names.

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(rootFolder, files) {
  const entries = [{ name: `${rootFolder}/`, data: Buffer.alloc(0), mtime: new Date(), dir: true }, ...files];
  if (entries.length > 0xffff) throw new Error('Too many files for a plain zip');
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const compressed = e.dir ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
    const method = e.dir ? 0 : 8;
    const crc = e.dir ? 0 : zlib.crc32(e.data);
    const { time, day } = dosDateTime(e.mtime);
    const flags = 0x0800; // names are UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.dir ? 0x10 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + compressed.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, end]);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Packaging failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { buildZip };
