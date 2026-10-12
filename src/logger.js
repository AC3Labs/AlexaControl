'use strict';

const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Small file logger:
// - every line is passed through redact() first
// - the file is capped at maxBytes; when full it is renamed to .1 (older
//   files shift to .2, .3 ...) and a fresh file is started
// - writes are synchronous so nothing is lost if Touch Portal kills the
//   process right after the close message
class Logger {
  constructor({ dir, fileName = 'plugin.log', maxBytes = 1024 * 1024, keepFiles = 3, level = 'info', echo = false }) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
    this.echo = echo;
    this.setLevel(level);
    fs.mkdirSync(dir, { recursive: true });
  }

  setLevel(level) {
    const key = String(level || '').toLowerCase();
    this.level = key in LEVELS ? key : 'info';
  }

  error(...parts) { this.write('error', parts); }
  warn(...parts) { this.write('warn', parts); }
  info(...parts) { this.write('info', parts); }
  debug(...parts) { this.write('debug', parts); }

  write(level, parts) {
    if (LEVELS[level] > LEVELS[this.level]) return;
    const message = parts.map((p) => redact(p)).join(' ');
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // Logging must never take the plugin down.
    }
    if (this.echo) process.stdout.write(line);
  }

  rotateIfNeeded(incomingBytes) {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size + incomingBytes <= this.maxBytes) return;
    for (let i = this.keepFiles - 1; i >= 1; i -= 1) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    const oldest = `${this.file}.${this.keepFiles}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    fs.renameSync(this.file, `${this.file}.1`);
  }

  // A function shaped like the logger alexa-remote2 expects: (...args) => void.
  // Library chatter goes to debug so normal logs stay readable.
  libraryLogger(prefix) {
    return (...args) => this.debug(prefix, ...args);
  }
}

module.exports = { Logger, LEVELS };
