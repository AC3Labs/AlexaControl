'use strict';

const { SETTINGS } = require('./ids');
const { findRegion, DEFAULT_REGION } = require('./regions');

const DEFAULTS = {
  alexaEnabled: true,
  region: DEFAULT_REGION,
  proxyAddress: '127.0.0.1',
  proxyPort: 3456,
  vmEnabled: false,
  vmToken: '',
  logLevel: 'info',
};

// Touch Portal sends settings as an array of one-key objects, for example
// [{"Log level":"info"},{"Voice Monkey token":"..."}], both in the "info"
// message after pairing and in "settings" messages. This flattens either
// shape into a plain name -> value map.
function flattenSettings(raw) {
  const map = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === 'object') Object.assign(map, entry);
    }
  } else if (raw && typeof raw === 'object') {
    Object.assign(map, raw);
  }
  return map;
}

// Switch settings: the docs do not state the exact string Touch Portal sends,
// so accept the common spellings.
function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enabled'].includes(text)) return true;
  if (['off', 'false', '0', 'no', 'disabled'].includes(text)) return false;
  return fallback;
}

function parsePort(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
}

function parseSettings(raw) {
  const map = flattenSettings(raw);
  const has = (name) => Object.prototype.hasOwnProperty.call(map, name);
  return {
    alexaEnabled: parseBool(map[SETTINGS.ALEXA_ENABLED], DEFAULTS.alexaEnabled),
    region: has(SETTINGS.REGION) ? findRegion(String(map[SETTINGS.REGION])) : DEFAULTS.region,
    proxyAddress: String(map[SETTINGS.PROXY_ADDRESS] || DEFAULTS.proxyAddress).trim() || DEFAULTS.proxyAddress,
    proxyPort: parsePort(map[SETTINGS.PROXY_PORT], DEFAULTS.proxyPort),
    vmEnabled: parseBool(map[SETTINGS.VM_ENABLED], DEFAULTS.vmEnabled),
    vmToken: String(map[SETTINGS.VM_TOKEN] || '').trim(),
    logLevel: String(map[SETTINGS.LOG_LEVEL] || DEFAULTS.logLevel).trim().toLowerCase(),
  };
}

module.exports = { parseSettings, flattenSettings, parseBool, DEFAULTS };
