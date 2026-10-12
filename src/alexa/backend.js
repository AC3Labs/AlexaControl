'use strict';

const EventEmitter = require('events');
const { CONNECTION, ALL_ECHOS } = require('../ids');
const { RateLimitedQueue } = require('../queue');
const { openUrl } = require('../open-url');
const parse = require('./parse');

// Errors that mean "network trouble", which is worth a few slow retries.
// Anything else (bad login, Amazon refusing us) is never retried
// automatically, because repeated logins get accounts blocked.
const NETWORK_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|timed out/i;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

// Smart home volume taps (Roku TVs): Amazon rejects bursts of commands
// about a second apart, so taps wait in a short line and go out this far
// apart. Extra taps beyond the line are ignored.
const VOLUME_TAP_GAP_MS = 2000;
const VOLUME_TAP_MAX_WAITING = 3;
const RATE_LIMIT_BODY = /Rate exceeded|Too many requests|ThrottlingException/i;

const MEDIA_COMMANDS = { Play: 'play', Pause: 'pause', Next: 'next', Previous: 'previous' };

// Backend A: Amazon Alexa through the unofficial alexa-remote2 library.
//
// Emits:
//   'status'     { connection, status, loginUrl }
//   'error-text' message           last error, for the "last error" state
//   'push'       text              push connection status
//   'devices'    [{ serial, name }]
//   'routines'   [names]
//   'smarthome'  [names]
//   'volume'     serial, volume
//   'player'     serial, { state, title, artist }
class AlexaBackend extends EventEmitter {
  constructor({ logger, authStore, createAlexa, queue, openBrowser = openUrl, timing = {} }) {
    super();
    this.log = logger;
    this.authStore = authStore;
    this.openBrowser = openBrowser;
    this.loginUrl = '';
    this.throttledUntil = 0;
    this.throttleTimer = null;
    this.openLoginWhenReady = false;
    this.createAlexa = createAlexa || (() => new (require('alexa-remote2'))());
    // Amazon throttled us at 4 commands in about 6 seconds during testing,
    // so commands are spaced at least one second apart.
    this.queue = queue || new RateLimitedQueue({ minGapMs: 1000, maxPending: 20, defaultTimeoutMs: 15000 });
    this.timing = {
      pollTickMs: 5000,
      volumePollMs: 60000,
      playerDebounceMs: 1500,
      initWatchdogMs: 120000,
      listTimeoutMs: 35000,
      volumeTapGapMs: VOLUME_TAP_GAP_MS,
      ...timing,
    };

    this.alexa = null;
    this.settings = null;
    this.generation = 0;
    this.connection = CONNECTION.DISABLED;
    this.retryIndex = 0;
    this.timers = new Set();
    this.retryTimer = null;
    this.watchdog = null;
    this.pollTimer = null;
    this.pollCursor = 0;
    this.volumeLines = new Map();
    this.lastVolumePoll = 0;
    this.pushConnected = false;
    this.playerTimers = new Map();

    this.devices = [];
    this.byName = new Map();
    this.bySerial = new Map();
    this.routines = new Map();
    this.smartHome = [];
    this.smartHomeByName = new Map();
    this.lastPowerSet = new Map(); // smart home name -> true/false the plugin last sent
    this.volumes = new Map();
  }

  // ---------------------------------------------------------------- status

  setStatus(connection, status, loginUrl = '') {
    this.connection = connection;
    this.loginUrl = loginUrl;
    this.emit('status', { connection, status, loginUrl });
    this.log.info(`Alexa status: ${connection} - ${status}`);
  }

  reportError(context, err) {
    const message = `${context}: ${err && err.message ? err.message : String(err)}`;
    this.log.warn(message);
    this.emit('error-text', message);
    return message;
  }

  get isConnected() {
    return this.connection === CONNECTION.CONNECTED && this.alexa !== null;
  }

  // ---------------------------------------------------------------- lifecycle

  start(settings) {
    this.stop(false);
    this.settings = settings;
    const gen = ++this.generation;
    const region = settings.region;

    let saved = this.authStore.load();
    if (saved && saved.amazonPage && saved.amazonPage !== region.amazonPage) {
      this.log.warn(`Saved login is for ${saved.amazonPage} but region is ${region.amazonPage}; a new login is needed.`);
      saved = null;
    }

    this.setStatus(CONNECTION.CONNECTING, saved ? 'Connecting to Amazon with saved login...' : 'Starting Amazon login...');

    let alexa;
    try {
      alexa = this.createAlexa();
    } catch (err) {
      this.setStatus(CONNECTION.ERROR, this.reportError('Could not load alexa-remote2', err));
      return;
    }
    this.alexa = alexa;
    this.attachLibraryEvents(alexa, gen);

    const localOnly = ['127.0.0.1', 'localhost'].includes(settings.proxyAddress);
    const options = {
      cookie: saved ? saved.cookieData : undefined,
      proxyOnly: true,
      setupProxy: true,
      proxyOwnIp: settings.proxyAddress,
      proxyPort: settings.proxyPort,
      // Only listen on the network when the user chose a LAN address.
      proxyListenBind: localOnly ? '127.0.0.1' : '0.0.0.0',
      proxyLogLevel: 'warn',
      amazonPage: region.amazonPage,
      baseAmazonPage: region.baseAmazonPage,
      acceptLanguage: region.acceptLanguage,
      amazonPageProxyLanguage: region.proxyLanguage,
      formerDataStorePath: this.authStore.formerDataStorePath,
      usePushConnection: true,
      bluetooth: false,
      logger: (...args) => this.onLibraryLog(gen, args),
    };

    this.armWatchdog(gen);
    try {
      alexa.init(options, (err) => this.onInitResult(gen, err));
    } catch (err) {
      this.onInitResult(gen, err);
    }
  }

  // Stops everything. Safe to call more than once.
  stop(reportDisabled = true) {
    this.generation += 1;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const t of this.playerTimers.values()) clearTimeout(t);
    this.playerTimers.clear();
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    clearTimeout(this.throttleTimer);
    this.throttledUntil = 0;
    clearInterval(this.pollTimer);
    this.retryTimer = null;
    this.watchdog = null;
    this.pollTimer = null;
    this.queue.clear('Alexa backend stopped');
    this.clearVolumeLines();
    this.pushConnected = false;

    const alexa = this.alexa;
    this.alexa = null;
    if (alexa) {
      try {
        alexa.removeAllListeners();
        alexa.stop();
      } catch (err) {
        this.log.debug('alexa.stop failed:', err.message);
      }
      try {
        if (alexa.alexaCookie && typeof alexa.alexaCookie.stopProxyServer === 'function') {
          alexa.alexaCookie.stopProxyServer();
        }
      } catch (err) {
        this.log.debug('stopProxyServer failed:', err.message);
      }
    }
    if (reportDisabled) this.setStatus(CONNECTION.DISABLED, 'Alexa backend is off');
    this.emit('push', 'Off');
  }

  // Forget the saved login and start a fresh browser login.
  signInAgain() {
    if (!this.settings) throw new Error('Alexa backend is disabled in the plugin settings');
    this.openLoginWhenReady = false;
    this.stop(false);
    this.authStore.clear();
    this.retryIndex = 0;
    this.start(this.settings);
  }

  // "Open Amazon login page" button. The page opens in the browser of the PC
  // running Touch Portal. If no login is waiting, reconnect first and open the
  // page automatically if Amazon asks for one.
  openLoginPage() {
    if (!this.settings) throw new Error('Alexa backend is disabled in the plugin settings');
    if (this.connection === CONNECTION.CONNECTED) {
      throw new Error('Already signed in to Amazon. Use "Sign in to Amazon again" to switch accounts.');
    }
    if (this.connection === CONNECTION.LOGIN_REQUIRED && this.loginUrl) {
      this.openLoginUrl();
      return;
    }
    this.openLoginWhenReady = true;
    if (this.connection !== CONNECTION.CONNECTING) this.reconnect();
  }

  openLoginUrl() {
    const opened = this.openBrowser(this.loginUrl);
    this.log.info(`Opened the Amazon login page on this PC (${opened.command})`);
  }

  // Manual reconnect with the saved login.
  reconnect() {
    if (!this.settings) throw new Error('Alexa backend is disabled in the plugin settings');
    this.retryIndex = 0;
    this.start(this.settings);
  }

  armWatchdog(gen) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (gen !== this.generation) return;
      if (this.connection === CONNECTION.CONNECTING) {
        this.setStatus(CONNECTION.ERROR, 'Amazon did not answer within 2 minutes. Use "Reconnect" to try again.');
        this.emit('error-text', 'Login timed out');
      }
    }, this.timing.initWatchdogMs);
  }

  // Library log lines go to our debug log. One of them is the only signal
  // that Amazon rate limited a request: the library then waits 10 to 63
  // seconds and retries that request once on its own (this cannot be turned
  // off). While that window lasts, new commands are refused right away so
  // they do not pile up and fire late.
  onLibraryLog(gen, args) {
    this.log.debug('[alexa-remote2]', ...args);
    if (gen !== this.generation) return;
    const match = /rate exceeded response \.\.\. Retrying once in (\d+)ms/i.exec(args.map(String).join(' '));
    if (match) this.onRateLimited(Number(match[1]));
  }

  onRateLimited(delayMs) {
    this.throttledUntil = Math.max(this.throttledUntil, Date.now() + delayMs + 2000);
    const seconds = Math.ceil((this.throttledUntil - Date.now()) / 1000);
    this.emit('error-text', `Amazon is rate limiting commands. The last command will be retried by the library in about ${seconds} s; new commands are paused until then.`);
    this.emit('status', { connection: this.connection, status: `Connected, paused for ${seconds} s (Amazon rate limit)`, loginUrl: this.loginUrl });
    clearTimeout(this.throttleTimer);
    this.throttleTimer = setTimeout(() => {
      if (this.connection === CONNECTION.CONNECTED) this.emit('status', { connection: this.connection, status: 'Connected to Amazon', loginUrl: '' });
    }, this.throttledUntil - Date.now());
  }

  get throttleSecondsLeft() {
    return Math.max(0, Math.ceil((this.throttledUntil - Date.now()) / 1000));
  }

  // alexa.init calls back more than once:
  // 1. with an Error whose message holds the proxy URL when a login is needed
  // 2. with no error once logged in (and again after each automatic cookie
  //    refresh, every few days)
  onInitResult(gen, err) {
    if (gen !== this.generation) return;
    if (err) {
      const url = parse.extractProxyUrl(err.message);
      if (url) {
        clearTimeout(this.watchdog);
        this.setStatus(CONNECTION.LOGIN_REQUIRED, `Open ${url} in a browser on this PC and sign in to Amazon`, url);
        if (this.openLoginWhenReady) {
          this.openLoginWhenReady = false;
          this.openLoginUrl();
        }
        return;
      }
      clearTimeout(this.watchdog);
      const message = this.reportError('Amazon login failed', err);
      if (NETWORK_ERROR.test(message) && this.retryIndex < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[this.retryIndex];
        this.retryIndex += 1;
        this.setStatus(CONNECTION.ERROR, `Network problem, retrying in ${Math.round(delay / 60000)} min (try ${this.retryIndex} of ${RETRY_DELAYS_MS.length})`);
        this.retryTimer = setTimeout(() => {
          if (gen === this.generation && this.settings) this.start(this.settings);
        }, delay);
      } else {
        this.setStatus(CONNECTION.ERROR, `${message}. Use "Reconnect" or "Sign in again".`);
      }
      return;
    }

    clearTimeout(this.watchdog);
    this.retryIndex = 0;
    this.saveLogin();
    this.setStatus(CONNECTION.CONNECTED, 'Connected to Amazon');
    this.loadDevicesFromLibrary();
    this.startPolling(gen);
    this.refreshLists('All').catch((e) => this.reportError('Refreshing lists', e));
  }

  saveLogin() {
    const alexa = this.alexa;
    if (!alexa || !alexa.cookieData || !this.settings) return;
    try {
      if (this.authStore.save(this.settings.region.amazonPage, alexa.cookieData)) {
        this.log.info('Saved Amazon login to the data folder');
      }
    } catch (err) {
      this.reportError('Could not save login', err);
    }
  }

  attachLibraryEvents(alexa, gen) {
    const current = () => gen === this.generation;
    // Fired whenever the library sets or refreshes its cookie.
    alexa.on('cookie', () => {
      if (current() && this.connection === CONNECTION.CONNECTED) this.saveLogin();
    });
    alexa.on('ws-connect', () => {
      if (!current()) return;
      this.pushConnected = true;
      this.emit('push', 'Connected');
    });
    alexa.on('ws-disconnect', (retries) => {
      if (!current()) return;
      this.pushConnected = false;
      this.emit('push', retries ? `Disconnected, library retrying (${retries})` : 'Disconnected');
    });
    alexa.on('ws-error', (error) => {
      if (current()) this.log.debug('Push connection error:', error && error.message ? error.message : error);
    });
    alexa.on('ws-volume-change', (p) => {
      if (current() && p && p.deviceSerialNumber) this.setVolume(p.deviceSerialNumber, p.volume);
    });
    for (const event of ['ws-media-change', 'ws-audio-player-state-change', 'ws-media-queue-change']) {
      alexa.on(event, (p) => {
        if (current() && p && p.deviceSerialNumber) this.schedulePlayerRefresh(p.deviceSerialNumber);
      });
    }
  }

  // ---------------------------------------------------------------- calls

  // Every Amazon call goes through the rate limited queue with a timeout.
  call(name, fn, timeoutMs) {
    if (!this.isConnected) {
      return Promise.reject(new Error(`Alexa is not connected (${this.connection})`));
    }
    if (this.throttleSecondsLeft > 0) {
      return Promise.reject(new Error(`Amazon is rate limiting commands. Try again in ${this.throttleSecondsLeft} s.`));
    }
    const alexa = this.alexa;
    return this.queue.add(name, (cb) => fn(alexa, cb), timeoutMs).catch((err) => {
      // A timeout during a rate limit window means the library is holding
      // this command for its own retry, so say that instead of "timed out".
      if (err && err.name === 'TimeoutError' && this.throttleSecondsLeft > 0) {
        throw new Error(`${name} was rate limited by Amazon; the library retries it in about ${this.throttleSecondsLeft} s`);
      }
      throw err;
    });
  }

  ensureConnected() {
    if (!this.isConnected) throw new Error(`Alexa is not connected (${this.connection})`);
  }

  device(name) {
    this.ensureConnected();
    const dev = this.byName.get(name);
    if (!dev) throw new Error(`Unknown Echo "${name}". Run "Refresh lists" and pick it again.`);
    return dev;
  }

  targets(nameOrAll) {
    this.ensureConnected();
    if (nameOrAll === ALL_ECHOS) {
      if (this.devices.length === 0) throw new Error('No Echo devices found yet');
      return this.devices;
    }
    return [this.device(nameOrAll)];
  }

  // ---------------------------------------------------------------- lists

  loadDevicesFromLibrary() {
    const list = parse.extractEchoDevices(this.alexa ? this.alexa.serialNumbers : {});
    this.devices = list;
    this.byName = new Map(list.map((d) => [d.name, d]));
    this.bySerial = new Map(list.map((d) => [d.serial, d]));
    this.log.info(`Found ${list.length} Echo device(s)`);
    this.emit('devices', list);
  }

  async refreshLists(what = 'All') {
    const errors = [];
    if (what === 'All' || what === 'Echo devices') {
      try {
        await this.call('initDeviceState', (a, cb) => a.initDeviceState(cb), this.timing.listTimeoutMs);
        this.loadDevicesFromLibrary();
        await this.refreshVolumes();
      } catch (err) {
        errors.push(this.reportError('Refreshing Echo devices', err));
      }
    }
    if (what === 'All' || what === 'Routines') {
      try {
        const res = await this.call('getAutomationRoutines', (a, cb) => a.getAutomationRoutines(cb), this.timing.listTimeoutMs);
        const routines = parse.extractRoutines(res);
        this.routines = new Map(routines.map((r) => [r.name, r.routine]));
        this.log.info(`Found ${routines.length} routine(s)`);
        this.emit('routines', routines.map((r) => r.name));
      } catch (err) {
        errors.push(this.reportError('Refreshing routines', err));
      }
    }
    if (what === 'All' || what === 'Smart home devices') {
      try {
        const res = await this.call('getSmarthomeDevicesV2', (a, cb) => a.getSmarthomeDevicesV2(cb), this.timing.listTimeoutMs);
        const devices = parse.extractSmartHomeDevices(res);
        this.smartHome = devices.map((d) => d.name);
        this.smartHomeByName = new Map(devices.map((d) => [d.name, d]));
        this.log.info(`Found ${this.smartHome.length} smart home device(s)`);
        this.emit('smarthome', this.smartHome);
      } catch (err) {
        errors.push(this.reportError('Refreshing smart home devices', err));
      }
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
  }

  // ---------------------------------------------------------------- volume and player

  setVolume(serial, volume) {
    const v = Number(volume);
    if (!Number.isFinite(v)) return;
    this.volumes.set(serial, v);
    this.emit('volume', serial, v);
  }

  async refreshVolumes() {
    const res = await this.call('getAllDeviceVolumes', (a, cb) => a.getAllDeviceVolumes(cb));
    const volumes = parse.extractVolumes(res);
    for (const [serial, v] of Object.entries(volumes)) {
      if (this.bySerial.has(serial)) this.setVolume(serial, v);
    }
    this.lastVolumePoll = Date.now();
  }

  schedulePlayerRefresh(serial) {
    if (!this.bySerial.has(serial)) return;
    clearTimeout(this.playerTimers.get(serial));
    const t = setTimeout(() => {
      this.playerTimers.delete(serial);
      this.refreshPlayer(serial).catch((e) => this.log.debug('Player refresh failed:', e.message));
    }, this.timing.playerDebounceMs);
    this.playerTimers.set(serial, t);
  }

  async refreshPlayer(serial) {
    const res = await this.call('getPlayerInfo', (a, cb) => a.getPlayerInfo(serial, cb));
    const info = parse.extractPlayerInfo(res);
    this.emit('player', serial, { state: info.state, title: info.title, artist: info.artist });
    if (info.volume !== null) this.setVolume(serial, info.volume);
  }

  // Polling covers the gaps when the push connection is down. One device is
  // polled per tick, and only when no user command is waiting, so polling
  // never delays a button press by more than one call.
  startPolling(gen) {
    clearInterval(this.pollTimer);
    let firstPass = true;
    this.pollTimer = setInterval(() => {
      if (gen !== this.generation || !this.isConnected || this.queue.size > 0) return;
      if (this.devices.length === 0) return;
      if (!this.pushConnected || firstPass) {
        const dev = this.devices[this.pollCursor % this.devices.length];
        this.pollCursor += 1;
        if (this.pollCursor >= this.devices.length) firstPass = false;
        this.refreshPlayer(dev.serial).catch((e) => this.log.debug('Poll failed:', e.message));
      }
      if (!this.pushConnected && Date.now() - this.lastVolumePoll > this.timing.volumePollMs) {
        this.refreshVolumes().catch((e) => this.log.debug('Volume poll failed:', e.message));
      }
    }, this.timing.pollTickMs);
  }

  // ---------------------------------------------------------------- commands

  // alexa-remote2 always sends sequence commands with locale "de-DE", so an
  // English phrase such as "turn on lower" reached Alexa as German and did
  // nothing. Build the node here and put in the region's language instead.
  //
  // noRetry: alexa-remote2 normally resends a rate-limited request on its
  // own 10 to 63 s later. Marking the request as already retried turns that
  // off, and the rate limit comes back as an error instead.
  sendSequence(a, target, command, value, cb, { noRetry = false } = {}) {
    let node;
    try {
      node = a.createSequenceNode(command, value, target);
    } catch (err) {
      cb(err);
      return;
    }
    if (!node) {
      cb(new Error(`Could not build the "${command}" command`));
      return;
    }
    const locale = this.settings.region.acceptLanguage;
    const sequence = JSON.parse(JSON.stringify({ '@type': 'com.amazon.alexa.behaviors.model.Sequence', startNode: node })
      .replace(/"locale":"ALEXA_CURRENT_LOCALE"/g, `"locale":"${locale}"`));
    if (!noRetry || typeof a.httpsGet !== 'function') {
      a.sendSequenceCommand(target, sequence, cb);
      return;
    }
    const done = (err, body) => {
      // Text replies come back as an error, JSON ones ({ message }) as success.
      const text = typeof body === 'string' ? body : (body && body.message) || '';
      if (RATE_LIMIT_BODY.test(text)) {
        const limited = new Error('Amazon rate limited this command, so it was dropped');
        limited.rateLimited = true;
        cb(limited);
        return;
      }
      cb(err, body);
    };
    // sendSequenceCommand calls httpsGet synchronously, so the override only
    // covers this one request.
    const httpsGet = a.httpsGet;
    a.httpsGet = (path, callback, flags) => httpsGet.call(a, path, callback, { ...flags, isRetry: true });
    try {
      a.sendSequenceCommand(target, sequence, done);
    } finally {
      a.httpsGet = httpsGet;
    }
  }

  async speak(nameOrAll, text, mode) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Nothing to say: the text is empty');
    const targets = this.targets(nameOrAll);
    if (mode === 'Announce') {
      const serials = targets.map((d) => d.serial);
      const arg = serials.length === 1 ? serials[0] : serials;
      await this.call('announcement', (a, cb) => this.sendSequence(a, arg, 'announcement', message, cb));
      return;
    }
    for (const dev of targets) {
      await this.call('speak', (a, cb) => this.sendSequence(a, dev.serial, 'speak', message, cb));
    }
  }

  async textCommand(name, phrase) {
    const text = String(phrase || '').trim();
    if (!text) throw new Error('Nothing to send: the phrase is empty');
    const dev = this.device(name);
    await this.call('textCommand', (a, cb) => this.sendSequence(a, dev.serial, 'textCommand', text, cb));
  }

  async media(name, command) {
    const cmd = MEDIA_COMMANDS[command];
    if (!cmd) throw new Error(`Unknown media command "${command}"`);
    const dev = this.device(name);
    await this.call(`media ${cmd}`, (a, cb) => a.sendCommand(dev.serial, cmd, null, cb));
    this.schedulePlayerRefresh(dev.serial);
  }

  async volume(nameOrAll, level) {
    const v = Math.round(Number(level));
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`Volume must be 0 to 100, got "${level}"`);
    for (const dev of this.targets(nameOrAll)) {
      await this.call('volume', (a, cb) => this.sendSequence(a, dev.serial, 'volume', v, cb));
      this.setVolume(dev.serial, v);
    }
  }

  async stepVolume(name, direction, step) {
    const dev = this.device(name);
    const amount = Math.abs(Math.round(Number(step)));
    if (!Number.isFinite(amount) || amount === 0) throw new Error(`Step must be a number above 0, got "${step}"`);
    if (!this.volumes.has(dev.serial)) await this.refreshVolumes();
    if (!this.volumes.has(dev.serial)) throw new Error(`Current volume of "${name}" is unknown`);
    const current = this.volumes.get(dev.serial);
    const next = Math.max(0, Math.min(100, current + (direction === 'Down' ? -amount : amount)));
    await this.volume(name, next);
  }

  // mode: 'On', 'Off' or 'Toggle'. Toggle reads the current state first.
  // Toggle on "All Echos": if any Echo has DND on, all go off; else all on.
  async doNotDisturb(nameOrAll, mode) {
    const targets = this.targets(nameOrAll);
    let on;
    if (mode === 'Toggle') {
      const res = await this.call('getDeviceStatusList', (a, cb) => a.getDeviceStatusList(cb));
      const status = parse.extractDndStatus(res);
      const known = targets.filter((d) => d.serial in status);
      if (known.length === 0) throw new Error('Could not read the current Do Not Disturb state; use On or Off');
      on = !known.some((d) => status[d.serial]);
    } else if (mode === 'On' || mode === 'Off') {
      on = mode === 'On';
    } else {
      throw new Error(`Unknown Do Not Disturb choice "${mode}"`);
    }
    for (const dev of targets) {
      await this.call('setDoNotDisturb', (a, cb) => a.setDoNotDisturb(dev.serial, on, cb));
    }
  }

  async runRoutine(name, routineName) {
    this.ensureConnected();
    const routine = this.routines.get(routineName);
    if (!routine) throw new Error(`Unknown routine "${routineName}". Run "Refresh lists" and pick it again.`);
    const dev = this.device(name);
    await this.call('executeAutomationRoutine', (a, cb) => a.executeAutomationRoutine(dev.serial, routine, cb));
  }

  // The library's timer support (createNotificationObject with type Timer)
  // never sets a duration, so timers are created the same way you would by
  // voice, through "Tell Alexa".
  async createTimer(name, minutes, label) {
    const phrase = timerPhrase(minutes, label);
    await this.textCommand(name, phrase);
  }

  async cancelTimers(name) {
    await this.textCommand(name, 'cancel all timers');
  }

  // mode: 'On', 'Off' or 'Toggle'. Switching always goes through Tell Alexa
  // ("turn on <name>"). Toggle first asks Amazon for the power state; if the
  // device does not report one, it uses the last state this plugin set.
  async smartHomeOnOff(name, deviceName, mode) {
    const target = String(deviceName || '').trim();
    if (!target || target === '(none)') throw new Error('Pick a smart home device first');
    let on;
    if (mode === 'Toggle') {
      on = await this.smartHomeToggleTarget(target);
    } else if (mode === 'On' || mode === 'Off') {
      on = mode === 'On';
    } else {
      throw new Error(`Unknown smart home choice "${mode}"`);
    }
    await this.textCommand(name, `turn ${on ? 'on' : 'off'} ${target}`);
    this.lastPowerSet.set(target, on);
  }

  // Volume of a smart home device such as a Roku TV (not an Echo), asked
  // through an Echo like a spoken "turn up the volume on Living Room Roku".
  // Roku only steps (by 5) and ignores "by N", so each tap is one command.
  // Taps wait in a per-device line, spaced volumeTapGapMs apart; a tap in
  // the other direction clears the line; a rate-limited tap is dropped
  // rather than sent late. Resolves once this tap is sent or skipped.
  async smartHomeVolume(name, deviceName, direction) {
    const target = String(deviceName || '').trim();
    if (!target || target === '(none)') throw new Error('Pick a smart home device first');
    if (direction !== 'Up' && direction !== 'Down') throw new Error(`Unknown direction "${direction}"`);
    this.device(name);
    if (this.throttleSecondsLeft > 0) {
      throw new Error(`Amazon is rate limiting commands. Try again in ${this.throttleSecondsLeft} s.`);
    }
    let line = this.volumeLines.get(target);
    if (!line) {
      line = { direction, waiting: [], busy: false, lastSent: 0 };
      this.volumeLines.set(target, line);
    }
    if (line.direction !== direction) {
      this.skipWaiting(line, `switched to ${direction}`);
      line.direction = direction;
    }
    if (line.waiting.length >= VOLUME_TAP_MAX_WAITING) {
      this.log.debug(`Volume ${direction} on "${target}" ignored: ${VOLUME_TAP_MAX_WAITING} taps already waiting`);
      return;
    }
    const sent = new Promise((resolve, reject) => line.waiting.push({ name, direction, resolve, reject }));
    this.runVolumeLine(target, line);
    await sent;
  }

  async runVolumeLine(target, line) {
    if (line.busy) return;
    line.busy = true;
    try {
      while (line.waiting.length > 0) {
        const wait = line.lastSent + this.timing.volumeTapGapMs - Date.now();
        if (wait > 0) {
          // stop() clears this timer; the line is then dropped with it.
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              this.timers.delete(timer);
              resolve();
            }, wait);
            this.timers.add(timer);
          });
        }
        const tap = line.waiting.shift();
        if (!tap) break;
        line.lastSent = Date.now();
        const text = `turn ${tap.direction === 'Up' ? 'up' : 'down'} the volume on ${target}`;
        try {
          await this.call('device volume', (a, cb) => this.sendSequence(a, this.device(tap.name).serial, 'textCommand', text, cb, { noRetry: true }));
          tap.resolve();
        } catch (err) {
          if (err && err.rateLimited) this.skipWaiting(line, 'Amazon rate limit');
          tap.reject(err);
        }
      }
    } finally {
      line.busy = false;
    }
  }

  skipWaiting(line, reason) {
    const skipped = line.waiting.splice(0);
    if (skipped.length > 0) this.log.debug(`Skipped ${skipped.length} waiting volume tap(s): ${reason}`);
    for (const tap of skipped) tap.resolve();
  }

  clearVolumeLines() {
    for (const line of this.volumeLines.values()) this.skipWaiting(line, 'Alexa backend stopped');
    this.volumeLines.clear();
  }

  async smartHomeToggleTarget(target) {
    const info = this.smartHomeByName.get(target);
    let current = null;
    if (info && info.entityId) {
      try {
        const res = await this.call('querySmarthomeDevices', (a, cb) => a.querySmarthomeDevices([{ entityId: info.entityId, entityType: 'APPLIANCE' }], cb));
        current = parse.extractPowerState(res, info.entityId);
      } catch (err) {
        this.log.warn(`Could not read the state of "${target}": ${err.message}`);
      }
    }
    if (current === null && this.lastPowerSet.has(target)) {
      this.log.info(`"${target}" did not report its state; toggling from the last state this plugin set`);
      return !this.lastPowerSet.get(target);
    }
    if (current === null) throw new Error(`Could not read whether "${target}" is on or off; use On or Off once, then Toggle works`);
    return current === 'OFF';
  }
}

// "set a pasta timer for 1 hour 30 minutes" style phrases.
function timerPhrase(minutes, label) {
  const total = Math.round(Number(minutes) * 60);
  if (!Number.isFinite(total) || total < 1 || total > 24 * 3600) {
    throw new Error(`Timer length must be between 1 second and 24 hours, got "${minutes}" minutes`);
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (s) parts.push(`${s} ${s === 1 ? 'second' : 'seconds'}`);
  const name = String(label || '').trim();
  return name ? `set a ${name} timer for ${parts.join(' ')}` : `set a timer for ${parts.join(' ')}`;
}

module.exports = { AlexaBackend, timerPhrase, MEDIA_COMMANDS, NETWORK_ERROR, RETRY_DELAYS_MS };
