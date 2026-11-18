'use strict';

const { createHash } = require('node:crypto');
const { parseLead, normalizedHeaders, ALLOWED_ORIGINS, DEVICE_TYPES, OS_FAMILIES, hasOnlyKeys } = require('./validation');
const { createStore } = require('./storage');

const SITE = 'promedphoto.ru';
const MAX_BYTES = 8192;
const CONSENT_VERSIONS = new Set(['2026-10-27-medical-1', '2026-11-18-medical-postbox-1']);
const BASE_FIELDS = ['name', 'contact', 'contactMethod', 'source', 'phoneCountry', 'packageName', 'consent',
  'consentAcceptedAt', 'consentVersion', 'submissionId', 'formId', 'deviceType', 'osFamily'];
function validatedPayload(payload, now) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!CONSENT_VERSIONS.has(payload.consentVersion) || !hasOnlyKeys(payload, BASE_FIELDS)) return null;
  const lead = parseLead(payload);
  if (!lead || payload.consent !== true
    || typeof payload.submissionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.submissionId)
    || typeof payload.consentAcceptedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.consentAcceptedAt)) return null;
  if (!DEVICE_TYPES.has(payload.deviceType) || !OS_FAMILIES.has(payload.osFamily)) return null;
  const accepted = Date.parse(payload.consentAcceptedAt);
  if (!Number.isFinite(accepted) || accepted > now.getTime() + 300000
    || accepted < now.getTime() - 86400000) return null;
  return { ...lead, submissionId: payload.submissionId.toLowerCase(),
    consent: true, consentVersion: payload.consentVersion, formId: payload.formId,
    consentAcceptedAt: new Date(accepted).toISOString(), siteHost: SITE,
    deviceType: payload.deviceType, osFamily: payload.osFamily };
}
function fingerprintPayload(lead) {
  return lead;
}

function relayUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.pathname === '/notify' ? url.href : null; }
  catch { return null; }
}

function databaseHealthErrorCode(error) {
  const message = String(error?.message || '');
  const code = String(error?.code ?? error?.status ?? error?.constructor?.status ?? '');
  const details = `${code} ${message}`.toUpperCase();
  if (details.includes('CONFIG_OR_TOKEN_MISSING') || details.includes('CONTEXT_TOKEN_MISSING')) {
    return 'service-account-token-missing';
  }
  if (/(UNAUTHENTICATED|UNAUTHORIZED|ACCESS_DENIED|PERMISSION_DENIED)/.test(details)) {
    return 'database-access-denied';
  }
  if (/(NOT_READY|UNAVAILABLE|DEADLINE|ETIMEDOUT|ECONN|DNS)/.test(details)) {
    return 'database-connection-failed';
  }
  if (/(ALTER|SCHEME|COLUMN|TABLE)/.test(details)) return 'database-schema-failed';
  return 'database-check-failed';
}

function createHandler({ env = process.env, store = createStore({ env }),
  now = () => new Date(), fetchImpl = globalThis.fetch } = {}) {
  return async (event, context = {}) => {
    const headers = normalizedHeaders(event?.headers);
    const allowed = ALLOWED_ORIGINS.has(headers.origin);
    const mode = env.DELIVERY_MODE;
    const configured = Boolean(env.ENDPOINT && env.DATABASE)
      && (['storage-only', 'postbox'].includes(mode) || (mode === 'cloudflare-relay' && env.RELAY_TOKEN?.length >= 32 && relayUrl(env.RELAY_NOTIFY_URL)));
    const reply = (statusCode, body) => ({ statusCode, isBase64Encoded: false,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Vary: 'Origin', ...(allowed ? {
          'Access-Control-Allow-Origin': headers.origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600',
        } : {}) }, body: statusCode === 204 ? '' : JSON.stringify(body) });
    if (event?.httpMethod === 'GET') {
      let databaseChecked = false;
      let databaseError;
      if (configured) {
        try { databaseChecked = await store.health(context.token?.access_token); }
        catch (error) {
          databaseChecked = false;
          databaseError = databaseHealthErrorCode(error);
          console.error('YDB_HEALTH_CHECK_FAILED', JSON.stringify({
            category: databaseError,
            code: error?.code ?? error?.status ?? error?.constructor?.status ?? null,
            message: String(error?.message || 'Unknown YDB health error').slice(0, 500),
          }));
        }
      }
      const healthy = configured && databaseChecked;
      return reply(healthy ? 200 : 503, {
        ok: healthy, service: 'promedphoto-ydb-leads', storage: 'ydb',
        deliveryMode: mode || 'not-configured', databaseConfigured: Boolean(env.ENDPOINT && env.DATABASE),
        relayConfigured: mode === 'cloudflare-relay' && Boolean(env.RELAY_TOKEN?.length >= 32),
        databaseChecked, ...(databaseError ? { databaseError } : {}),
      });
    }
    if (!allowed) return reply(403, { error: 'Origin is not allowed.' });
    if (event?.httpMethod === 'OPTIONS') return reply(204);
    if (event?.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed.' });
    if (!configured) return reply(503, { error: 'Service is not configured.' });
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) return reply(415, { error: 'JSON required.' });
    if (typeof event.body !== 'string') return reply(400, { error: 'Invalid JSON.' });
    if (Buffer.byteLength(event.body) > (event.isBase64Encoded ? 10928 : MAX_BYTES)) return reply(413, { error: 'Request too large.' });
    let payload;
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      if (Buffer.byteLength(raw) > MAX_BYTES) return reply(413, { error: 'Request too large.' });
      payload = JSON.parse(raw);
    } catch { return reply(400, { error: 'Invalid JSON.' }); }
    const receivedAt = now();
    const lead = validatedPayload(payload, receivedAt);
    if (!lead) return reply(400, { error: 'Проверьте данные и согласие. При необходимости обновите страницу.' });
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintPayload(lead))).digest('hex');
    let saved;
    try {
      saved = await store.save(lead, receivedAt, fingerprint, context.token?.access_token);
    } catch (error) {
      if (error.code === 'SUBMISSION_CONFLICT') return reply(409, { error: 'Идентификатор уже использован для другой заявки.' });
      // Never log error objects: SDK diagnostics may contain query parameters and contacts.
      const status = error.status ?? error.code ?? error.constructor?.status;
      console.error('LEAD_STORAGE_FAILED', JSON.stringify({
        stage: ['connection-or-schema', 'transaction'].includes(error.safeStage) ? error.safeStage : 'unknown',
        status: typeof status === 'number' ? status : 'unavailable',
      }));
      const response = { error: 'Не удалось сохранить заявку. Попробуйте позже.' };
      // Only the private staging version exposes a bounded, non-sensitive SDK error category.
      if (mode === 'storage-only' && env.STAGING_DIAGNOSTICS === 'true') {
        const permitted = new Set(['SessionPoolEmpty', 'BadRequest', 'Unauthorized', 'InternalError',
          'Aborted', 'Unavailable', 'Overloaded', 'SchemeError', 'GenericError', 'BadSession',
          'Timeout', 'PreconditionFailed', 'NotFound', 'AlreadyExists', 'SessionExpired',
          'Cancelled', 'Undetermined', 'Unsupported', 'SessionBusy', 'TransportUnavailable',
          'ClientDeadlineExceeded', 'ClientResourceExhausted', 'RetriesExceeded', 'TimeoutExpired']);
        const kind = error?.constructor?.name;
        response.diagnostic = { stage: error.safeStage || 'unknown',
          kind: permitted.has(kind) ? kind : 'unknown',
          status: typeof status === 'number' ? status : null };
      }
      return reply(503, response);
    }
    if (saved.created === false) return reply(200, { ok: true, stored: true,
      submissionId: lead.submissionId, notification: 'already-recorded' });
    if (mode === 'postbox') return reply(202, { ok: true, stored: true,
      submissionId: lead.submissionId, notification: 'pending' });
    if (mode === 'storage-only') return reply(200, { ok: true, stored: true,
      submissionId: lead.submissionId, notification: 'disabled-for-staging' });
    // Outbox claims are atomic. An uncertain Telegram delivery must not be blindly repeated.
    let claimed;
    try { claimed = await store.claim(lead.submissionId, context.token?.access_token); }
    catch { return reply(202, { ok: true, stored: true, notification: 'pending' }); }
    if (!claimed) return reply(200, { ok: true, stored: true, notification: 'already-claimed' });
    const notification = { event: 'lead_stored', site: SITE, submissionId: lead.submissionId,
      serverReceivedAt: new Date(saved.serverReceivedAt).toISOString() };
    let notificationState = 'uncertain';
    try {
      const response = await fetchImpl(relayUrl(env.RELAY_NOTIFY_URL), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Token': env.RELAY_TOKEN },
        body: JSON.stringify(notification), signal: AbortSignal.timeout(8000) });
      let relay = null;
      try { relay = await response.json(); }
      catch { /* Edge/WAF responses may be HTML; status is sufficient for safe diagnostics. */ }
      if (response.ok && relay?.ok === true) notificationState = 'sent';
      else if (relay?.notification === 'uncertain') notificationState = 'uncertain';
      else if (relay?.notification === 'failed') notificationState = 'failed';
      else {
        notificationState = 'failed';
        console.error('NOTIFICATION_RELAY_FAILED', JSON.stringify({ kind: 'http',
          status: Number.isInteger(response.status) ? response.status : 'unavailable' }));
      }
    } catch (error) {
      // Never log the exception message/stack: undici can include the secret-bearing request URL.
      const code = typeof error?.cause?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.cause.code)
        ? error.cause.code : 'unavailable';
      console.error('NOTIFICATION_RELAY_FAILED', JSON.stringify({ kind: 'network',
        name: typeof error?.name === 'string' ? error.name.slice(0, 40) : 'unknown', code }));
    }
    try { await store.finish(lead.submissionId, notificationState, context.token?.access_token); }
    catch { console.error('NOTIFICATION_STATUS_FAILED'); }
    return reply(notificationState === 'sent' ? 200 : 202, { ok: true, stored: true,
      submissionId: lead.submissionId, notification: notificationState });
  };
}
exports.handler = createHandler();
exports.createHandler = createHandler;
exports.validatedPayload = validatedPayload;
exports.fingerprintPayload = fingerprintPayload;
