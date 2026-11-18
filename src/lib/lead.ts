import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';
import countryNames from '../data/country-names.json' with { type: 'json' };

export const LEAD_ENDPOINT = 'https://functions.yandexcloud.net/d4efp1mug81s92flsuep';
export const LEAD_CONSENT_VERSION = '2026-11-18-medical-postbox-1';
export const LEAD_SUCCESS_KEY = 'photoprobiz:lead-success';
export const LEAD_PRIVACY_URL = '/privacy/';
export const LEAD_CONSENT_URL = '/consent/';

export type LeadMode = 'inline' | 'modal';
export type PackageKey = 'minimal' | 'base' | 'full';
export type ContactMethod = 'phone' | 'telegram' | 'whatsapp' | 'max_messenger';
export type DeviceType = 'computer' | 'phone' | 'tablet' | 'unknown';
export type OsFamily = 'windows' | 'macos' | 'android' | 'ios' | 'ipados' | 'harmonyos' | 'linux' | 'chromeos' | 'unknown';

export const LEAD_PACKAGES: Record<PackageKey, string> = {
  minimal: 'Минимальный',
  base: 'Базовый',
  full: 'Полный',
};

export const CONTACT_METHODS: { value: ContactMethod; label: string }[] = [
  { value: 'phone', label: 'Телефон' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'max_messenger', label: 'Max' },
];

const deviceTypes: DeviceType[] = ['computer', 'phone', 'tablet', 'unknown'];
const osFamilies: OsFamily[] = ['windows', 'macos', 'android', 'ios', 'ipados', 'harmonyos', 'linux', 'chromeos', 'unknown'];
const packageFormIds: Record<PackageKey, string> = {
  minimal: 'modal-package-minimal',
  base: 'modal-package-base',
  full: 'modal-package-full',
};

export interface LeadPayload {
  name: string;
  contact: string;
  contactMethod: ContactMethod;
  consent: boolean;
  source: LeadMode;
  consentAcceptedAt: string;
  consentVersion: string;
  submissionId: string;
  formId: string;
  phoneCountry: CountryCode;
  deviceType: DeviceType;
  osFamily: OsFamily;
  packageName?: string;
}

export type LeadErrors = Partial<Record<'name' | 'contact' | 'consent', string>>;

export interface LeadDraft {
  name: string;
  phone: string;
  phoneCountry: CountryCode;
  contactMethod: ContactMethod;
  consent: boolean;
  consentAcceptedAt: string;
  mode: LeadMode;
  packageKey?: PackageKey;
}

interface NavigatorInfo {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}

export function getDeviceContext(info?: NavigatorInfo): Pick<LeadPayload, 'deviceType' | 'osFamily'> {
  const browserInfo: NavigatorInfo | undefined = info ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!browserInfo) return { deviceType: 'unknown', osFamily: 'unknown' };
  const ua = (browserInfo.userAgent ?? '').toLowerCase();
  const platform = (browserInfo.userAgentData?.platform ?? browserInfo.platform ?? '').toLowerCase();
  const mobile = browserInfo.userAgentData?.mobile === true || /\bmobile\b/.test(ua);
  if (/openharmony|harmonyos|huawei.*harmony/.test(`${ua} ${platform}`)) {
    return { deviceType: /\b(tablet|pad)\b/.test(ua) ? 'tablet' : mobile ? 'phone' : 'unknown', osFamily: 'harmonyos' };
  }
  if (/ipad/.test(ua) || (/mac/.test(platform) && (browserInfo.maxTouchPoints ?? 0) > 1)) return { deviceType: 'tablet', osFamily: 'ipados' };
  if (/iphone|ipod/.test(ua)) return { deviceType: 'phone', osFamily: 'ios' };
  if (/android/.test(`${ua} ${platform}`)) return { deviceType: mobile ? 'phone' : 'tablet', osFamily: 'android' };
  if (/cros|chrome\s?os/.test(`${ua} ${platform}`)) return { deviceType: 'computer', osFamily: 'chromeos' };
  if (/windows|win32|win64/.test(`${ua} ${platform}`)) return { deviceType: 'computer', osFamily: 'windows' };
  if (/macintosh|macintel|macos|mac os x/.test(`${ua} ${platform}`)) return { deviceType: 'computer', osFamily: 'macos' };
  if (/linux|x11/.test(`${ua} ${platform}`)) return { deviceType: 'computer', osFamily: 'linux' };
  return { deviceType: mobile ? 'phone' : 'unknown', osFamily: 'unknown' };
}

export function getPhoneCountries(): { code: CountryCode; name: string; callingCode: string }[] {
  // The JSON order and labels are fixed at build time. Browser/Node ICU versions
  // must never choose different option text or ordering during hydration.
  const labels: Record<string, string> = countryNames;
  const order = new Map(Object.keys(labels).map((code, index) => [code, index]));
  return getCountries().map((code) => ({ code, name: labels[code] ?? code, callingCode: getCountryCallingCode(code) }))
    .sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
}

export function formatPhoneInput(raw: string, country: CountryCode): { phone: string; country: CountryCode } {
  let nextCountry = country;
  let digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) {
    const parsed = parsePhoneNumberFromString(raw);
    const formatter = new AsYouType();
    formatter.input(raw);
    const matchingCountries = getCountries().filter((code) => digits.startsWith(getCountryCallingCode(code)))
      .sort((a, b) => getCountryCallingCode(b).length - getCountryCallingCode(a).length);
    nextCountry = parsed?.country ?? formatter.getCountry()
      ?? (matchingCountries.includes(country) ? country : digits.startsWith('1') ? 'US' : matchingCountries[0]) ?? country;
    const callingCode = getCountryCallingCode(nextCountry);
    if (digits.startsWith(callingCode)) digits = digits.slice(callingCode.length);
  } else if (getCountryCallingCode(country) === '7' && digits.length === 11 && /^[78]/.test(digits)) {
    digits = digits.slice(1);
  }
  digits = digits.slice(0, 15 - getCountryCallingCode(nextCountry).length);
  return { phone: new AsYouType(nextCountry).input(digits), country: nextCountry };
}

export function getE164(phone: string, country: CountryCode): string {
  const parsed = parsePhoneNumberFromString(phone, country);
  return parsed?.number ?? `+${getCountryCallingCode(country)}${phone.replace(/\D/g, '')}`;
}

export function createSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new LeadSubmitError('Браузер не поддерживает безопасную отправку. Пожалуйста, позвоните нам.');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildLeadPayload(draft: LeadDraft, submissionId: string, device = getDeviceContext()): LeadPayload {
  return {
    name: draft.name.trim(),
    contact: draft.phone.trim() ? getE164(draft.phone, draft.phoneCountry) : '',
    contactMethod: draft.contactMethod,
    consent: draft.consent,
    source: draft.mode,
    consentAcceptedAt: draft.consentAcceptedAt,
    consentVersion: LEAD_CONSENT_VERSION,
    submissionId,
    formId: draft.mode === 'inline' ? 'homepage-inline' : draft.packageKey ? packageFormIds[draft.packageKey] : 'modal-general',
    phoneCountry: draft.phoneCountry,
    ...device,
    ...(draft.packageKey ? { packageName: LEAD_PACKAGES[draft.packageKey] } : {}),
  };
}

export function validateLeadPayload(payload: LeadPayload): LeadErrors {
  const errors: LeadErrors = {};
  const name = payload.name.trim();
  if (!name) errors.name = 'Укажите ваше имя.';
  else if (name.length > 100 || !/\p{L}/u.test(name) || /[\p{N}<>]/u.test(name)) errors.name = 'Введите имя без цифр и символов < >.';
  if (!payload.contact) errors.contact = 'Укажите номер телефона.';
  else if (!/^\+[1-9]\d{5,14}$/.test(payload.contact) || !isValidPhoneNumber(payload.contact)) errors.contact = 'Проверьте номер телефона и код страны.';
  if (!payload.consent || payload.consentVersion !== LEAD_CONSENT_VERSION || !Number.isFinite(Date.parse(payload.consentAcceptedAt))
    || !payload.submissionId || !payload.formId || !deviceTypes.includes(payload.deviceType) || !osFamilies.includes(payload.osFamily)) {
    errors.consent = 'Для отправки заявки нужно ваше согласие.';
  }
  return errors;
}

export class LeadSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadSubmitError';
  }
}

/** Inject a mock fetcher in tests. Never use the production endpoint for test submissions. */
export async function submitLead(payload: LeadPayload, options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  if (Object.keys(validateLeadPayload(payload)).length) throw new LeadSubmitError('Проверьте поля формы.');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 12_000);
  try {
    const response = await (options.fetcher ?? fetch)(LEAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new LeadSubmitError('Не удалось отправить заявку. Попробуйте ещё раз.');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true) {
      throw new LeadSubmitError('Сервер не подтвердил отправку. Попробуйте ещё раз.');
    }
  } catch (error) {
    if (timedOut) throw new LeadSubmitError('Сервер долго не отвечает. Проверьте соединение и попробуйте ещё раз.');
    if (options.signal?.aborted) throw error;
    if (error instanceof LeadSubmitError) throw error;
    throw new LeadSubmitError('Не удалось отправить заявку. Проверьте соединение и попробуйте ещё раз.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
