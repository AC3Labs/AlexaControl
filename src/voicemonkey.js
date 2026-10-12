'use strict';

const { sleep } = require('./queue');

// Backend B: Voice Monkey API v3 (official, limited).
// Docs: https://voicemonkey.io/docs/api.html, /docs/api/announcement,
// /docs/api/trigger, /docs/api/authentication
//
// The token is sent in the Authorization header (one of the three ways the
// docs allow) so it never appears in a URL or a log line.

const BASE_URL = 'https://api-v3.voicemonkey.io';

class VoiceMonkeyError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'VoiceMonkeyError';
    this.status = status;
    this.code = code;
  }
}

class VoiceMonkey {
  constructor({ logger, fetchImpl = globalThis.fetch, onStatus = () => {}, timeoutMs = 10000, maxRetries = 4, baseDelayMs = 1000, maxDelayMs = 30000 }) {
    this.log = logger;
    this.fetch = fetchImpl;
    this.onStatus = onStatus;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.token = '';
    this.enabled = false;
  }

  configure({ enabled, token }) {
    this.enabled = Boolean(enabled);
    this.token = token || '';
    if (!this.enabled) this.onStatus('Disabled');
    else if (!this.token) this.onStatus('Enabled, but no API token set');
    else this.onStatus('Ready');
  }

  // speech is required; voice and chime are optional.
  async announce({ device, speech, voice, chime }) {
    const body = { device: required(device, 'Speaker device ID'), speech: required(speech, 'Text') };
    if (voice && String(voice).trim()) body.voice = String(voice).trim();
    if (chime && String(chime).trim()) body.chime = String(chime).trim();
    await this.post('/announce', body);
  }

  async trigger({ device }) {
    await this.post('/trigger', { device: required(device, 'Routine Trigger device ID') });
  }

  async post(path, body) {
    if (!this.enabled) throw new Error('Voice Monkey is disabled in the plugin settings');
    if (!this.token) throw new Error('Voice Monkey token is not set in the plugin settings');

    for (let attempt = 0; ; attempt += 1) {
      const res = await this.request(path, body);
      if (res.ok) {
        this.onStatus(`OK (${path.slice(1)})`);
        return res.json;
      }

      const code = res.json && res.json.error ? String(res.json.error) : `HTTP ${res.status}`;
      // The docs show 429 bodies both as {"error":"THROTTLED"} and as the
      // text "THROTTLED:<until>", so check both.
      const throttled = res.status === 429 && /THROTTLED/i.test(code + res.text);
      const quota = res.status === 429 && /MONTHLY_QUOTA_EXCEEDED/i.test(code + res.text);
      const upstream = res.status >= 500;

      if (quota) {
        const until = res.json && res.json.periodEnd ? ` until ${res.json.periodEnd}` : '';
        this.onStatus(`Monthly quota used up${until}`);
        throw new VoiceMonkeyError(`Voice Monkey monthly quota exceeded${until}`, res.status, 'MONTHLY_QUOTA_EXCEEDED');
      }
      if ((throttled || upstream) && attempt < this.maxRetries) {
        const delay = this.backoffDelay(attempt, throttled ? lockoutUntil(res) : null);
        this.onStatus(`${throttled ? 'Rate limited' : 'Voice Monkey error'}, retrying in ${Math.ceil(delay / 1000)} s`);
        this.log.warn(`Voice Monkey ${path} returned ${res.status} ${code}; retry ${attempt + 1} in ${delay} ms`);
        await sleep(delay);
        continue;
      }
      const message = describeError(res.status, code);
      this.onStatus(message);
      throw new VoiceMonkeyError(message, res.status, code);
    }
  }

  // Exponential backoff: 1 s, 2 s, 4 s, 8 s ... capped. When the server says
  // how long the lockout lasts, wait at least that long (still capped).
  backoffDelay(attempt, untilMs) {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    if (untilMs) return Math.min(this.maxDelayMs, Math.max(exp, untilMs - Date.now()));
    return exp;
  }

  async request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, json, text: text || '' };
    } catch (err) {
      const message = err.name === 'AbortError' ? `Voice Monkey did not answer within ${this.timeoutMs / 1000} s` : `Voice Monkey request failed: ${err.message}`;
      this.onStatus(message);
      throw new VoiceMonkeyError(message, 0, 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }
}

function required(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is empty`);
  return text;
}

function lockoutUntil(res) {
  const iso = (res.json && res.json.lockoutUntil) || (/THROTTLED:(\S+)/i.exec(res.text) || [])[1];
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

function describeError(status, code) {
  switch (code) {
    case 'UNAUTHORIZED':
    case 'INVALID_TOKEN':
    case 'USER_NOT_FOUND':
      return `Voice Monkey rejected the token (${code})`;
    case 'MISSING_DEVICE':
    case 'DEVICE_NOT_FOUND':
      return `Voice Monkey device ID not found (${code})`;
    default:
      return `Voice Monkey error: ${code} (HTTP ${status})`;
  }
}

module.exports = { VoiceMonkey, VoiceMonkeyError, BASE_URL };
