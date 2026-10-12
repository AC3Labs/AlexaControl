'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempDir(prefix = 'alexacontrol-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Logger stand-in that keeps lines in memory.
function memoryLogger() {
  const lines = [];
  const log = (level) => (...parts) => lines.push(`${level} ${parts.join(' ')}`);
  return {
    lines,
    error: log('error'),
    warn: log('warn'),
    info: log('info'),
    debug: log('debug'),
    setLevel() {},
    libraryLogger: () => (...parts) => lines.push(`lib ${parts.join(' ')}`),
  };
}

const DEVICES = {
  G0001: { serialNumber: 'G0001', accountName: 'Kitchen Echo', deviceFamily: 'ECHO', deviceType: 'A1', capabilities: ['VOLUME_SETTING', 'AUDIO_PLAYER'], online: true },
  G0002: { serialNumber: 'G0002', accountName: 'Office Dot', deviceFamily: 'ECHO', deviceType: 'A2', capabilities: ['VOLUME_SETTING'], online: true },
  APP01: { serialNumber: 'APP01', accountName: 'This Phone', deviceFamily: 'VOX', deviceType: 'A3', capabilities: [], online: true },
};

// Mock of the alexa-remote2 class. Only the methods the plugin uses exist,
// so a typo in a method name fails the test instead of passing silently.
//
// loginMode:
//   'saved'  init succeeds straight away
//   'proxy'  init first reports the proxy URL; call completeLogin() to finish
//   'fail'   init fails with failError
class FakeAlexa extends EventEmitter {
  constructor({ loginMode = 'saved', failError = new Error('Unauthorized'), responses = {} } = {}) {
    super();
    this.loginMode = loginMode;
    this.failError = failError;
    this.responses = responses;
    this.calls = [];
    this.serialNumbers = {};
    this.stopped = false;
    this.cookieData = undefined;
  }

  init(options, callback) {
    this.options = options;
    this.initCallback = callback;
    setImmediate(() => {
      if (this.loginMode === 'fail') return callback(this.failError);
      if (this.loginMode === 'proxy') {
        return callback(new Error(`Please open http://${options.proxyOwnIp}:${options.proxyPort}/ with your browser and login to Amazon. The cookie will be output here after successfull login.`));
      }
      this.serialNumbers = { ...DEVICES };
      this.cookieData = { localCookie: 'session-token=SECRETSECRETSECRET; csrf=12345678', macDms: { adp_token: 'x' } };
      return callback();
    });
  }

  completeLogin() {
    this.serialNumbers = { ...DEVICES };
    this.cookieData = { localCookie: 'session-token=NEWSECRETNEWSECRET; csrf=12345678', macDms: { adp_token: 'y' } };
    this.emit('cookie', 'cookie', 'csrf', {});
    this.initCallback();
  }

  // Stand-in for the library's HTTP call. With flags.isRetry the library
  // does not retry a rate limit; it calls back with the response text.
  httpsGet(path, cb, flags) {
    const [name, args] = this.pendingRecord || ['httpsGet', [path]];
    this.pendingRecord = null;
    this.lastIsRetry = Boolean(flags && flags.isRetry);
    const response = name in this.responses ? this.responses[name] : { success: true };
    if (response === FakeAlexa.RATE_LIMIT && this.lastIsRetry) {
      this.calls.push({ name, args });
      this.options.logger('Alexa-Remote: Response: No/Invalid JSON : Rate exceeded: Too many requests.');
      setImmediate(() => cb(new Error('no JSON'), 'Rate exceeded: Too many requests.'));
      return;
    }
    this.record(name, args, cb, { success: true });
  }

  record(name, args, cb, fallback) {
    this.calls.push({ name, args });
    const response = name in this.responses ? this.responses[name] : fallback;
    if (response === FakeAlexa.RATE_LIMIT) {
      // What alexa-remote2 does on "Rate exceeded": log it, retry much later.
      this.options.logger('Alexa-Remote: Response: No/Invalid JSON : Rate exceeded: Too many requests.');
      this.options.logger('Alexa-Remote: rate exceeded response ... Retrying once in 60000ms');
      return;
    }
    setImmediate(() => (response instanceof Error ? cb(response) : cb(null, response)));
  }

  initDeviceState(cb) { this.record('initDeviceState', [], cb, undefined); }
  getAutomationRoutines(cb) {
    this.record('getAutomationRoutines', [], cb, [
      { automationId: 'r1', name: 'Good night', status: 'ENABLED', triggers: [] },
      { automationId: 'r2', name: null, status: 'ENABLED', triggers: [{ payload: { utterance: 'movie time' } }] },
      { automationId: 'r3', name: 'Old', status: 'DISABLED' },
    ]);
  }
  getSmarthomeDevicesV2(cb) {
    this.record('getSmarthomeDevicesV2', [], cb, [
      { id: 'e1', friendlyName: 'Desk Lamp', legacyAppliance: { entityId: 'ent-lamp', applianceId: 'AAA_lamp' } },
      { id: 'e2', friendlyName: 'Fan', legacyAppliance: { entityId: 'ent-fan', applianceId: 'AAA_fan' } },
    ]);
  }
  getDeviceStatusList(cb) {
    this.record('getDeviceStatusList', [], cb, { doNotDisturbDeviceStatusList: [{ deviceSerialNumber: 'G0001', enabled: true }, { deviceSerialNumber: 'G0002', enabled: false }] });
  }
  querySmarthomeDevices(toQuery, cb) {
    const entityId = toQuery[0].entityId;
    const power = { 'ent-lamp': 'ON' }[entityId];
    this.record('querySmarthomeDevices', [entityId], cb, {
      deviceStates: power ? [{ entity: { entityId }, capabilityStates: [JSON.stringify({ namespace: 'Alexa.PowerController', name: 'powerState', value: power })] }] : [],
      errors: power ? [] : [{ code: 'ENDPOINT_UNREACHABLE', entity: { entityId } }],
    });
  }
  getAllDeviceVolumes(cb) { this.record('getAllDeviceVolumes', [], cb, { volumes: [{ dsn: 'G0001', speakerVolume: 40 }, { dsn: 'G0002', speakerVolume: 25 }] }); }
  getPlayerInfo(serial, cb) {
    this.record('getPlayerInfo', [serial], cb, { playerInfo: { state: 'PLAYING', infoText: { title: 'Song', subText1: 'Artist' }, volume: { volume: 40 } } });
  }
  createSequenceNode(command, value) {
    return { type: command, operationPayload: { locale: 'ALEXA_CURRENT_LOCALE', value } };
  }
  // Records [serial, command, value] like the string form so tests stay
  // readable; the locale of the last sequence is kept for the locale test.
  sendSequenceCommand(serial, command, value, cb) {
    if (typeof command === 'object') {
      if (typeof value === 'function') cb = value;
      const payload = command.startNode.operationPayload;
      this.lastSequenceLocale = payload.locale;
      this.pendingRecord = ['sendSequenceCommand', [serial, command.startNode.type, payload.value]];
      this.httpsGet('/api/behaviors/preview', (err, res) => {
        this.calls.at(-1).isRetry = this.lastIsRetry;
        cb(err, res);
      }, { method: 'POST' });
      return;
    }
    this.record('sendSequenceCommand', [serial, command, value], cb, { success: true });
  }
  sendCommand(serial, command, value, cb) { this.record('sendCommand', [serial, command, value], cb, { success: true }); }
  setDoNotDisturb(serial, enabled, cb) { this.record('setDoNotDisturb', [serial, enabled], cb, { success: true }); }
  executeAutomationRoutine(serial, routine, cb) { this.record('executeAutomationRoutine', [serial, routine], cb, { success: true }); }
  stop() { this.stopped = true; }
}

FakeAlexa.RATE_LIMIT = Symbol('rate limit');

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      return setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { tempDir, memoryLogger, FakeAlexa, DEVICES, waitFor };
