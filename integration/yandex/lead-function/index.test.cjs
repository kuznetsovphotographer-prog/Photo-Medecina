'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('./index');

const now = new Date('2026-10-27T12:00:00.000Z');
const payload = { name: 'Тестовая заявка', contact: '+79990000000', contactMethod: 'max_messenger',
  source: 'modal', phoneCountry: 'RU', packageName: 'Базовый', consent: true,
  consentVersion: '2026-10-27-medical-1', consentAcceptedAt: now.toISOString(),
  submissionId: '38bb9604-5b72-4422-bcc3-b12cded2f188', formId: 'modal-package-base',
  deviceType: 'phone', osFamily: 'android' };
const env = { ENDPOINT: 'test', DATABASE: '/test', DELIVERY_MODE: 'cloudflare-relay',
  RELAY_TOKEN: 'test-only-token-'.repeat(3), RELAY_NOTIFY_URL: 'https://relay.example.test/notify' };
const event = (body = payload, origin = 'https://promedphoto.ru') => ({ httpMethod: 'POST',
  headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
function fixture(overrides = {}) {
  const calls = [];
  const store = { save: async (...args) => { calls.push(['save', ...args]); return { serverReceivedAt: now }; },
    claim: async () => { calls.push(['claim']); return true; }, finish: async (...args) => calls.push(['finish', ...args]),
    health: async () => true, ...overrides.store };
  return { calls, handler: createHandler({ env: { ...env, ...overrides.env }, now: () => now, store,
    fetchImpl: async (url, request) => { calls.push(['fetch', url, request]); return { ok: true, json: async () => ({ ok: true }) }; } }) };
}
test('stores medical request and consent before sending only service metadata', async () => {
  const f = fixture(); const result = await f.handler(event(), { token: { access_token: 'test' } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ['save', 'claim', 'fetch', 'finish']);
  assert.equal(f.calls[0][1].siteHost, 'promedphoto.ru');
  assert.equal(f.calls[0][1].preferredContact, 'max');
  assert.equal(f.calls[0][1].estimate.items[0].label, 'Базовый');
  const notification = JSON.parse(f.calls[2][2].body);
  assert.deepEqual(Object.keys(notification).sort(), ['event', 'serverReceivedAt', 'site', 'submissionId']);
  assert.equal(notification.site, 'promedphoto.ru');
  assert.ok(!f.calls[2][2].body.includes(payload.contact));
  assert.ok(!f.calls[2][2].body.includes(payload.name));
});
test('accepts contact form without a package', async () => {
  const contact = { ...payload, source: 'inline', formId: 'homepage-inline' }; delete contact.packageName;
  const f = fixture(); assert.equal((await f.handler(event(contact))).statusCode, 200);
  assert.deepEqual(f.calls[0][1].estimate, { total: 0, items: [] });
});
test('rejects invalid consent, package, origin, identifying fields and timestamps before saving', async () => {
  for (const patch of [{ consent: false }, { consentVersion: 'old' }, { packageName: 'Полный' },
    { formId: 'other' }, { submissionId: 'invalid' }, { consentAcceptedAt: 'bad' },
    { deviceType: 'watch' }, { contactMethod: 'email' }, { ip: '127.0.0.1' }]) {
    const f = fixture(); assert.equal((await f.handler(event({ ...payload, ...patch }))).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); assert.equal((await f.handler(event(payload, 'https://other.example'))).statusCode, 403);
  assert.equal(f.calls.length, 0);
});
test('never sends notification when storage fails or relay is not configured', async () => {
  const failed = fixture({ store: { save: async () => { throw new Error('test'); } } });
  assert.equal((await failed.handler(event())).statusCode, 503);
  assert.equal(failed.calls.length, 0);
  const unconfigured = fixture({ env: { RELAY_NOTIFY_URL: undefined } });
  assert.equal((await unconfigured.handler(event())).statusCode, 503);
  assert.equal(unconfigured.calls.length, 0);
});
test('staging diagnostics expose only a whitelisted error category and no message', async () => {
  class SessionPoolEmpty extends Error {}
  const failure = () => { throw Object.assign(new SessionPoolEmpty('private contact'), { safeStage: 'transaction' }); };
  const staging = fixture({ env: { DELIVERY_MODE: 'storage-only', STAGING_DIAGNOSTICS: 'true' }, store: { save: failure } });
  const result = await staging.handler(event());
  assert.deepEqual(JSON.parse(result.body).diagnostic, { stage: 'transaction', kind: 'SessionPoolEmpty', status: null });
  assert.ok(!result.body.includes('private contact'));
  const production = fixture({ env: { STAGING_DIAGNOSTICS: 'true' }, store: { save: failure } });
  assert.equal(JSON.parse((await production.handler(event())).body).diagnostic, undefined);
});

test('an uncertain Telegram delivery stays uncertain and is not marked safe to retry', async () => {
  const finished = [];
  const store = {
    save: async () => ({ serverReceivedAt: now }), claim: async () => true,
    finish: async (_id, state) => finished.push(state),
  };
  const handler = createHandler({ env, now: () => now, store,
    fetchImpl: async () => ({ ok: false, status: 502,
      json: async () => ({ notification: 'uncertain' }) }) });
  const result = await handler(event());
  assert.equal(result.statusCode, 202);
  assert.equal(JSON.parse(result.body).notification, 'uncertain');
  assert.deepEqual(finished, ['uncertain']);
});
