'use strict';

const { ACTIONS, DATA, CONNECTORS } = require('./ids');

// Routes Touch Portal action and connector messages to the two backends.
// Every handler is awaited inside a try/catch: a failure becomes a status
// and "last error" update, never an exception that reaches Node.
class ActionDispatcher {
  constructor({ alexa, voiceMonkey, tpOut, logger, onError, sliderDelayMs = 350 }) {
    this.alexa = alexa;
    this.vm = voiceMonkey;
    this.tp = tpOut;
    this.log = logger;
    this.onError = onError;
    this.sliderDelayMs = sliderDelayMs;
    this.sliderTimers = new Map();
  }

  async handleAction(message) {
    const id = message && message.actionId;
    const data = toMap(message && message.data);
    this.log.debug(`Action ${id}`, JSON.stringify(Object.keys(data)));
    try {
      await this.run(id, data);
    } catch (err) {
      this.onError(describeAction(id), err);
    }
  }

  async run(id, d) {
    const a = this.alexa;
    switch (id) {
      case ACTIONS.SPEAK:
        return a.speak(d[DATA.DEVICE_OR_ALL], d[DATA.TEXT], d[DATA.SPEAK_MODE]);
      case ACTIONS.TELL_ALEXA:
        return a.textCommand(d[DATA.DEVICE], d[DATA.TEXT]);
      case ACTIONS.MEDIA:
        return a.media(d[DATA.DEVICE], d[DATA.MEDIA_COMMAND]);
      case ACTIONS.SET_VOLUME:
        return a.volume(d[DATA.DEVICE_OR_ALL], d[DATA.VOLUME]);
      case ACTIONS.STEP_VOLUME:
        return a.stepVolume(d[DATA.DEVICE], d[DATA.DIRECTION], d[DATA.STEP]);
      case ACTIONS.DND:
        return a.doNotDisturb(d[DATA.DEVICE_OR_ALL], d[DATA.ON_OFF]);
      case ACTIONS.ROUTINE:
        return a.runRoutine(d[DATA.DEVICE], d[DATA.ROUTINE]);
      case ACTIONS.TIMER_CREATE:
        return a.createTimer(d[DATA.DEVICE], d[DATA.MINUTES], d[DATA.LABEL]);
      case ACTIONS.TIMER_CANCEL:
        return a.cancelTimers(d[DATA.DEVICE]);
      case ACTIONS.SMART_HOME:
        return a.smartHomeOnOff(d[DATA.DEVICE], d[DATA.SMART_DEVICE], d[DATA.ON_OFF]);
      case ACTIONS.SMART_VOLUME:
        return a.smartHomeVolume(d[DATA.DEVICE], d[DATA.SMART_DEVICE], d[DATA.DIRECTION]);
      case ACTIONS.REFRESH:
        return a.refreshLists(d[DATA.REFRESH_WHAT] || 'All');
      case ACTIONS.LOGIN:
        return a.signInAgain();
      case ACTIONS.OPEN_LOGIN:
        return a.openLoginPage();
      case ACTIONS.RECONNECT:
        return a.reconnect();
      case ACTIONS.VM_ANNOUNCE:
        return this.vm.announce({ device: d[DATA.VM_DEVICE], speech: d[DATA.TEXT], voice: d[DATA.VM_VOICE], chime: d[DATA.VM_CHIME] });
      case ACTIONS.VM_TRIGGER:
        return this.vm.trigger({ device: d[DATA.VM_DEVICE] });
      default:
        this.log.warn(`Unknown action id: ${id}`);
        return undefined;
    }
  }

  // Sliders send a value every ~100 ms while the finger moves. Only the last
  // value after a short pause is sent to Amazon, per device.
  handleConnector(message) {
    // The docs do not say whether connectorId arrives bare or with the
    // "pc_<pluginId>_" prefix, so accept both.
    const id = String((message && message.connectorId) || '');
    if (id !== CONNECTORS.VOLUME && !id.endsWith(`_${CONNECTORS.VOLUME}`)) return;
    const data = Array.isArray(message.data) ? message.data : [];
    const deviceName = toMap(data)[DATA.CONN_DEVICE];
    const value = Number(message.value);
    if (!deviceName || !Number.isFinite(value)) return;
    this.tp.noteConnectorValue(CONNECTORS.VOLUME, [{ id: DATA.CONN_DEVICE, value: deviceName }], value);

    clearTimeout(this.sliderTimers.get(deviceName));
    this.sliderTimers.set(deviceName, setTimeout(() => {
      this.sliderTimers.delete(deviceName);
      this.alexa.volume(deviceName, value).catch((err) => this.onError('Volume slider', err));
    }, this.sliderDelayMs));
  }

  stop() {
    for (const t of this.sliderTimers.values()) clearTimeout(t);
    this.sliderTimers.clear();
  }
}

function toMap(data) {
  const map = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && item.id) map[item.id] = item.value;
    }
  }
  return map;
}

function describeAction(id) {
  const name = Object.keys(ACTIONS).find((k) => ACTIONS[k] === id);
  return name ? `Action ${name.toLowerCase().replace(/_/g, ' ')}` : `Action ${id}`;
}

module.exports = { ActionDispatcher, toMap };
