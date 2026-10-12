'use strict';

// Every id that appears in entry.tp lives here, so the code and the
// description file cannot drift apart silently. test/entry.test.js checks
// that entry.tp and this file agree.

const PLUGIN_ID = 'alexacontrol';
const P = `${PLUGIN_ID}.`;

const ACTIONS = {
  SPEAK: `${P}act.speak`,
  TELL_ALEXA: `${P}act.tellAlexa`,
  MEDIA: `${P}act.media`,
  SET_VOLUME: `${P}act.setVolume`,
  STEP_VOLUME: `${P}act.stepVolume`,
  DND: `${P}act.dnd`,
  ROUTINE: `${P}act.routine`,
  TIMER_CREATE: `${P}act.timerCreate`,
  TIMER_CANCEL: `${P}act.timerCancel`,
  SMART_HOME: `${P}act.smartHome`,
  SMART_VOLUME: `${P}act.smartVolume`,
  REFRESH: `${P}act.refresh`,
  LOGIN: `${P}act.login`,
  OPEN_LOGIN: `${P}act.openLogin`,
  RECONNECT: `${P}act.reconnect`,
  VM_ANNOUNCE: `${P}act.vmAnnounce`,
  VM_TRIGGER: `${P}act.vmTrigger`,
};

// Action data ids. Ids that hold a dynamic list are shared between actions
// on purpose: one choiceUpdate message then refreshes every action using it.
const DATA = {
  DEVICE_OR_ALL: `${P}data.deviceOrAll`,
  DEVICE: `${P}data.device`,
  TEXT: `${P}data.text`,
  SPEAK_MODE: `${P}data.speakMode`,
  MEDIA_COMMAND: `${P}data.mediaCommand`,
  VOLUME: `${P}data.volume`,
  DIRECTION: `${P}data.direction`,
  STEP: `${P}data.step`,
  ON_OFF: `${P}data.onOff`,
  ROUTINE: `${P}data.routine`,
  MINUTES: `${P}data.minutes`,
  LABEL: `${P}data.label`,
  SMART_DEVICE: `${P}data.smartDevice`,
  REFRESH_WHAT: `${P}data.refreshWhat`,
  VM_DEVICE: `${P}data.vmDevice`,
  VM_VOICE: `${P}data.vmVoice`,
  VM_CHIME: `${P}data.vmChime`,
  CONN_DEVICE: `${P}data.connDevice`,
};

const CONNECTORS = {
  VOLUME: `${P}conn.volume`,
};

const STATES = {
  CONNECTION: `${P}state.connection`,
  STATUS: `${P}state.status`,
  LOGIN_URL: `${P}state.loginUrl`,
  LAST_ERROR: `${P}state.lastError`,
  PUSH: `${P}state.push`,
  DEVICE_COUNT: `${P}state.deviceCount`,
  VM_STATUS: `${P}state.vmStatus`,
};

const EVENTS = {
  CONNECTION: `${P}event.connection`,
};

// Values of the CONNECTION state. The event in entry.tp lists the same values.
const CONNECTION = {
  DISABLED: 'Disabled',
  CONNECTING: 'Connecting',
  LOGIN_REQUIRED: 'Login required',
  CONNECTED: 'Connected',
  ERROR: 'Error',
};

const SETTINGS = {
  ALEXA_ENABLED: 'Alexa backend enabled',
  REGION: 'Amazon region',
  PROXY_ADDRESS: 'Login proxy address',
  PROXY_PORT: 'Login proxy port',
  VM_ENABLED: 'Voice Monkey enabled',
  VM_TOKEN: 'Voice Monkey token',
  LOG_LEVEL: 'Log level',
  // Read-only settings the plugin fills in, so the status is visible on the
  // plugin settings page.
  CONNECTION_STATUS: 'Alexa connection',
  LOGIN_PAGE: 'Amazon login page',
};

const NOTIFICATIONS = {
  LOGIN: `${P}notify.login`,
  OPEN_LOGIN_OPTION: 'openLogin',
};

const ALL_ECHOS = 'All Echos';

// Per-device states are created at runtime with these suffixes.
function deviceStateId(serial, field) {
  return `${P}dev.${serial}.${field}`;
}

module.exports = {
  PLUGIN_ID,
  ACTIONS,
  DATA,
  CONNECTORS,
  STATES,
  EVENTS,
  CONNECTION,
  SETTINGS,
  NOTIFICATIONS,
  ALL_ECHOS,
  deviceStateId,
};
