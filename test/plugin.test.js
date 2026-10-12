'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const path = require('path');

const { createPlugin } = require('../src/index');
const { TouchPortalClient } = require('../src/tp-client');
const { PLUGIN_ID, ACTIONS, DATA, STATES, CONNECTORS, CONNECTION, SETTINGS, NOTIFICATIONS, ALL_ECHOS, deviceStateId } = require('../src/ids');
const { tempDir, FakeAlexa, waitFor } = require('./helpers');

// A fake Touch Portal: a TCP server speaking the documented line protocol.
function fakeTouchPortal() {
  const received = [];
  let socket = null;
  const server = net.createServer((s) => {
    socket = s;
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        received.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        send: (obj) => socket.write(`${JSON.stringify(obj)}\n`),
        sendRaw: (text) => socket.write(text),
        close: () => new Promise((r) => { if (socket) socket.destroy(); server.close(r); }),
        states: (id) => received.filter((m) => m.type === 'stateUpdate' && m.id === id).map((m) => m.value),
        settings: (name) => received.filter((m) => m.type === 'settingUpdate' && m.name === name).map((m) => m.value),
        notifications: () => received.filter((m) => m.type === 'showNotification'),
        choices: (id) => received.filter((m) => m.type === 'choiceUpdate' && m.id === id).map((m) => m.value),
      });
    });
  });
}

async function startPlugin({ settings, fetchImpl, loginMode = 'saved', pluginDir = tempDir(), dataDir = tempDir() } = {}) {
  const tpServer = await fakeTouchPortal();
  const opened = [];
  const fakes = [];
  let exitCode = null;
  const plugin = createPlugin({
    pluginDir,
    dataDir,
    openBrowser: (url) => { opened.push(url); return { command: 'fake', args: [url] }; },
    createClient: () => new TouchPortalClient({ pluginId: PLUGIN_ID, port: tpServer.port }),
    createAlexa: () => { const f = new FakeAlexa({ loginMode }); fakes.push(f); return f; },
    fetchImpl,
    exit: (code) => { exitCode = code; },
  });
  plugin.alexa.queue.minGapMs = 0;
  plugin.start();
  await waitFor(() => tpServer.received.some((m) => m.type === 'pair'));
  assert.deepEqual(tpServer.received[0], { type: 'pair', id: PLUGIN_ID });
  // The info message is split across two writes to exercise line buffering.
  const info = JSON.stringify({ type: 'info', sdkVersion: 10, tpVersionString: '4.4.3', settings: settings || [] });
  tpServer.sendRaw(info.slice(0, 20));
  tpServer.sendRaw(`${info.slice(20)}\n`);
  return { tpServer, plugin, fakes, pluginDir, dataDir, opened, exitCode: () => exitCode };
}

// Lists load in order (devices, routines, smart home), so the real smart home
// list arriving means everything is loaded. The initial "(none)" does not count.
function listsLoaded(tpServer) {
  return waitFor(() => (tpServer.choices(DATA.SMART_DEVICE).at(-1) || []).includes('Desk Lamp'));
}

test('pairs, applies settings, connects Alexa and publishes lists and states', async (t) => {
  const { tpServer, plugin } = await startPlugin();
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });

  await waitFor(() => tpServer.states(STATES.CONNECTION).includes(CONNECTION.CONNECTED));
  await listsLoaded(tpServer);
  assert.deepEqual(tpServer.choices(DATA.DEVICE_OR_ALL).at(-1), [ALL_ECHOS, 'Kitchen Echo', 'Office Dot']);
  assert.deepEqual(tpServer.choices(DATA.DEVICE).at(-1), ['Kitchen Echo', 'Office Dot']);
  assert.deepEqual(tpServer.choices(DATA.ROUTINE).at(-1), ['"movie time"', 'Good night']);
  assert.deepEqual(tpServer.choices(DATA.SMART_DEVICE).at(-1), ['Desk Lamp', 'Fan']);
  assert.equal(tpServer.states(STATES.DEVICE_COUNT).at(-1), '2');

  const created = tpServer.received.filter((m) => m.type === 'createState').map((m) => m.id);
  assert.ok(created.includes(deviceStateId('G0001', 'volume')));
  assert.ok(created.includes(deviceStateId('G0002', 'title')));
  await waitFor(() => tpServer.states(deviceStateId('G0001', 'volume')).includes('40'));

  const conn = tpServer.received.find((m) => m.type === 'connectorUpdate');
  assert.equal(conn.connectorId, `pc_${PLUGIN_ID}_${CONNECTORS.VOLUME}|${DATA.CONN_DEVICE}=Kitchen Echo`);
  assert.ok(conn.connectorId.length <= 200);
});

test('actions reach Alexa; failures become a last-error state, not a crash', async (t) => {
  const { tpServer, plugin, fakes } = await startPlugin();
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await listsLoaded(tpServer);
  fakes[0].calls.length = 0;

  tpServer.send({ type: 'action', pluginId: PLUGIN_ID, actionId: ACTIONS.SPEAK, data: [
    { id: DATA.DEVICE_OR_ALL, value: 'Kitchen Echo' }, { id: DATA.SPEAK_MODE, value: 'Speak' }, { id: DATA.TEXT, value: 'Hello there' },
  ] });
  await waitFor(() => fakes[0].calls.some((c) => c.args[1] === 'speak'));

  tpServer.send({ type: 'action', pluginId: PLUGIN_ID, actionId: ACTIONS.SET_VOLUME, data: [
    { id: DATA.DEVICE_OR_ALL, value: 'Nonexistent' }, { id: DATA.VOLUME, value: '30' },
  ] });
  await waitFor(() => tpServer.states(STATES.LAST_ERROR).some((v) => /Unknown Echo "Nonexistent"/.test(v)));

  tpServer.send({ type: 'action', pluginId: PLUGIN_ID, actionId: 'something.unknown', data: [] });
  tpServer.sendRaw('this is not json\n');
  tpServer.send({ type: 'action', pluginId: PLUGIN_ID, actionId: ACTIONS.MEDIA, data: [
    { id: DATA.DEVICE, value: 'Office Dot' }, { id: DATA.MEDIA_COMMAND, value: 'Next' },
  ] });
  await waitFor(() => fakes[0].calls.some((c) => c.name === 'sendCommand' && c.args[1] === 'next'));
});

test('volume slider: only the last value of a drag is sent', async (t) => {
  const { tpServer, plugin, fakes } = await startPlugin();
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await listsLoaded(tpServer);
  fakes[0].calls.length = 0;

  for (const value of [10, 20, 30, 42]) {
    tpServer.send({ type: 'connectorChange', pluginId: PLUGIN_ID, connectorId: CONNECTORS.VOLUME, value, data: [{ id: DATA.CONN_DEVICE, value: 'Office Dot' }] });
  }
  await waitFor(() => fakes[0].calls.some((c) => c.args[1] === 'volume'), { timeoutMs: 3000 });
  await new Promise((r) => setTimeout(r, 400));
  const volumeCalls = fakes[0].calls.filter((c) => c.args[1] === 'volume');
  assert.deepEqual(volumeCalls.map((c) => c.args[2]), [42]);
});

test('login flow is shown in states; settings change can turn Alexa off', async (t) => {
  const { tpServer, plugin } = await startPlugin({ loginMode: 'proxy' });
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await waitFor(() => tpServer.states(STATES.LOGIN_URL).includes('http://127.0.0.1:3456/'));
  assert.ok(tpServer.states(STATES.CONNECTION).includes(CONNECTION.LOGIN_REQUIRED));

  tpServer.send({ type: 'settings', values: [{ 'Alexa backend enabled': 'Off' }] });
  await waitFor(() => tpServer.states(STATES.CONNECTION).at(-1) === CONNECTION.DISABLED);
});

test('Voice Monkey action uses the token from settings and never logs it', async (t) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"success":true,"data":"OK"}' }; };
  const token = 'vm-secret-token-987654';
  const { tpServer, plugin, pluginDir } = await startPlugin({
    fetchImpl,
    settings: [{ 'Alexa backend enabled': 'Off' }, { 'Voice Monkey enabled': 'On' }, { 'Voice Monkey token': token }, { 'Log level': 'debug' }],
  });
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await waitFor(() => tpServer.states(STATES.VM_STATUS).includes('Ready'));

  tpServer.send({ type: 'action', pluginId: PLUGIN_ID, actionId: ACTIONS.VM_TRIGGER, data: [{ id: DATA.VM_DEVICE, value: 'trigger-1' }] });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  await waitFor(() => tpServer.states(STATES.VM_STATUS).some((s) => s.startsWith('OK')));

  plugin.logger.info(`echo of the token ${token} must be masked`);
  const log = fs.readFileSync(path.join(pluginDir, 'logs', 'plugin.log'), 'utf8');
  assert.ok(!log.includes(token), 'token leaked into the log');
});

test('closePlugin shuts down gracefully', async () => {
  const { tpServer, plugin, fakes, exitCode } = await startPlugin();
  await waitFor(() => fakes.length === 1 && fakes[0].serialNumbers.G0001);
  tpServer.send({ type: 'closePlugin', pluginId: PLUGIN_ID });
  await waitFor(() => exitCode() === 0, { timeoutMs: 2000 });
  assert.equal(fakes[0].stopped, true);
  assert.equal(plugin.alexa.queue.closed, true);
  await tpServer.close();
});

test('settings page shows "Alexa connection" as Connected / Disconnected', async (t) => {
  const { tpServer, plugin } = await startPlugin();
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await waitFor(() => tpServer.settings(SETTINGS.CONNECTION_STATUS).includes('Connected'));
  assert.equal(tpServer.settings(SETTINGS.LOGIN_PAGE).at(-1), '(not needed)');

  tpServer.send({ type: 'settings', values: [{ 'Alexa backend enabled': 'Off' }] });
  await waitFor(() => tpServer.settings(SETTINGS.CONNECTION_STATUS).at(-1) === 'Off (Alexa backend is disabled)');
});

test('login needed: settings show it, a notification offers "Open login page", clicking it opens the page', async (t) => {
  const { tpServer, plugin, opened } = await startPlugin({ loginMode: 'proxy' });
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await waitFor(() => tpServer.notifications().length === 1);
  assert.match(tpServer.settings(SETTINGS.CONNECTION_STATUS).at(-1), /^Disconnected: Amazon login needed/);
  assert.equal(tpServer.settings(SETTINGS.LOGIN_PAGE).at(-1), 'http://127.0.0.1:3456/');
  const note = tpServer.notifications()[0];
  assert.equal(note.notificationId, NOTIFICATIONS.LOGIN);
  assert.deepEqual(note.options, [{ id: NOTIFICATIONS.OPEN_LOGIN_OPTION, title: 'Open login page' }]);

  tpServer.send({ type: 'notificationOptionClicked', notificationId: NOTIFICATIONS.LOGIN, optionId: NOTIFICATIONS.OPEN_LOGIN_OPTION });
  await waitFor(() => opened.length === 1);
  assert.equal(opened[0], 'http://127.0.0.1:3456/');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tpServer.notifications().length, 1, 'no repeat notification while still waiting');
});

test('login saved in the plugin folder by an older version is moved to the data folder and used', async (t) => {
  const pluginDir = tempDir();
  const dataDir = tempDir();
  fs.mkdirSync(path.join(pluginDir, 'data'));
  fs.writeFileSync(path.join(pluginDir, 'data', 'alexa-auth.json'), JSON.stringify({ amazonPage: 'amazon.com', cookieData: { localCookie: 'x', macDms: {} } }));
  const { tpServer, plugin, fakes } = await startPlugin({ pluginDir, dataDir });
  t.after(async () => { plugin.shutdown('test end'); await tpServer.close(); });
  await waitFor(() => fakes.length === 1 && fakes[0].options);
  assert.ok(fs.existsSync(path.join(dataDir, 'alexa-auth.json')));
  assert.ok(!fs.existsSync(path.join(pluginDir, 'data', 'alexa-auth.json')));
  assert.equal(fakes[0].options.cookie.localCookie, 'x', 'migrated login handed to the library');
});
