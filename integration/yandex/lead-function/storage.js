'use strict';

const { attachPostboxStore } = require('./postbox-store');

const TABLES = {
  leads: { submission_id: 'UTF8', fingerprint: 'UTF8', server_received_at: 'TIMESTAMP',
    site_host: 'UTF8', name: 'UTF8', phone: 'UTF8', contact_method: 'UTF8', estimate_json: 'UTF8',
    device_type: 'UTF8', os_family: 'UTF8', status: 'UTF8', expires_at: 'TIMESTAMP' },
  consent_events: { submission_id: 'UTF8', site_host: 'UTF8', name: 'UTF8', phone: 'UTF8',
    consent_version: 'UTF8', consent_accepted_at: 'TIMESTAMP', server_received_at: 'TIMESTAMP',
    form_id: 'UTF8', expires_at: 'TIMESTAMP' },
  notification_outbox: { submission_id: 'UTF8', state: 'UTF8', server_received_at: 'TIMESTAMP', expires_at: 'TIMESTAMP', site_host: 'UTF8', message_id: 'UTF8' },
};
function addYears(date, years) {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}
function createStore({ env = process.env, sdk } = {}) {
  let driver, ready, schema, token;
  const getSdk = () => sdk || require('ydb-sdk');
  async function connect(accessToken) {
    if (!env.ENDPOINT || !env.DATABASE || !accessToken) throw new Error('YDB_CONFIG_OR_TOKEN_MISSING');
    token = accessToken;
    const y = getSdk();
    if (!ready) {
      driver = new y.Driver({ endpoint: env.ENDPOINT.trim(), database: env.DATABASE.trim(),
        authService: { getAuthMetadata: async () => new y.TokenAuthService(token).getAuthMetadata() },
        poolSettings: { minLimit: 0, maxLimit: 4 } });
      ready = driver.ready(8000).then(result => { if (!result) throw new Error('YDB_NOT_READY'); })
        .catch(async error => { ready = undefined; await driver.destroy().catch(() => {}); throw error; });
    }
    await ready;
    if (!schema) schema = driver.tableClient.withSessionRetry(async session => {
      for (const [name, columns] of Object.entries(TABLES)) {
        let existing;
        try { existing = await session.describeTable(name); }
        catch (error) {
          const code = error.status ?? error.code ?? error.constructor?.status;
          if (![y.StatusCode.NOT_FOUND, y.StatusCode.SCHEME_ERROR].includes(code)) throw error;
        }
        if (existing) {
          if (['leads', 'notification_outbox'].includes(name) && Array.isArray(existing.columns)) {
            const present = new Set(existing.columns.map(column => column?.name).filter(Boolean));
            const additions = name === 'leads' ? ['device_type', 'os_family'] : ['site_host', 'message_id'];
            const missing = additions.filter(column => !present.has(column));
            if (missing.length) {
              const alteration = new y.AlterTableDescription();
              for (const column of missing) {
                alteration.withAddColumn(new y.Column(column, y.Types.optional(y.Types.UTF8)));
              }
              await session.alterTable(name, alteration);
            }
          }
          continue;
        }
        const description = new y.TableDescription();
        for (const [column, type] of Object.entries(columns)) description.withColumn(new y.Column(column, y.Types[type]));
        description.withPrimaryKey('submission_id').withTtl('expires_at', 0);
        try { await session.createTable(name, description); }
        catch (error) { if ((error.status ?? error.code ?? error.constructor?.status) !== y.StatusCode.ALREADY_EXISTS) throw error; }
      }
    }, 10000).catch(error => { schema = undefined; throw error; });
    await schema;
    return driver;
  }
  const rows = result => result.resultSets?.[0] ? getSdk().TypedData.createNativeObjects(result.resultSets[0]) : [];
  async function transaction(accessToken, work) {
    let d;
    try { d = await connect(accessToken); }
    catch (error) { error.safeStage = 'connection-or-schema'; throw error; }
    return d.tableClient.withSessionRetry(async session => {
      const tx = await session.beginTransaction({ serializableReadWrite: {} });
      const control = { txId: tx.id };
      try {
        const value = await work(session, control);
        await session.commitTransaction(control);
        return value;
      } catch (error) { error.safeStage = 'transaction'; await session.rollbackTransaction(control).catch(() => {}); throw error; }
    }, 10000);
  }
  async function insert(session, tx, table, record) {
    const y = getSdk(), params = {};
    const keys = Object.keys(record);
    const declarations = keys.map(key => {
      const timestamp = TABLES[table][key] === 'TIMESTAMP';
      params['$' + key] = timestamp ? y.TypedValues.timestamp(record[key]) : y.TypedValues.utf8(record[key]);
      return `DECLARE $${key} AS ${timestamp ? 'Timestamp' : 'Utf8'};`;
    });
    await session.executeQuery(`${declarations.join('\n')}\nINSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(key => '$' + key).join(', ')});`, params, tx);
  }
  async function save(lead, receivedAt, fingerprint, accessToken) {
    return transaction(accessToken, async (session, tx) => {
      const result = await session.executeQuery('DECLARE $id AS Utf8; SELECT fingerprint, server_received_at FROM leads WHERE submission_id = $id;',
        { $id: getSdk().TypedValues.utf8(lead.submissionId) }, tx);
      const existing = rows(result)[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('Submission conflict'), { code: 'SUBMISSION_CONFLICT' });
        return { created: false, serverReceivedAt: existing.server_received_at };
      }
      const common = { submission_id: lead.submissionId, site_host: lead.siteHost,
        name: lead.name, phone: lead.phone, server_received_at: receivedAt };
      await insert(session, tx, 'leads', { ...common, fingerprint,
        contact_method: lead.preferredContact, estimate_json: JSON.stringify(lead.estimate),
        device_type: lead.deviceType, os_family: lead.osFamily,
        status: 'new', expires_at: addYears(receivedAt, 1) });
      // Match the published medical consent: at most three years from receipt.
      await insert(session, tx, 'consent_events', { ...common, consent_version: lead.consentVersion,
        consent_accepted_at: new Date(lead.consentAcceptedAt), form_id: lead.formId,
        expires_at: addYears(receivedAt, 3) });
      await insert(session, tx, 'notification_outbox', { submission_id: lead.submissionId,
        state: env.DELIVERY_MODE === 'postbox' ? 'postbox-pending' : env.DELIVERY_MODE === 'storage-only' ? 'disabled' : 'pending',
        site_host: lead.siteHost, message_id: '', server_received_at: receivedAt, expires_at: addYears(receivedAt, 1) });
      return { created: true, serverReceivedAt: receivedAt };
    });
  }
  async function claim(id, accessToken) {
    return transaction(accessToken, async (session, tx) => {
      const params = { $id: getSdk().TypedValues.utf8(id) };
      const result = await session.executeQuery('DECLARE $id AS Utf8; SELECT state FROM notification_outbox WHERE submission_id = $id;', params, tx);
      if (!['pending', 'failed'].includes(rows(result)[0]?.state)) return false;
      await session.executeQuery('DECLARE $id AS Utf8; UPDATE notification_outbox SET state = "sending" WHERE submission_id = $id;', params, tx);
      return true;
    });
  }
  async function finish(id, state, accessToken) {
    if (!['sent', 'failed', 'uncertain'].includes(state)) throw new Error('Invalid notification state');
    const d = await connect(accessToken), y = getSdk();
    await d.tableClient.withSessionRetry(session => session.executeQuery(
      'DECLARE $id AS Utf8; DECLARE $state AS Utf8; UPDATE notification_outbox SET state = $state WHERE submission_id = $id;',
      { $id: y.TypedValues.utf8(id), $state: y.TypedValues.utf8(state) }), 10000);
  }
  async function health(accessToken) {
    const d = await connect(accessToken);
    await d.tableClient.withSessionRetry(session => session.executeQuery('SELECT 1 AS ready;'), 10000);
    return true;
  }
  const postbox = attachPostboxStore({ transaction, connect, rows, sdk: getSdk });
  return { save, claim, finish, health, ...postbox };
}
exports.createStore = createStore;
exports.TABLES = TABLES;
exports.addYears = addYears;
