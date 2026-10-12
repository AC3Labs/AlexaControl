'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceMonkey, BASE_URL } = require('../src/voicemonkey');
const { memoryLogger } = require('./helpers');

// Fake fetch that replays a list of { status, body } responses.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift() || { status: 200, body: { success: true, data: 'OK' } };
    if (next.throw) throw next.throw;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

function client(responses, extra = {}) {
  const statuses = [];
  const fetchImpl = fakeFetch(responses);
  const vm = new VoiceMonkey({ logger: memoryLogger(), fetchImpl, onStatus: (s) => statuses.push(s), baseDelayMs: 5, maxDelayMs: 50, ...extra });
  vm.configure({ enabled: true, token: 'tok-123456' });
  return { vm, fetchImpl, statuses };
}

test('announce sends the documented fields with the token in the Authorization header', async () => {
  const { vm, fetchImpl } = client([{ status: 200, body: { success: true, data: 'OK' } }]);
  await vm.announce({ device: 'kitchen-speaker', speech: 'Dinner is ready', voice: 'Joanna', chime: 'soundbank://soundlibrary/alarms/air_horns/air_horn_01' });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${BASE_URL}/announce`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer tok-123456');
  assert.deepEqual(call.body, { device: 'kitchen-speaker', speech: 'Dinner is ready', voice: 'Joanna', chime: 'soundbank://soundlibrary/alarms/air_horns/air_horn_01' });
  assert.ok(!call.url.includes('tok-123456'), 'token never in the URL');
});

test('trigger posts to /trigger and omits empty optional fields', async () => {
  const { vm, fetchImpl } = client([]);
  await vm.trigger({ device: 'routine-trigger-1' });
  assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/trigger`);
  assert.deepEqual(fetchImpl.calls[0].body, { device: 'routine-trigger-1' });
});

test('429 THROTTLED retries with backoff, then succeeds', async () => {
  const { vm, fetchImpl, statuses } = client([
    { status: 429, body: { error: 'THROTTLED', lockoutUntil: new Date(Date.now() + 10).toISOString() } },
    { status: 429, body: 'THROTTLED:2000-01-01T00:00:00Z' },
    { status: 200, body: { success: true, data: 'OK' } },
  ]);
  await vm.trigger({ device: 'x' });
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(statuses.some((s) => /Rate limited, retrying/.test(s)));
  assert.match(statuses.at(-1), /^OK/);
});

test('429 gives up after maxRetries and reports it', async () => {
  const { vm, fetchImpl, statuses } = client(Array.from({ length: 10 }, () => ({ status: 429, body: { error: 'THROTTLED' } })), { maxRetries: 2 });
  await assert.rejects(vm.trigger({ device: 'x' }), /THROTTLED/);
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(statuses.at(-1), /THROTTLED/);
});

test('monthly quota is not retried', async () => {
  const { vm, fetchImpl } = client([{ status: 429, body: { error: 'MONTHLY_QUOTA_EXCEEDED', periodEnd: '2026-11-01T00:00:00Z' } }]);
  await assert.rejects(vm.trigger({ device: 'x' }), /quota/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('bad token and unknown device give clear errors without retries', async () => {
  const a = client([{ status: 401, body: { error: 'INVALID_TOKEN' } }]);
  await assert.rejects(a.vm.trigger({ device: 'x' }), /rejected the token/);
  const b = client([{ status: 404, body: { error: 'DEVICE_NOT_FOUND' } }]);
  await assert.rejects(b.vm.announce({ device: 'x', speech: 'hi' }), /device ID not found/);
  assert.equal(b.fetchImpl.calls.length, 1);
});

test('disabled, missing token, empty fields and network failures', async () => {
  const vm = new VoiceMonkey({ logger: memoryLogger(), fetchImpl: fakeFetch([]) });
  vm.configure({ enabled: false, token: 'x' });
  await assert.rejects(vm.trigger({ device: 'x' }), /disabled/);
  vm.configure({ enabled: true, token: '' });
  await assert.rejects(vm.trigger({ device: 'x' }), /token is not set/);
  const { vm: ok } = client([]);
  await assert.rejects(ok.announce({ device: 'x', speech: '  ' }), /Text is empty/);
  const net = client([{ throw: new Error('getaddrinfo ENOTFOUND') }]);
  await assert.rejects(net.vm.trigger({ device: 'x' }), /request failed/);
});
