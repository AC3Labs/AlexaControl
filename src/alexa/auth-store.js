'use strict';

const fs = require('fs');
const path = require('path');

// Stores the Amazon login data (alexa.cookieData from alexa-remote2) so the
// plugin can reconnect after a restart without a new browser login.
//
// The file holds live session tokens in plain text. It lives in the plugin's
// data folder, which only your Windows user can read by default.
class AuthStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'alexa-auth.json');
    this.formerDataStorePath = path.join(dataDir, 'alexa-former-data.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Returns { amazonPage, savedAt, cookieData } or null.
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.cookieData && typeof parsed.cookieData === 'object') return parsed;
    } catch {
      // Missing or unreadable file means "not logged in".
    }
    return null;
  }

  save(amazonPage, cookieData) {
    if (!cookieData || typeof cookieData !== 'object') return false;
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ amazonPage, savedAt: new Date().toISOString(), cookieData }, null, 2);
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return true;
  }

  // Moves login files from an older location (the plugin folder, which
  // Touch Portal wipes when the plugin is re-imported) into this folder.
  // Files already present here are never overwritten. Returns moved names.
  migrateFrom(oldDir) {
    const moved = [];
    if (!oldDir || path.resolve(oldDir) === path.resolve(this.dir)) return moved;
    for (const name of ['alexa-auth.json', 'alexa-former-data.json']) {
      const from = path.join(oldDir, name);
      const to = path.join(this.dir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      moved.push(name);
    }
    return moved;
  }

  // Forgets the login. alexa-former-data.json is kept on purpose: it lets the
  // next proxy login reuse the same registered "device" at Amazon instead of
  // adding a new one each time. The README explains when to delete it by hand.
  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Already gone.
    }
  }
}

module.exports = { AuthStore };
