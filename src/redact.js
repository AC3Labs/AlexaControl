'use strict';

// Removes secrets from any text before it is written to the log.
//
// alexa-remote2 and alexa-cookie2 log full cookies, tokens and the whole
// registration data object at debug level, so every log line from every
// source passes through redact(). The rules are deliberately broad: hiding
// a harmless value is fine, leaking a cookie is not.

const MASK = '***';

// JSON style:  "refreshToken":"...."  or  "token": "...."
// Keys whose values are secret or personal. A dotted prefix is allowed, so
// "openid.oa2.authorization_code" matches "authorization_code".
const SECRET_KEYS = [
  'cookie', 'localCookie', 'loginCookie', 'csrf', 'refreshToken', 'refresh_token',
  'accessToken', 'access_token', 'adp_token', 'device_private_key', 'token',
  'password', 'frc', 'map-md', 'authorization', 'macDms', 'deviceSerial',
  'website_cookies', 'store_authentication_cookie', 'customer_info',
  'Value', 'authorization_code', 'code_verifier', 'code_challenge',
  'customer_id', 'customerId', 'directedId', 'user_id', 'email', 'customerEmail',
  // Personal details from the /accounts (comms) response.
  'phoneNumber', 'phone', 'mobileNumber', 'firstName', 'lastName', 'fullName',
  'givenName', 'familyName', 'phoneticFirstName', 'phoneticLastName',
  'commsId', 'personIdV2',
];
const KEY_GROUP = `(?:[A-Za-z0-9_-]+\\.)*(?:${SECRET_KEYS.map(escapeRegExp).join('|')})`;
// Plain JSON:  "key": "value"  (or an object, or a bare word/number)
const keyPattern = new RegExp(
  `("${KEY_GROUP}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|\\{[^{}]*\\}|[^,}\\]\\s]+)`,
  'g',
);
// JSON inside a JSON string, with escaped quotes:  \"key\":\"value\"
const escapedKeyPattern = new RegExp(
  `(\\\\"${KEY_GROUP}\\\\"\\s*:\\s*)(\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\")`,
  'g',
);

const RULES = [
  // Authorization headers and bearer tokens.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=|-]+/gi, `$1 ${MASK}`],
  // Amazon token formats such as Atza|... and Atnr|...
  [/\bAt[a-z]{2}\|[^\s"',;]+/g, MASK],
  // Cookie pairs and query parameters: name=value where value is 8+ chars,
  // with or without quotes, and with or without spaces around "=" (the
  // library logs cookies as: Update Cookie x-main = "...").
  [/\b([A-Za-z0-9_.-]+)(\s?=\s?)("?)([^;\s"'&,]{8,})\3/g, `$1$2$3${MASK}$3`],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, MASK],
  // Long opaque blobs (private keys, base64, hex) of 40+ characters.
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],
];

const extraSecrets = new Set();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Register a known secret value (for example the Voice Monkey token) so it
// is replaced wherever it appears, even inside text the rules would miss.
function addSecret(value) {
  if (typeof value === 'string' && value.length >= 4) extraSecrets.add(value);
}

function clearSecrets() {
  extraSecrets.clear();
}

function redact(input) {
  let text = typeof input === 'string' ? input : stringify(input);
  for (const secret of extraSecrets) {
    text = text.split(secret).join(MASK);
  }
  text = text.replace(keyPattern, `$1"${MASK}"`);
  text = text.replace(escapedKeyPattern, `$1\\"${MASK}\\"`);
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function stringify(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

module.exports = { redact, addSecret, clearSecrets, MASK };
