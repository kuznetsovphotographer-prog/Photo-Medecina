/**
 * Reproducible contract checks. Requires Node 24 with native TypeScript support.
 * Run: node scripts/check-lead.mjs
 *
 * Every submit uses an injected mock fetcher. A global fetch guard also blocks
 * accidental network requests, including requests from imported modules.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;
let unmockedFetchAttempts = 0;
globalThis.fetch = async () => {
  unmockedFetchAttempts += 1;
  throw new Error('Live network request blocked by check-lead.mjs.');
};

const {
  buildLeadPayload,
  formatPhoneInput,
  getDeviceContext,
  getE164,
  getPhoneCountries,
  LEAD_CONSENT_VERSION,
  LEAD_ENDPOINT,
  submitLead,
  validateLeadPayload,
} = await import('../src/lib/lead.ts');

// A reserved North American fictional number. No real contact data is used.
const draft = {
  name: 'Анна',
  phone: '2025550123',
  phoneCountry: 'US',
  contactMethod: 'telegram',
  consent: true,
  consentAcceptedAt: '2026-10-23T16:00:00.000Z',
  mode: 'modal',
  packageKey: 'base',
};
const device = { deviceType: 'computer', osFamily: 'windows' };
const payload = buildLeadPayload(draft, 'mock-only-submission', device);
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

await test('lead contract — mocks only, no network', async (suite) => {
  suite.after(() => {
    globalThis.fetch = originalFetch;
    assert.equal(unmockedFetchAttempts, 0, 'Every request must use an explicit mock.');
  });

  await suite.test('country labels and ordering do not depend on runtime Intl', () => {
    const countriesBefore = getPhoneCountries();
    const originalDisplayNames = Intl.DisplayNames;
    const originalLocaleCompare = String.prototype.localeCompare;
    try {
      Intl.DisplayNames = class { constructor() { throw new Error('Runtime Intl must not render country labels.'); } };
      String.prototype.localeCompare = () => { throw new Error('Runtime collation must not reorder country options.'); };
      const countriesAfter = getPhoneCountries();
      assert.deepEqual(countriesAfter, countriesBefore);
      assert.equal(countriesAfter[0].code, 'RU');
      assert.equal(countriesAfter.find((country) => country.code === 'HK').name, 'Гонконг (САР)');
      assert.ok(countriesAfter.length > 200);
      assert.equal(new Set(countriesAfter.map((country) => country.code)).size, countriesAfter.length);
      assert.ok(countriesAfter.every((country) => country.name && country.name !== country.code));
    } finally {
      Intl.DisplayNames = originalDisplayNames;
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  await suite.test('package payload matches the existing public contract', () => {
    assert.deepEqual(validateLeadPayload(payload), {});
    assert.deepEqual(payload, {
      name: 'Анна',
      contact: '+12025550123',
      contactMethod: 'telegram',
      consent: true,
      source: 'modal',
      consentAcceptedAt: draft.consentAcceptedAt,
      consentVersion: LEAD_CONSENT_VERSION,
      submissionId: 'mock-only-submission',
      formId: 'modal-package-base',
      phoneCountry: 'US',
      deviceType: 'computer',
      osFamily: 'windows',
      packageName: 'Базовый',
    });
    for (const [packageKey, packageName, formId] of [
      ['minimal', 'Минимальный', 'modal-package-minimal'],
      ['base', 'Базовый', 'modal-package-base'],
      ['full', 'Полный', 'modal-package-full'],
    ]) {
      const selected = buildLeadPayload({ ...draft, packageKey }, 'mock-package', device);
      assert.equal(selected.packageName, packageName);
      assert.equal(selected.formId, formId);
    }
  });

  await suite.test('general forms omit packageName and use their own form IDs', () => {
    for (const [mode, formId] of [['inline', 'homepage-inline'], ['modal', 'modal-general']]) {
      const general = buildLeadPayload({ ...draft, mode, packageKey: undefined }, 'mock-general', device);
      assert.equal(general.formId, formId);
      assert.equal(general.source, mode);
      assert.equal(Object.hasOwn(general, 'packageName'), false);
      for (const key of ['userAgent', 'ip', 'screenWidth', 'deviceModel']) {
        assert.equal(Object.hasOwn(general, key), false);
      }
    }
  });

  await suite.test('invalid fields are rejected before even calling the mock', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return response({ ok: true }); };
    for (const invalid of [
      { ...payload, name: '' },
      { ...payload, name: 'Анна2' },
      { ...payload, name: '<Анна>' },
      { ...payload, name: 'a'.repeat(101) },
      { ...payload, contact: '' },
      { ...payload, contact: '+7999' },
      { ...payload, consent: false },
      { ...payload, consentAcceptedAt: '' },
      { ...payload, consentVersion: 'unconfirmed-version' },
    ]) {
      await assert.rejects(submitLead(invalid, { fetcher }), /Проверьте поля формы/);
    }
    assert.equal(calls, 0);
    for (const name of ['Анна-Мария', "O'Connor", '李明']) {
      assert.equal(validateLeadPayload({ ...payload, name }).name, undefined);
    }
  });

  await suite.test('phone formatting supports the confirmed UI without extra country rules', () => {
    // These check the default +7 input, automatic international parsing and E.164
    // output. They make no assertion that a number is reachable or has an account.
    for (const input of ['+7 999 123-45-67', '8 (999) 123-45-67', '9991234567']) {
      const formatted = formatPhoneInput(input, 'RU');
      assert.equal(formatted.country, 'RU');
      assert.equal(getE164(formatted.phone, formatted.country), '+79991234567');
    }
    const international = formatPhoneInput('+1 202 555 0123', 'RU');
    assert.equal(international.country, 'US');
    assert.equal(getE164(international.phone, international.country), '+12025550123');
    const italian = formatPhoneInput('+39 02 12345678', 'RU');
    assert.equal(getE164(italian.phone, italian.country), '+390212345678');
    assert.deepEqual(getDeviceContext({ userAgent: 'iPad', platform: 'MacIntel', maxTouchPoints: 5 }), {
      deviceType: 'tablet', osFamily: 'ipados',
    });
  });

  await suite.test('HTTP OK plus ok:true sends the exact JSON contract to the mock', async () => {
    let calls = 0;
    await submitLead(payload, { fetcher: async (url, init) => {
      calls += 1;
      assert.equal(url, LEAD_ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), payload);
      assert.ok(init.signal instanceof AbortSignal);
      return response({ ok: true });
    } });
    assert.equal(calls, 1);
  });

  await suite.test('HTTP 500 is an error even when its JSON says ok:true', async () => {
    await assert.rejects(submitLead(payload, {
      fetcher: async () => response({ ok: true }, 500),
    }), /Не удалось отправить заявку/);
  });

  await suite.test('HTTP 202 confirms the saved lead independently of pending mail delivery', async () => {
    const before = structuredClone(payload);
    let calls = 0;
    await submitLead(payload, {
      fetcher: async () => {
        calls += 1;
        return response({ ok: true, stored: true, submissionId: payload.submissionId, notification: 'pending' }, 202);
      },
    });
    assert.equal(calls, 1, 'A pending mail notification must not trigger another form submission.');
    assert.deepEqual(payload, before);
  });

  await suite.test('HTTP 200 without literal ok:true never counts as success', async () => {
    for (const body of [{ ok: false }, {}, { ok: 'true' }]) {
      await assert.rejects(submitLead(payload, {
        fetcher: async () => response(body),
      }), /Сервер не подтвердил отправку/);
    }
  });

  await suite.test('network and malformed JSON failures stay retryable', async () => {
    await assert.rejects(submitLead(payload, {
      fetcher: async () => { throw new TypeError('Mock offline'); },
    }), /Проверьте соединение/);
    await assert.rejects(submitLead(payload, {
      fetcher: async () => new Response('not json', { status: 200 }),
    }), /Не удалось отправить заявку/);
    // The same object remains available for retry; submitLead does not mutate it.
    assert.equal(payload.name, draft.name);
    assert.equal(payload.submissionId, 'mock-only-submission');
    await submitLead(payload, { fetcher: async () => response({ ok: true }) });
  });

  await suite.test('timeout aborts the mocked request', async () => {
    let aborted = false;
    await assert.rejects(submitLead(payload, {
      timeoutMs: 5,
      fetcher: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Mock request aborted', 'AbortError'));
        }, { once: true });
      }),
    }), /Сервер долго не отвечает/);
    assert.equal(aborted, true);
  });
});
