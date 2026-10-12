'use strict';

const path = require('path');
const os = require('os');
const ids = require('./ids');
const { Logger } = require('./logger');
const { addSecret } = require('./redact');
const { parseSettings } = require('./settings');
const { TouchPortalOut } = require('./tp');
const { TouchPortalClient, loadConnectionConfig } = require('./tp-client');
const { AuthStore } = require('./alexa/auth-store');
const { AlexaBackend } = require('./alexa/backend');
const { VoiceMonkey } = require('./voicemonkey');
const { ActionDispatcher } = require('./actions');

const { STATES, DATA, CONNECTORS, CONNECTION, SETTINGS, NOTIFICATIONS, ALL_ECHOS, PLUGIN_ID, deviceStateId } = ids;

// The saved Amazon login lives outside the plugin folder, because Touch Portal
// deletes and recreates the plugin folder when the plugin is re-imported.
// Windows: %APPDATA%\AlexaControl-TouchPortal
function defaultDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'AlexaControl-TouchPortal');
  return path.join(os.homedir(), '.alexacontrol-touchportal');
}

// Builds the whole plugin. Dependencies can be swapped for tests.
function createPlugin({
  pluginDir = path.resolve(__dirname, '..'),
  dataDir = defaultDataDir(),
  openBrowser,
  createClient,
  createAlexa,
  fetchImpl,
  exit = (code) => process.exit(code),
  echoLog = false,
} = {}) {
  const logger = new Logger({ dir: path.join(pluginDir, 'logs'), echo: echoLog });
  const client = createClient
    ? createClient()
    : new TouchPortalClient({ pluginId: PLUGIN_ID, logger, ...loadConnectionConfig(pluginDir) });
  const tp = new TouchPortalOut(client, logger);
  const authStore = new AuthStore(dataDir);
  try {
    const moved = authStore.migrateFrom(path.join(pluginDir, 'data'));
    if (moved.length > 0) logger.info(`Moved ${moved.join(', ')} from the plugin folder to ${dataDir}`);
  } catch (err) {
    logger.warn('Could not move old login files:', err.message);
  }
  const alexa = new AlexaBackend({ logger, authStore, createAlexa, ...(openBrowser ? { openBrowser } : {}) });
  const vm = new VoiceMonkey({ logger, fetchImpl, onStatus: (text) => tp.state(STATES.VM_STATUS, text) });

  let settings = null;
  let shuttingDown = false;
  let deviceNames = new Map(); // serial -> name

  const reportError = (context, err) => {
    const message = `${context}: ${err && err.message ? err.message : String(err)}`;
    logger.warn(message);
    tp.state(STATES.LAST_ERROR, `${timeOfDay()} ${message}`);
  };

  const dispatcher = new ActionDispatcher({ alexa, voiceMonkey: vm, tpOut: tp, logger, onError: reportError });

  // ------------------------------------------------ backend -> Touch Portal

  let lastConnection = null;
  alexa.on('status', ({ connection, status, loginUrl }) => {
    tp.state(STATES.CONNECTION, connection);
    tp.state(STATES.STATUS, status);
    tp.state(STATES.LOGIN_URL, loginUrl || '');
    tp.setting(SETTINGS.CONNECTION_STATUS, connectionSummary(connection, status));
    tp.setting(SETTINGS.LOGIN_PAGE, loginUrl || '(not needed)');
    if (connection === CONNECTION.LOGIN_REQUIRED && lastConnection !== CONNECTION.LOGIN_REQUIRED) {
      tp.notify(
        NOTIFICATIONS.LOGIN,
        'Alexa Control: Amazon login needed',
        `Sign in to Amazon so the plugin can control your Echo devices. The login page opens in a browser on this PC (${loginUrl}).`,
        [{ id: NOTIFICATIONS.OPEN_LOGIN_OPTION, title: 'Open login page' }],
      );
    }
    lastConnection = connection;
  });
  alexa.on('error-text', (message) => tp.state(STATES.LAST_ERROR, `${timeOfDay()} ${message}`));
  alexa.on('push', (text) => tp.state(STATES.PUSH, text));

  alexa.on('devices', (devices) => {
    const names = devices.map((d) => d.name);
    tp.choices(DATA.DEVICE_OR_ALL, [ALL_ECHOS, ...names]);
    tp.choices(DATA.DEVICE, names);
    tp.choices(DATA.CONN_DEVICE, names);
    tp.state(STATES.DEVICE_COUNT, String(devices.length));

    const next = new Map(devices.map((d) => [d.serial, d.name]));
    for (const [serial] of deviceNames) {
      if (!next.has(serial)) {
        for (const field of ['volume', 'title', 'artist', 'player']) tp.removeState(deviceStateId(serial, field));
      }
    }
    for (const d of devices) {
      const group = `Alexa: ${d.name}`;
      tp.createState(deviceStateId(d.serial, 'volume'), `${d.name} volume`, '', group);
      tp.createState(deviceStateId(d.serial, 'title'), `${d.name} now playing title`, '', group);
      tp.createState(deviceStateId(d.serial, 'artist'), `${d.name} now playing artist`, '', group);
      tp.createState(deviceStateId(d.serial, 'player'), `${d.name} player state`, '', group);
    }
    deviceNames = next;
  });
  alexa.on('routines', (names) => tp.choices(DATA.ROUTINE, names));
  alexa.on('smarthome', (names) => tp.choices(DATA.SMART_DEVICE, names));

  alexa.on('volume', (serial, volume) => {
    tp.state(deviceStateId(serial, 'volume'), String(volume));
    const name = deviceNames.get(serial);
    if (name) tp.connector(CONNECTORS.VOLUME, [{ id: DATA.CONN_DEVICE, value: name }], volume);
  });
  alexa.on('player', (serial, info) => {
    tp.state(deviceStateId(serial, 'title'), info.title);
    tp.state(deviceStateId(serial, 'artist'), info.artist);
    tp.state(deviceStateId(serial, 'player'), info.state);
  });

  // ------------------------------------------------ settings

  function applySettings(raw) {
    const next = parseSettings(raw);
    logger.setLevel(next.logLevel);
    addSecret(next.vmToken);
    vm.configure({ enabled: next.vmEnabled, token: next.vmToken });

    const prev = settings;
    settings = next;
    const alexaChanged = !prev
      || prev.alexaEnabled !== next.alexaEnabled
      || prev.region.amazonPage !== next.region.amazonPage
      || prev.proxyAddress !== next.proxyAddress
      || prev.proxyPort !== next.proxyPort;
    if (!alexaChanged) return;

    if (next.alexaEnabled) {
      logger.info(`Starting Alexa backend (${next.region.label})`);
      alexa.start(next);
    } else {
      alexa.settings = null;
      alexa.stop(true);
    }
  }

  // ------------------------------------------------ Touch Portal -> plugin

  client.on('info', (info) => {
    logger.info(`Paired with Touch Portal ${info.tpVersionString || ''} (API ${info.sdkVersion || '?'})`);
    tp.setConnected(true);
    tp.state(STATES.CONNECTION, CONNECTION.DISABLED);
    tp.state(STATES.STATUS, 'Waiting for settings');
    tp.state(STATES.LAST_ERROR, '');
    tp.state(STATES.PUSH, 'Off');
    tp.state(STATES.DEVICE_COUNT, '0');
    for (const id of [DATA.DEVICE_OR_ALL, DATA.DEVICE, DATA.CONN_DEVICE, DATA.ROUTINE, DATA.SMART_DEVICE]) {
      tp.choices(id, id === DATA.DEVICE_OR_ALL ? [ALL_ECHOS] : []);
    }
    // The info message carries the current settings (or none on a fresh install).
    try {
      applySettings(info.settings || []);
    } catch (err) {
      reportError('Applying settings', err);
    }
  });
  client.on('settings', (values) => {
    try {
      applySettings(values);
    } catch (err) {
      reportError('Applying settings', err);
    }
  });
  // No action defines hold behaviour, so only plain "action" messages matter.
  client.on('action', (message) => dispatcher.handleAction(message));
  client.on('connectorChange', (message) => dispatcher.handleConnector(message));
  client.on('shortConnectorIdNotification', (message) => tp.rememberShortId(message.connectorId, message.shortId));
  client.on('broadcast', (message) => {
    if (message.event === 'pageChange') tp.resendStates();
  });
  client.on('notificationOptionClicked', (message) => {
    if (message.notificationId !== NOTIFICATIONS.LOGIN || message.optionId !== NOTIFICATIONS.OPEN_LOGIN_OPTION) return;
    try {
      alexa.openLoginPage();
    } catch (err) {
      reportError('Open login page', err);
    }
  });
  client.on('closePlugin', () => shutdown('Touch Portal asked the plugin to close'));
  client.on('disconnected', () => shutdown('Lost connection to Touch Portal'));
  client.on('error', (err) => logger.warn('Touch Portal socket error:', err && err.message));

  // ------------------------------------------------ lifecycle

  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down: ${reason}`);
    dispatcher.stop();
    try {
      alexa.stop(false);
      alexa.queue.close();
    } catch (err) {
      logger.warn('Error while stopping Alexa backend:', err.message);
    }
    tp.setConnected(false);
    try {
      client.disconnect();
    } catch {
      // Socket already gone.
    }
    // Touch Portal hard-kills the process about 500 ms after closePlugin.
    setTimeout(() => exit(0), 200).unref();
  }

  function start() {
    logger.info(`Alexa Control plugin starting (Node ${process.version}, folder ${pluginDir}, data ${dataDir})`);
    client.connect();
  }

  return { start, shutdown, applySettings, logger, client, tp, alexa, vm, dispatcher, reportError };
}

// Short text for the "Alexa connection" setting on the settings page.
function connectionSummary(connection, status) {
  switch (connection) {
    case CONNECTION.CONNECTED:
      return /paused/.test(status) ? `Connected (${status.replace(/^Connected, /, '')})` : 'Connected';
    case CONNECTION.CONNECTING:
      return 'Connecting...';
    case CONNECTION.LOGIN_REQUIRED:
      return 'Disconnected: Amazon login needed (use "Open Amazon login page")';
    case CONNECTION.ERROR:
      return `Disconnected: ${status}`;
    default:
      return 'Off (Alexa backend is disabled)';
  }
}

function timeOfDay() {
  return new Date().toTimeString().slice(0, 8);
}

function main() {
  const plugin = createPlugin();
  process.on('uncaughtException', (err) => plugin.reportError('Unexpected error', err));
  process.on('unhandledRejection', (err) => plugin.reportError('Unhandled promise', err));
  process.on('SIGINT', () => plugin.shutdown('SIGINT'));
  process.on('SIGTERM', () => plugin.shutdown('SIGTERM'));
  plugin.start();
}

if (require.main === module) main();

module.exports = { createPlugin, defaultDataDir, connectionSummary };
