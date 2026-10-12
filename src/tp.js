'use strict';

const { PLUGIN_ID } = require('./ids');

// Everything the plugin sends to Touch Portal goes through here. It:
// - only sends a state or choice list when the value actually changed
// - creates runtime states once and remembers them
// - remembers connector short ids and uses them when available (Touch Portal
//   rejects connector ids longer than 200 characters)
// - never throws: a failed send is logged and ignored
class TouchPortalOut {
  constructor(client, logger) {
    this.client = client;
    this.log = logger;
    this.stateCache = new Map();
    this.choiceCache = new Map();
    this.settingCache = new Map();
    this.createdStates = new Set();
    this.connectorValues = new Map();
    this.shortIds = new Map();
    this.connected = false;
  }

  setConnected(connected) {
    this.connected = connected;
  }

  safe(what, fn) {
    if (!this.connected) return;
    try {
      fn();
    } catch (err) {
      this.log.warn(`Touch Portal send failed (${what}):`, err.message);
    }
  }

  state(id, value) {
    const text = value === undefined || value === null ? '' : String(value);
    if (this.stateCache.get(id) === text) return;
    this.stateCache.set(id, text);
    this.safe(`state ${id}`, () => this.client.send({ type: 'stateUpdate', id, value: text }));
  }

  // Used after a page change so freshly opened pages show current values.
  resendStates() {
    for (const [id, value] of this.stateCache) {
      this.safe(`state ${id}`, () => this.client.send({ type: 'stateUpdate', id, value }));
    }
  }

  createState(id, desc, defaultValue, parentGroup) {
    if (this.createdStates.has(id)) return;
    this.createdStates.add(id);
    this.safe(`createState ${id}`, () => {
      this.client.send({
        type: 'createState',
        id,
        desc,
        defaultValue: String(defaultValue ?? ''),
        parentGroup: parentGroup || 'Alexa Control',
      });
    });
  }

  removeState(id) {
    if (!this.createdStates.has(id)) return;
    this.createdStates.delete(id);
    this.stateCache.delete(id);
    this.safe(`removeState ${id}`, () => this.client.send({ type: 'removeState', id }));
  }

  choices(dataId, values) {
    const list = values.length > 0 ? values : ['(none)'];
    const key = JSON.stringify(list);
    if (this.choiceCache.get(dataId) === key) return;
    this.choiceCache.set(dataId, key);
    this.safe(`choiceUpdate ${dataId}`, () => this.client.send({ type: 'choiceUpdate', id: dataId, value: list }));
  }

  // Updates a (read-only) setting shown on the plugin settings page.
  setting(name, value) {
    const text = String(value ?? '');
    if (this.settingCache.get(name) === text) return;
    this.settingCache.set(name, text);
    this.safe(`settingUpdate ${name}`, () => this.client.send({ type: 'settingUpdate', name, value: text }));
  }

  // Touch Portal notification (bell icon). The docs allow these only for
  // things the user must act on, such as a needed login.
  notify(notificationId, title, msg, options) {
    this.safe(`showNotification ${notificationId}`, () => this.client.send({ type: 'showNotification', notificationId, title, msg, options }));
  }

  rememberShortId(connectorId, shortId) {
    if (connectorId && shortId) this.shortIds.set(connectorId, shortId);
  }

  // Full connector id format from the Touch Portal docs:
  //   pc_<pluginId>_<connectorId>|<dataId>=<value>
  static connectorKey(connectorId, data) {
    const suffix = data.map((d) => `|${d.id}=${d.value}`).join('');
    return `pc_${PLUGIN_ID}_${connectorId}${suffix}`;
  }

  connector(connectorId, data, value) {
    const v = Math.max(0, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(v)) return;
    const key = TouchPortalOut.connectorKey(connectorId, data);
    if (this.connectorValues.get(key) === v) return;
    this.connectorValues.set(key, v);
    const shortId = this.shortIds.get(key);
    this.safe(`connectorUpdate ${connectorId}`, () => {
      if (shortId) this.client.send({ type: 'connectorUpdate', shortId, value: v });
      else if (key.length <= 200) this.client.send({ type: 'connectorUpdate', connectorId: key, value: v });
      else this.log.debug(`Connector id too long and no short id yet: ${connectorId}`);
    });
  }

  // Remember the slider position the user set, so the echo from Amazon is
  // not sent back to the slider as a "change".
  noteConnectorValue(connectorId, data, value) {
    this.connectorValues.set(TouchPortalOut.connectorKey(connectorId, data), Math.round(Number(value)));
  }
}

module.exports = { TouchPortalOut };
