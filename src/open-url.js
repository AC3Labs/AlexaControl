'use strict';

const { spawn } = require('child_process');

// Opens a web address in the default browser of the computer running the
// plugin (the PC, not the tablet). Only http(s) addresses are allowed.
//
// Windows uses "rundll32 url.dll,FileProtocolHandler <url>", which hands the
// address to the default browser without going through cmd.exe, so nothing
// in the address can be read as a shell command.
function openUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`Not a valid web address: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https addresses can be opened, got "${parsed.protocol}"`);
  }
  const href = parsed.href;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', href];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [href];
  } else {
    command = 'xdg-open';
    args = [href];
  }
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return { command, args };
}

module.exports = { openUrl };
