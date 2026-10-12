'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { AlexaBackend } = require('../src/alexa/backend');
const { AuthStore } = require('../src/alexa/auth-store');
const { RateLimitedQueue } = require('../src/queue');
const { CONNECTION, ALL_ECHOS } = require('../src/ids');
const { parseSettings } = require('../src/settings');
const { tempDir, memoryLogger, FakeAlexa, waitFor } = require('./helpers');

function setup({ loginMode = 'saved', saved = true, responses, failError, timeoutMs = 15000, volumeTapGapMs = 30 } = {}) {
  const dir = tempDir();
  const authStore = new AuthStore(dir);
  if (saved) authStore.save('amazon.com', { localCookie: 'session-token=OLDOLDOLDOLD; csrf=12345678', macDms: {} });
  const fakes = [];
  const opened = [];
  const backend = new AlexaBackend({
    logger: memoryLogger(),
    authStore,
    createAlexa: () => {
      const fake = new FakeAlexa({ loginMode, responses, failError });
      fakes.push(fake);
      return fake;
    },
    queue: new RateLimitedQueue({ minGapMs: 0, defaultTimeoutMs: timeoutMs }),
    openBrowser: (url) => { opened.push(url); return { command: 'fake', args: [url] }; },
    timing: { pollTickMs: 60000, playerDebounceMs: 5, initWatchdogMs: 60000, volumeTapGapMs },
  });
  const events = { status: [], devices: [], routines: [], smarthome: [], volume: [], player: [], errors: [] };
  backend.on('status', (s) => events.status.push(s));
  backend.on('devices', (d) => events.devices.push(d));
  backend.on('routines', (r) => events.routines.push(r));
  backend.on('smarthome', (s) => events.smarthome.push(s));
  backend.on('volume', (serial, v) => events.volume.push([serial, v]));
  backend.on('player', (serial, info) => events.player.push([serial, info]));
  backend.on('error-text', (t) => events.errors.push(t));
  return { backend, fakes, events, authStore, dir, opened, settings: parseSettings([]) };
}

const lastStatus = (events) => events.status.at(-1);

test('saved login: connects, loads devices, routines, smart home and volumes', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);

  const fake = fakes[0];
  assert.equal(lastStatus(events).connection, CONNECTION.CONNECTED);
  assert.ok(fake.options.cookie && fake.options.cookie.localCookie, 'saved login handed to the library');
  assert.equal(fake.options.proxyListenBind, '127.0.0.1', 'proxy only listens locally by default');
  assert.equal(fake.options.usePushConnection, true);
  assert.equal(fake.options.amazonPage, 'amazon.com');
  assert.deepEqual(events.devices.at(-1).map((d) => d.name), ['Kitchen Echo', 'Office Dot']);
  assert.deepEqual(events.routines.at(-1), ['"movie time"', 'Good night']);
  assert.deepEqual(events.smarthome.at(-1), ['Desk Lamp', 'Fan']);
  assert.deepEqual(Object.fromEntries(backend.volumes), { G0001: 40, G0002: 25 });
});

test('proxy login: shows the URL, waits, then saves the login when the user finishes', async (t) => {
  const { backend, fakes, events, authStore, settings } = setup({ loginMode: 'proxy', saved: false });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.LOGIN_REQUIRED);
  assert.equal(lastStatus(events).loginUrl, 'http://127.0.0.1:3456/');
  assert.equal(authStore.load(), null);

  // Nothing retries on its own while waiting for the user.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fakes.length, 1, 'no second login attempt');

  fakes[0].completeLogin();
  await waitFor(() => lastStatus(events).connection === CONNECTION.CONNECTED);
  const saved = authStore.load();
  assert.equal(saved.amazonPage, 'amazon.com');
  assert.match(saved.cookieData.localCookie, /NEWSECRET/);
});

test('auth failure is reported and never retried automatically', async (t) => {
  const { backend, fakes, events, settings } = setup({ loginMode: 'fail', failError: new Error('401 Unauthorized') });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.ERROR);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fakes.length, 1);
  assert.equal(backend.retryTimer, null);
  assert.match(lastStatus(events).status, /Reconnect/);
});

test('network failure schedules a slow retry instead of a loop', async (t) => {
  const { backend, events, settings } = setup({ loginMode: 'fail', failError: new Error('getaddrinfo ENOTFOUND alexa.amazon.com') });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => /retrying in 1 min/.test(lastStatus(events).status));
  assert.ok(backend.retryTimer, 'one retry timer is set');
});

test('saved login for another region is not used', async (t) => {
  const { backend, fakes, settings } = setup({ loginMode: 'proxy' });
  t.after(() => backend.stop());
  backend.start({ ...settings, region: { ...settings.region, amazonPage: 'amazon.de' } });
  await waitFor(() => fakes.length === 1 && fakes[0].options);
  assert.equal(fakes[0].options.cookie, undefined);
});

test('commands call the verified library methods with the right arguments', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;

  await backend.speak('Kitchen Echo', 'Hello', 'Speak');
  await backend.speak(ALL_ECHOS, 'Dinner', 'Announce');
  await backend.speak(ALL_ECHOS, 'Hi all', 'Speak');
  await backend.textCommand('Office Dot', 'what time is it');
  await backend.media('Kitchen Echo', 'Pause');
  await backend.volume('Kitchen Echo', 55);
  await backend.stepVolume('Office Dot', 'Down', 10);
  await backend.doNotDisturb(ALL_ECHOS, 'On');
  await backend.runRoutine('Kitchen Echo', 'Good night');
  await backend.createTimer('Kitchen Echo', 10, 'tea');
  await backend.cancelTimers('Kitchen Echo');
  await backend.smartHomeOnOff('Kitchen Echo', 'Desk Lamp', 'Off');
  await backend.smartHomeVolume('Kitchen Echo', 'Desk Lamp', 'Up');
  await backend.smartHomeVolume('Kitchen Echo', 'Desk Lamp', 'Down');

  // Player refreshes run in the background and can land between commands.
  const summary = fake.calls.filter((c) => c.name !== 'getPlayerInfo').map((c) => [c.name, ...c.args.map((a) => (typeof a === 'object' && a && !Array.isArray(a) ? a.automationId : a))]);
  assert.deepEqual(summary, [
    ['sendSequenceCommand', 'G0001', 'speak', 'Hello'],
    ['sendSequenceCommand', ['G0001', 'G0002'], 'announcement', 'Dinner'],
    ['sendSequenceCommand', 'G0001', 'speak', 'Hi all'],
    ['sendSequenceCommand', 'G0002', 'speak', 'Hi all'],
    ['sendSequenceCommand', 'G0002', 'textCommand', 'what time is it'],
    ['sendCommand', 'G0001', 'pause', null],
    ['sendSequenceCommand', 'G0001', 'volume', 55],
    ['sendSequenceCommand', 'G0002', 'volume', 15],
    ['setDoNotDisturb', 'G0001', true],
    ['setDoNotDisturb', 'G0002', true],
    ['executeAutomationRoutine', 'G0001', 'r1'],
    ['sendSequenceCommand', 'G0001', 'textCommand', 'set a tea timer for 10 minutes'],
    ['sendSequenceCommand', 'G0001', 'textCommand', 'cancel all timers'],
    ['sendSequenceCommand', 'G0001', 'textCommand', 'turn off Desk Lamp'],
    ['sendSequenceCommand', 'G0001', 'textCommand', 'turn up the volume on Desk Lamp'],
    ['sendSequenceCommand', 'G0001', 'textCommand', 'turn down the volume on Desk Lamp'],
  ]);
});

test('sequence commands use the region language, not the library default de-DE', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);

  await backend.smartHomeOnOff('Kitchen Echo', 'Desk Lamp', 'On');
  assert.equal(fakes[0].lastSequenceLocale, 'en-US');
});

const volumeTexts = (fake) => fake.calls.filter((c) => c.name === 'sendSequenceCommand').map((c) => c.args[2]);

test('device volume: taps are spaced out, at most 3 wait, extra taps are ignored', async (t) => {
  const { backend, fakes, events, settings } = setup({ volumeTapGapMs: 60 });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;

  const started = Date.now();
  // The first tap goes out at once, three wait, the fifth is ignored.
  await Promise.all([1, 2, 3, 4, 5].map(() => backend.smartHomeVolume('Kitchen Echo', 'Fan', 'Up')));
  assert.deepEqual(volumeTexts(fake), Array(4).fill('turn up the volume on Fan'));
  assert.ok(Date.now() - started >= 3 * 60 - 10, 'taps are at least the gap apart');
  assert.ok(fake.calls.every((c) => c.isRetry === true), 'library retry is off for volume taps');
});

test('device volume: a tap in the other direction clears the waiting taps', async (t) => {
  const { backend, fakes, events, settings } = setup({ volumeTapGapMs: 60 });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;

  const ups = [1, 2, 3].map(() => backend.smartHomeVolume('Kitchen Echo', 'Fan', 'Up'));
  const down = backend.smartHomeVolume('Kitchen Echo', 'Fan', 'Down');
  await Promise.all([...ups, down]);
  assert.deepEqual(volumeTexts(fake), ['turn up the volume on Fan', 'turn down the volume on Fan']);
});

test('device volume: a rate-limited tap is dropped, not retried later', async (t) => {
  const { backend, fakes, events, settings } = setup({ responses: { sendSequenceCommand: FakeAlexa.RATE_LIMIT } });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;

  const first = backend.smartHomeVolume('Kitchen Echo', 'Fan', 'Up');
  const waiting = backend.smartHomeVolume('Kitchen Echo', 'Fan', 'Up');
  await assert.rejects(first, /rate limited this command, so it was dropped/);
  await waiting; // skipped, not sent
  assert.equal(volumeTexts(fake).length, 1);
  assert.equal(backend.throttleSecondsLeft, 0, 'no library retry window was started');
});

test('bad input is rejected before anything is sent to Amazon', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  fakes[0].calls.length = 0;

  await assert.rejects(backend.speak('Kitchen Echo', '   ', 'Speak'), /empty/);
  await assert.rejects(backend.volume('Kitchen Echo', 150), /0 to 100/);
  await assert.rejects(backend.textCommand('Garage', 'hi'), /Unknown Echo "Garage"/);
  await assert.rejects(backend.runRoutine('Kitchen Echo', 'Nope'), /Unknown routine/);
  await assert.rejects(backend.media('Kitchen Echo', 'Shuffle'), /Unknown media command/);
  await assert.rejects(backend.smartHomeOnOff('Kitchen Echo', '(none)', 'On'), /Pick a smart home device/);
  await assert.rejects(backend.smartHomeVolume('Kitchen Echo', '(none)', 'Up'), /Pick a smart home device/);
  await assert.rejects(backend.smartHomeVolume('Kitchen Echo', 'Desk Lamp', 'Sideways'), /Unknown direction/);
  await assert.rejects(backend.doNotDisturb('Kitchen Echo', 'Maybe'), /Unknown Do Not Disturb choice/);
  assert.equal(fakes[0].calls.length, 0);
});

test('a failing Amazon call rejects with the error and later calls still work', async (t) => {
  const { backend, events, settings } = setup({ responses: { sendCommand: new Error('Rate limited (429)') } });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  await assert.rejects(backend.media('Kitchen Echo', 'Play'), /Rate limited/);
  await backend.volume('Kitchen Echo', 20);
});

test('commands while not connected fail cleanly', async () => {
  const { backend } = setup();
  await assert.rejects(backend.volume('Kitchen Echo', 20), /not connected/);
});

test('push events update volume and trigger a player refresh', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.emit('ws-connect');
  fake.emit('ws-volume-change', { deviceSerialNumber: 'G0002', volume: 77 });
  assert.equal(backend.volumes.get('G0002'), 77);
  fake.emit('ws-media-change', { deviceSerialNumber: 'G0001' });
  await waitFor(() => events.player.length > 0);
  assert.deepEqual(events.player.at(-1), ['G0001', { state: 'PLAYING', title: 'Song', artist: 'Artist' }]);
  fake.emit('ws-media-change', { deviceSerialNumber: 'UNKNOWN' });
});

test('stop() shuts the library down and ignores late callbacks', async () => {
  const { backend, fakes, events, settings } = setup({ loginMode: 'proxy', saved: false });
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.LOGIN_REQUIRED);
  backend.stop();
  assert.equal(fakes[0].stopped, true);
  assert.equal(lastStatus(events).connection, CONNECTION.DISABLED);
  fakes[0].completeLogin();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastStatus(events).connection, CONNECTION.DISABLED, 'late login from a stopped instance is ignored');
});

test('sign in again forgets the saved login but keeps the former-data file', async (t) => {
  const { backend, fakes, events, authStore, dir, settings } = setup();
  t.after(() => backend.stop());
  fs.writeFileSync(authStore.formerDataStorePath, '{}');
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.CONNECTED);
  fakes.forEach((f) => { f.loginMode = 'proxy'; });
  backend.createAlexa = () => { const f = new FakeAlexa({ loginMode: 'proxy' }); fakes.push(f); return f; };
  backend.signInAgain();
  await waitFor(() => lastStatus(events).connection === CONNECTION.LOGIN_REQUIRED);
  assert.equal(authStore.load(), null);
  assert.ok(fs.existsSync(path.join(dir, 'alexa-former-data.json')));
});

test('open login page: opens the waiting login URL on the PC', async (t) => {
  const { backend, events, opened, settings } = setup({ loginMode: 'proxy', saved: false });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.LOGIN_REQUIRED);
  backend.openLoginPage();
  assert.deepEqual(opened, ['http://127.0.0.1:3456/']);
});

test('open login page: when already signed in it refuses and opens nothing', async (t) => {
  const { backend, events, opened, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.CONNECTED);
  assert.throws(() => backend.openLoginPage(), /Already signed in/);
  assert.deepEqual(opened, []);
});

test('open login page: after an error it reconnects, then opens the page once Amazon asks for a login', async (t) => {
  const { backend, fakes, events, opened, settings } = setup({ loginMode: 'fail', failError: new Error('401 Unauthorized') });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => lastStatus(events).connection === CONNECTION.ERROR);
  backend.createAlexa = () => { const f = new FakeAlexa({ loginMode: 'proxy' }); fakes.push(f); return f; };
  backend.openLoginPage();
  await waitFor(() => opened.length === 1);
  assert.equal(opened[0], 'http://127.0.0.1:3456/');
  assert.equal(fakes.length, 2, 'exactly one reconnect');
});

test('open login page: disabled backend gives a clear error', () => {
  const { backend } = setup();
  assert.throws(() => backend.openLoginPage(), /disabled/);
});

test('Amazon rate limit: clear message, new commands refused until the window ends', async (t) => {
  const { backend, fakes, events, settings } = setup({ responses: { sendSequenceCommand: FakeAlexa.RATE_LIMIT }, timeoutMs: 100 });
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const before = fakes[0].calls.length;

  await assert.rejects(backend.smartHomeOnOff('Kitchen Echo', 'Desk Lamp', 'On'), /rate limited by Amazon; the library retries it in about \d+ s/);
  assert.match(events.errors.at(-1), /Amazon is rate limiting commands/);
  assert.match(lastStatus(events).status, /paused for \d+ s/);
  assert.equal(lastStatus(events).connection, CONNECTION.CONNECTED);

  await assert.rejects(backend.volume('Kitchen Echo', 20), /Try again in \d+ s/);
  assert.equal(fakes[0].calls.length, before + 1, 'the refused command never reached Amazon');

  backend.throttledUntil = Date.now() - 1;
  fakes[0].responses = {};
  await backend.volume('Kitchen Echo', 20);
});

test('Do Not Disturb toggle reads the current state first', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;
  await backend.doNotDisturb('Kitchen Echo', 'Toggle'); // currently on -> off
  await backend.doNotDisturb('Office Dot', 'Toggle'); // currently off -> on
  await backend.doNotDisturb(ALL_ECHOS, 'Toggle'); // one is on -> all off
  const sets = fake.calls.filter((c) => c.name === 'setDoNotDisturb').map((c) => c.args);
  assert.deepEqual(sets, [['G0001', false], ['G0002', true], ['G0001', false], ['G0002', false]]);
  assert.equal(fake.calls.filter((c) => c.name === 'getDeviceStatusList').length, 3);
});

test('smart home toggle uses the reported power state, then falls back to the last state set', async (t) => {
  const { backend, fakes, events, settings } = setup();
  t.after(() => backend.stop());
  backend.start(settings);
  await waitFor(() => events.smarthome.length > 0);
  const fake = fakes[0];
  fake.calls.length = 0;
  const phrases = () => fake.calls.filter((c) => c.args[1] === 'textCommand').map((c) => c.args[2]);

  await backend.smartHomeOnOff('Kitchen Echo', 'Desk Lamp', 'Toggle'); // reports ON -> off
  assert.deepEqual(fake.calls.find((c) => c.name === 'querySmarthomeDevices').args, ['ent-lamp']);
  await assert.rejects(backend.smartHomeOnOff('Kitchen Echo', 'Fan', 'Toggle'), /use On or Off once/); // no state, no history
  await backend.smartHomeOnOff('Kitchen Echo', 'Fan', 'On');
  await backend.smartHomeOnOff('Kitchen Echo', 'Fan', 'Toggle'); // fallback: last set on -> off
  assert.deepEqual(phrases(), ['turn off Desk Lamp', 'turn on Fan', 'turn off Fan']);
});
