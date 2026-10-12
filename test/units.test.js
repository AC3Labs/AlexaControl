'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { redact, addSecret, clearSecrets, MASK } = require('../src/redact');
const { Logger } = require('../src/logger');
const { RateLimitedQueue, callWithTimeout, TimeoutError, QueueFullError } = require('../src/queue');
const { parseSettings, parseBool } = require('../src/settings');
const parse = require('../src/alexa/parse');
const { timerPhrase } = require('../src/alexa/backend');
const { openUrl } = require('../src/open-url');
const { tempDir, DEVICES } = require('./helpers');

test('redact: JSON secret keys are masked', () => {
  const input = JSON.stringify({ refreshToken: 'Atnr|abc', localCookie: 'a=b', macDms: { adp_token: 'x', device_private_key: 'y' }, deviceSerialNumber: 'G0001' });
  const out = redact(input);
  assert.ok(!out.includes('Atnr|abc'));
  assert.ok(!out.includes('adp_token":"x'));
  assert.ok(out.includes('"deviceSerialNumber":"G0001"'), 'non-secret values stay readable');
});

test('redact: cookie strings, bearer tokens and Amazon tokens are masked', () => {
  const line = 'Alexa-Cookie: Result: csrf=123456789, Cookie=session-id=123-4567890-1234567; session-token="abcdefghijklmnop"; ubid-main=133-1234567-7654321';
  const out = redact(line);
  for (const secret of ['123-4567890-1234567', 'abcdefghijklmnop', '133-1234567-7654321', '123456789']) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
  assert.equal(redact('Authorization: Bearer eyJhbGciOi.abc.def'), `Authorization: Bearer ${MASK}`);
  assert.ok(!redact('token Atza|IwEBIA-very-secret-value').includes('IwEBIA'));
});

test('redact: phone numbers and names from the accounts response are masked', () => {
  const line = 'Response: [{"commsId":"amzn1.comms.id.person.x","phoneCountryCode":"1","phoneNumber":"5551234567","firstName":"Pat","lastName":"Example","personIdV2":"amzn1.actor.person.oid.ABC"}]';
  const out = redact(line);
  for (const leak of ['5551234567', 'Pat', 'Example', 'amzn1.comms.id', 'oid.ABC']) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes('"phoneCountryCode":"1"'));
});

test('redact: registered secrets are replaced anywhere', () => {
  addSecret('vm-token-1234');
  assert.equal(redact('using vm-token-1234 now'), `using ${MASK} now`);
  clearSecrets();
});

test('redact: errors and objects are stringified first', () => {
  const err = new Error('failed with session-token=abcdefghijk');
  assert.ok(!redact(err).includes('abcdefghijk'));
  assert.ok(!redact({ password: 'hunter2hunter2' }).includes('hunter2'));
});

test('logger: writes redacted lines, respects level, rotates at size cap', () => {
  const dir = tempDir();
  const log = new Logger({ dir, maxBytes: 400, keepFiles: 2, level: 'info' });
  log.debug('hidden debug line');
  log.info('cookie value session-token=abcdefghijklmnop');
  const first = fs.readFileSync(path.join(dir, 'plugin.log'), 'utf8');
  assert.ok(!first.includes('hidden debug line'));
  assert.ok(!first.includes('abcdefghijklmnop'));
  for (let i = 0; i < 20; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
  assert.ok(fs.existsSync(path.join(dir, 'plugin.log.1')));
  assert.ok(!fs.existsSync(path.join(dir, 'plugin.log.3')), 'keeps at most keepFiles old files');
  assert.ok(fs.statSync(path.join(dir, 'plugin.log')).size <= 400);
});

test('queue: runs jobs in order with a minimum gap', async () => {
  const q = new RateLimitedQueue({ minGapMs: 30 });
  const started = [];
  const job = (n) => q.add(`job${n}`, (cb) => { started.push(Date.now()); cb(null, n); });
  const results = await Promise.all([job(1), job(2), job(3)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.ok(started[1] - started[0] >= 25 && started[2] - started[1] >= 25);
});

test('queue: a call that never answers times out and the queue keeps going', async () => {
  const q = new RateLimitedQueue({ minGapMs: 0 });
  await assert.rejects(q.add('stuck', () => {}, 30), TimeoutError);
  assert.equal(await q.add('next', (cb) => cb(null, 'ok')), 'ok');
});

test('queue: errors, sync throws and late callbacks are handled', async () => {
  await assert.rejects(callWithTimeout('err', (cb) => cb(new Error('boom')), 100), /boom/);
  await assert.rejects(callWithTimeout('throw', () => { throw new Error('sync'); }, 100), /sync/);
  let late;
  const p = callWithTimeout('late', (cb) => { late = cb; }, 20);
  await assert.rejects(p, TimeoutError);
  assert.doesNotThrow(() => late(null, 'too late'));
});

test('queue: rejects when full and clears on close', async () => {
  const q = new RateLimitedQueue({ minGapMs: 0, maxPending: 1 });
  const first = q.add('a', (cb) => setTimeout(() => cb(null, 1), 30));
  const second = q.add('b', (cb) => cb(null, 2));
  await assert.rejects(q.add('c', (cb) => cb(null, 3)), QueueFullError);
  const secondRejected = assert.rejects(second, /shutting down/);
  q.close();
  assert.equal(await first, 1);
  await secondRejected;
  await assert.rejects(q.add('d', (cb) => cb(null, 4)), /closed/);
});

test('settings: parses Touch Portal array format with defaults', () => {
  const s = parseSettings([
    { 'Alexa backend enabled': 'Off' },
    { 'Amazon region': 'Germany (amazon.de)' },
    { 'Login proxy port': '4000' },
    { 'Voice Monkey enabled': 'On' },
    { 'Voice Monkey token': '  abc  ' },
    { 'Log level': 'DEBUG' },
  ]);
  assert.equal(s.alexaEnabled, false);
  assert.equal(s.region.amazonPage, 'amazon.de');
  assert.equal(s.proxyPort, 4000);
  assert.equal(s.vmEnabled, true);
  assert.equal(s.vmToken, 'abc');
  assert.equal(s.logLevel, 'debug');
  const d = parseSettings([]);
  assert.equal(d.alexaEnabled, true);
  assert.equal(d.region.amazonPage, 'amazon.com');
  assert.equal(d.proxyAddress, '127.0.0.1');
  assert.equal(parseSettings([{ 'Login proxy port': '80' }]).proxyPort, 3456, 'privileged ports fall back');
  assert.equal(parseBool('true', false), true);
  assert.equal(parseBool('weird', true), true);
});

test('parse: Echo devices exclude apps and app sub-devices, duplicate names get a suffix', () => {
  const devices = parse.extractEchoDevices({
    ...DEVICES,
    SUB01: { ...DEVICES.G0001, serialNumber: 'SUB01', parentDeviceSerialNumber: 'G0001' },
    G0003: { serialNumber: 'G0003', accountName: 'Kitchen Echo', deviceFamily: 'ECHO', capabilities: ['VOLUME_SETTING'] },
  });
  assert.deepEqual(devices.map((d) => d.name), ['Kitchen Echo (0001)', 'Kitchen Echo (0003)', 'Office Dot']);
});

test('parse: falls back to all non-app devices when capabilities are unknown', () => {
  const devices = parse.extractEchoDevices({ X1: { serialNumber: 'X1', accountName: 'Mystery', deviceFamily: 'ECHO' } });
  assert.equal(devices.length, 1);
});

test('parse: routines, smart home, player info, volumes, proxy url', () => {
  const routines = parse.extractRoutines([
    { automationId: 'a', name: 'Good night', status: 'ENABLED' },
    { automationId: 'b', name: '', triggers: [{ payload: { utterance: 'movie time' } }] },
    { automationId: 'c', name: 'Off one', status: 'DISABLED' },
  ]);
  assert.deepEqual(routines.map((r) => r.name), ['"movie time"', 'Good night']);
  assert.deepEqual(parse.extractRoutines(null), []);
  assert.deepEqual(parse.extractSmartHomeDevices([{ friendlyName: 'Fan', legacyAppliance: { entityId: 'x1' } }, { friendlyName: 'Fan' }, {}]), [{ name: 'Fan', entityId: 'x1' }]);
  assert.deepEqual(parse.extractDndStatus({ doNotDisturbDeviceStatusList: [{ deviceSerialNumber: 'A', enabled: true }, { deviceSerialNumber: 'B' }] }), { A: true });
  assert.equal(parse.extractPowerState({ deviceStates: [{ entity: { entityId: 'x1' }, capabilityStates: ['{"namespace":"Alexa.PowerController","name":"powerState","value":"OFF"}', 'not json'] }] }, 'x1'), 'OFF');
  assert.equal(parse.extractPowerState({ deviceStates: [{ entity: { entityId: 'other' }, capabilityStates: ['{"namespace":"Alexa.PowerController","name":"powerState","value":"ON"}'] }] }, 'x1'), null);
  assert.equal(parse.extractPowerState({ errors: [{ code: 'ENDPOINT_UNREACHABLE' }] }, 'x1'), null);
  assert.deepEqual(parse.extractPlayerInfo({ playerInfo: { state: 'PAUSED', infoText: { title: 'T', subText1: 'A' }, volume: { volume: 12 } } }), { state: 'PAUSED', title: 'T', artist: 'A', volume: 12 });
  assert.deepEqual(parse.extractPlayerInfo(undefined), { state: '', title: '', artist: '', volume: null });
  assert.deepEqual(parse.extractVolumes({ volumes: [{ dsn: 'A', speakerVolume: 5 }, { deviceSerialNumber: 'B', volume: '7' }] }), { A: 5, B: 7 });
  assert.equal(parse.extractProxyUrl('Please open http://127.0.0.1:3456/ with your browser and login'), 'http://127.0.0.1:3456/');
  assert.equal(parse.extractProxyUrl('something else'), null);
});

test('timer phrases', () => {
  assert.equal(timerPhrase(5), 'set a timer for 5 minutes');
  assert.equal(timerPhrase(90, 'pasta'), 'set a pasta timer for 1 hour 30 minutes');
  assert.equal(timerPhrase(1.5), 'set a timer for 1 minute 30 seconds');
  assert.throws(() => timerPhrase(0), /between/);
  assert.throws(() => timerPhrase('abc'), /between/);
});

test('openUrl: uses the right command per OS and only allows http(s)', () => {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  openUrl('http://127.0.0.1:3456/', { platform: 'win32', spawnImpl });
  openUrl('http://127.0.0.1:3456/', { platform: 'darwin', spawnImpl });
  openUrl('http://127.0.0.1:3456/', { platform: 'linux', spawnImpl });
  assert.deepEqual(spawned.map((s) => [s.cmd, ...s.args]), [
    ['rundll32', 'url.dll,FileProtocolHandler', 'http://127.0.0.1:3456/'],
    ['open', 'http://127.0.0.1:3456/'],
    ['xdg-open', 'http://127.0.0.1:3456/'],
  ]);
  assert.equal(spawned[0].opts.detached, true);
  assert.throws(() => openUrl('file:///C:/Windows/System32/calc.exe', { spawnImpl }), /Only http/);
  assert.throws(() => openUrl('not a url', { spawnImpl }), /valid web address/);
  assert.equal(spawned.length, 3);
});

test('redact: shapes seen in a real alexa-remote2 debug log', () => {
  const cases = {
    'Alexa-Remote: Update Cookie x-main = "aBcD1234efgh@tvXyZ@3Z"': 'aBcD1234efgh',
    'Alexa-Remote: Add Cookie session-id = 133-1234567-7654321': '133-1234567',
    '{"Path":"/","Secure":true,"Value":"133-1234567-7654321","Name":"session-id"}': '133-1234567',
    '{"openid.oa2.authorization_code":"ANabcdefghijklmnopqrst"}': 'ANabcdefgh',
    'Handle token response: {"body":"{\\"authorization_code\\":\\"ANabcdefghijklmnop\\"}"}': 'ANabcdefgh',
    'Get User data Response: {"email":"someone@example.com","customer_id":"A1B2C3D4E5F6G7"}': 'A1B2C3D4E5F6G7',
    'mail me at someone.else@example.co.uk please': 'someone.else',
  };
  for (const [input, secret] of Object.entries(cases)) {
    assert.ok(!redact(input).includes(secret), `leaked "${secret}" from: ${input}`);
  }
  assert.equal(redact('{"deviceSerialNumber":"G0001"}'), '{"deviceSerialNumber":"G0001"}');
  assert.equal(redact('level=warning'), 'level=warning');
});
