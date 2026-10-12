'use strict';

// Pure functions that turn alexa-remote2 / Amazon responses into the small
// shapes the plugin needs. Amazon's response formats are not documented, so
// every parser is defensive: unknown shapes give empty results, never throws.

// Device families that are phone/tablet apps rather than speakers.
const APP_FAMILIES = new Set(['VOX', 'MSHOP', 'TABLET', 'FIRE_TV_APP']);

// Picks the speakers out of alexa.serialNumbers.
// A device counts as an Echo if it can set volume or play audio. If that
// filter finds nothing (capability names changed), fall back to every
// non-app device so the user still gets a list.
function extractEchoDevices(serialNumbers) {
  // initDeviceState also adds "app devices" copied from a parent Echo; they
  // carry parentDeviceSerialNumber and would show up as duplicates.
  const all = Object.values(serialNumbers || {}).filter((d) => d && d.serialNumber && !d.parentDeviceSerialNumber);
  const isApp = (d) => APP_FAMILIES.has(d.deviceFamily);
  const caps = (d) => (Array.isArray(d.capabilities) ? d.capabilities : []);
  let echos = all.filter((d) => !isApp(d) && (caps(d).includes('VOLUME_SETTING') || caps(d).includes('AUDIO_PLAYER')));
  if (echos.length === 0) echos = all.filter((d) => !isApp(d));
  return uniqueNames(
    echos.map((d) => ({
      serial: d.serialNumber,
      name: String(d.accountName || d.serialNumber).trim(),
      family: d.deviceFamily || '',
      online: d.online !== false,
    })),
  ).sort((a, b) => a.name.localeCompare(b.name));
}

// Two devices can share a name. Touch Portal choice lists are plain text,
// so duplicates get the last four characters of the serial appended.
function uniqueNames(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return items.map((item) => (counts.get(item.name) > 1 ? { ...item, name: `${item.name} (${String(item.serial).slice(-4)})` } : item));
}

// getAutomationRoutines returns an array of routine objects. Routines made
// in the app usually have a name; voice routines may only have a trigger
// phrase, so use that when the name is empty.
function extractRoutines(response) {
  const list = Array.isArray(response) ? response : [];
  const routines = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.status && r.status !== 'ENABLED') continue;
    let name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name && Array.isArray(r.triggers)) {
      const utterance = r.triggers.map((t) => t && t.payload && t.payload.utterance).find(Boolean);
      if (utterance) name = `"${utterance}"`;
    }
    if (!name) name = r.automationId || 'Unnamed routine';
    routines.push({ name, routine: r });
  }
  const named = uniqueNames(routines.map((x, i) => ({ name: x.name, serial: String(i).padStart(4, '0'), routine: x.routine })));
  return named.map(({ name, routine }) => ({ name, routine })).sort((a, b) => a.name.localeCompare(b.name));
}

// getSmarthomeDevicesV2 returns endpoint items with friendlyName. The
// legacyAppliance.entityId is the id the state query (querySmarthomeDevices)
// understands; alexa-remote2's own compatibility code maps it the same way.
// Returns [{ name, entityId }] sorted by name, one entry per name.
function extractSmartHomeDevices(items) {
  const list = Array.isArray(items) ? items : [];
  const byName = new Map();
  for (const item of list) {
    const name = item && typeof item.friendlyName === 'string' ? item.friendlyName.trim() : '';
    if (!name || byName.has(name)) continue;
    const legacy = item.legacyAppliance || {};
    byName.set(name, { name, entityId: legacy.entityId || null });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// getDeviceStatusList (Do Not Disturb):
// { doNotDisturbDeviceStatusList: [ { deviceSerialNumber, enabled } ] }
// Returns serial -> true/false.
function extractDndStatus(response) {
  const list = response && Array.isArray(response.doNotDisturbDeviceStatusList) ? response.doNotDisturbDeviceStatusList : [];
  const result = {};
  for (const item of list) {
    if (item && item.deviceSerialNumber && typeof item.enabled === 'boolean') result[item.deviceSerialNumber] = item.enabled;
  }
  return result;
}

// querySmarthomeDevices response:
// { deviceStates: [ { entity: { entityId }, capabilityStates: [ '<json>' ] } ], errors: [...] }
// Each capability state is a JSON string such as
// {"namespace":"Alexa.PowerController","name":"powerState","value":"ON"}.
// Returns 'ON', 'OFF' or null when the state is not reported.
function extractPowerState(response, entityId) {
  const states = response && Array.isArray(response.deviceStates) ? response.deviceStates : [];
  for (const state of states) {
    if (!state || (entityId && state.entity && state.entity.entityId && state.entity.entityId !== entityId)) continue;
    for (const raw of Array.isArray(state.capabilityStates) ? state.capabilityStates : []) {
      let cap = raw;
      if (typeof raw === 'string') {
        try {
          cap = JSON.parse(raw);
        } catch {
          continue;
        }
      }
      if (cap && cap.namespace === 'Alexa.PowerController' && cap.name === 'powerState') {
        const value = String(cap.value).toUpperCase();
        if (value === 'ON' || value === 'OFF') return value;
      }
    }
  }
  return null;
}

// getPlayerInfo response: { playerInfo: { state, infoText: { title, subText1 }, volume: { volume, muted } } }
function extractPlayerInfo(response) {
  const info = response && response.playerInfo ? response.playerInfo : {};
  const text = info.infoText || {};
  const volume = info.volume && Number.isFinite(Number(info.volume.volume)) ? Number(info.volume.volume) : null;
  return {
    state: typeof info.state === 'string' ? info.state : '',
    title: typeof text.title === 'string' ? text.title : '',
    artist: typeof text.subText1 === 'string' ? text.subText1 : '',
    volume,
  };
}

// getAllDeviceVolumes: the shape is not documented. Seen in the wild as
// { volumes: [ { dsn, speakerVolume, speakerMuted, ... } ] }. Accept a few
// spellings and return a serial -> volume map.
function extractVolumes(response) {
  const list = Array.isArray(response) ? response : (response && Array.isArray(response.volumes) ? response.volumes : []);
  const result = {};
  for (const v of list) {
    if (!v) continue;
    const serial = v.dsn || v.deviceSerialNumber || v.serialNumber;
    const volume = Number(v.speakerVolume ?? v.volume ?? v.volumeSetting);
    if (serial && Number.isFinite(volume)) result[serial] = volume;
  }
  return result;
}

// The login proxy URL arrives as the message of an "error" from the library:
// "... Please open http://127.0.0.1:3456/ with your browser and login ..."
function extractProxyUrl(message) {
  const match = /Please open (https?:\/\/\S+?)\/? with your browser/i.exec(String(message || ''));
  return match ? `${match[1].replace(/\/$/, '')}/` : null;
}

module.exports = {
  extractEchoDevices,
  extractRoutines,
  extractSmartHomeDevices,
  extractDndStatus,
  extractPowerState,
  extractPlayerInfo,
  extractVolumes,
  extractProxyUrl,
  uniqueNames,
};
