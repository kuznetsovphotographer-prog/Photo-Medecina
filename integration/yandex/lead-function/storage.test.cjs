'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore, TABLES } = require('./storage');
const now = new Date('2026-10-27T12:00:00.000Z');
const env = { ENDPOINT: 'test', DATABASE: '/test' };
const lead = { name: 'Тестовая заявка', phone: '+79990000000', preferredContact: 'telegram',
  estimate: { total: 0, items: [{ label: 'Базовый', quantity: 1, price: 0 }] },
  consent: true, consentVersion: '2026-10-27-medical-1', consentAcceptedAt: now.toISOString(),
  deviceType: 'computer', osFamily: 'windows', submissionId: '38bb9604-5b72-4422-bcc3-b12cded2f188',
  formId: 'modal-package-base', siteHost: 'promedphoto.ru' };

test('YDB adapter atomically inserts three tables and rolls back on a partial failure', async () => {
  for (const fail of [false, true]) {
    const actions = []; let record; let consentRecord;
    const session = { describeTable: async () => ({}), beginTransaction: async () => ({ id: 'tx' }),
      executeQuery: async (query, params, tx) => {
        assert.equal(tx.txId, 'tx'); actions.push(query);
        if (query.startsWith('DECLARE $id')) return { resultSets: [[]] };
        if (query.includes('INSERT INTO leads')) record = params;
        if (query.includes('INSERT INTO consent_events')) consentRecord = params;
        if (fail && query.includes('INSERT INTO consent_events')) throw new Error('write failure');
        return {};
      }, commitTransaction: async () => actions.push('commit'), rollbackTransaction: async () => actions.push('rollback') };
    const sdk = { Driver: class { tableClient = { withSessionRetry: fn => fn(session) }; ready = async () => true; },
      TypedValues: { utf8: x => x, timestamp: x => x }, TypedData: { createNativeObjects: x => x } };
    const store = createStore({ env, sdk });
    const run = () => store.save({ ...lead, siteHost: 'promedphoto.ru' }, now, 'fingerprint', 'iam');
    if (fail) { await assert.rejects(run); assert.equal(actions.at(-1), 'rollback'); assert.ok(!actions.includes('commit')); }
    else { await run(); assert.equal(actions.filter(x => x.includes('INSERT INTO')).length, 3);
      assert.equal(actions.at(-1), 'commit'); assert.equal(record.$estimate_json, JSON.stringify(lead.estimate));
      assert.equal(record.$expires_at.toISOString(), '2027-10-27T12:00:00.000Z');
      assert.equal(consentRecord.$expires_at.toISOString(), '2029-10-27T12:00:00.000Z');
      assert.equal(record.$device_type, 'computer'); assert.equal(record.$os_family, 'windows'); }
  }
});
test('duplicate ID cannot overwrite contacts, consent, TTL or outbox', async () => {
  for (const matches of [true, false]) {
    let queries = 0;
    const session = { describeTable: async () => ({}), beginTransaction: async () => ({ id: 'tx' }),
      executeQuery: async () => { queries++; return { resultSets: [[{ fingerprint: 'original', server_received_at: now }]] }; },
      commitTransaction: async () => {}, rollbackTransaction: async () => {} };
    const sdk = { Driver: class { tableClient = { withSessionRetry: fn => fn(session) }; ready = async () => true; },
      TypedValues: { utf8: x => x }, TypedData: { createNativeObjects: x => x } };
    const store = createStore({ env, sdk });
    const run = () => store.save(lead, now, matches ? 'original' : 'changed', 'iam');
    if (matches) assert.equal((await run()).created, false);
    else await assert.rejects(run, { code: 'SUBMISSION_CONFLICT' });
    assert.equal(queries, 1);
  }
});
test('installed SDK exposes the exact table, transaction and auth interfaces used', () => {
  const y = require('ydb-sdk');
  for (const columns of Object.values(TABLES)) {
    const table = new y.TableDescription();
    for (const [key, type] of Object.entries(columns)) table.withColumn(new y.Column(key, y.Types[type]));
    assert.ok(table.withPrimaryKey('submission_id').withTtl('expires_at', 0));
  }
  assert.equal(typeof y.TokenAuthService, 'function');
  assert.equal(typeof y.AlterTableDescription, 'function');
});
test('adds missing device columns once and leaves an already migrated table unchanged', async () => {
  const y = require('ydb-sdk');
  for (const columns of [
    TABLES.leads && Object.keys(TABLES.leads).filter(name => !['device_type', 'os_family'].includes(name)).map(name => ({ name })),
    Object.keys(TABLES.leads).map(name => ({ name })),
  ]) {
    const altered = [];
    const session = {
      describeTable: async name => ({ columns: name === 'leads' ? columns : Object.keys(TABLES[name]).map(column => ({ name: column })) }),
      alterTable: async (name, description) => altered.push([name, description.addColumns.map(column => ({
        name: column.name, optional: Boolean(column.type.optionalType),
      }))]),
      beginTransaction: async () => ({ id: 'tx' }),
      executeQuery: async query => query.startsWith('DECLARE $id') ? { resultSets: [[{ fingerprint: 'original', server_received_at: now }]] } : {},
      commitTransaction: async () => {}, rollbackTransaction: async () => {},
    };
    const sdk = { ...y, Driver: class { tableClient = { withSessionRetry: fn => fn(session) }; ready = async () => true; } };
    const store = createStore({ env, sdk });
    await store.save(lead, now, 'original', 'iam');
    if (columns.length === Object.keys(TABLES.leads).length) assert.deepEqual(altered, []);
    else assert.deepEqual(altered, [['leads', [
      { name: 'device_type', optional: true }, { name: 'os_family', optional: true },
    ]]]);
  }
});
test('creates missing tables when SDK keeps status on the error constructor', async () => {
  const y = require('ydb-sdk');
  class MissingTable extends Error { static status = y.StatusCode.SCHEME_ERROR; }
  const created = [];
  const session = { describeTable: async () => { throw new MissingTable(); },
    createTable: async name => created.push(name), beginTransaction: async () => ({ id: 'tx' }),
    executeQuery: async () => ({ resultSets: [] }), commitTransaction: async () => {}, rollbackTransaction: async () => {} };
  const sdk = { ...y, Driver: class { tableClient = { withSessionRetry: fn => fn(session) }; ready = async () => true; } };
  const store = createStore({ env, sdk });
  await store.save({ ...lead, siteHost: 'promedphoto.ru' }, now, 'hash', 'iam');
  assert.deepEqual(created, ['leads', 'consent_events', 'notification_outbox']);
});
test('missing IAM token fails closed without creating an SDK driver', async () => {
  const store = createStore({ env, sdk: { Driver: class { constructor() { assert.fail('unexpected driver'); } } } });
  await assert.rejects(() => store.save(lead, now, 'hash', undefined), /TOKEN_MISSING/);
});

test('prepare adds nullable Postbox columns to the legacy four-column outbox without reading or rewriting rows', async () => {
  const y = require('ydb-sdk');
  for (const migrated of [false, true]) {
    const altered = [];
    const session = {
      describeTable: async name => ({ columns: Object.keys(TABLES[name])
        .filter(column => migrated || name !== 'notification_outbox' || !['site_host', 'message_id'].includes(column))
        .map(name => ({ name })) }),
      alterTable: async (name, description) => altered.push([name, description.addColumns.map(column => ({
        name: column.name, optional: Boolean(column.type.optionalType),
      }))]),
      executeQuery: () => assert.fail('prepare must not read or write queued/historical rows'),
    };
    const sdk = { ...y, Driver: class { tableClient = { withSessionRetry: fn => fn(session) }; ready = async () => true; } };
    const store = createStore({ env, sdk });
    await store.preparePostbox('iam');
    await store.preparePostbox('iam');
    assert.deepEqual(altered, migrated ? [] : [['notification_outbox', [
      { name: 'site_host', optional: true }, { name: 'message_id', optional: true },
    ]]]);
  }
});
