'use strict';

// Each site has a separate receiver, so the shared GitHub Pages origin is unambiguous here.
const ALLOWED_ORIGINS = new Set([
  'https://promedphoto.ru', 'https://www.promedphoto.ru',
  'https://kuznetsovphotographer-prog.github.io',
  'http://127.0.0.1:5173', 'http://localhost:5173',
]);
const DEVICE_TYPES = new Set(['computer', 'phone', 'tablet', 'unknown']);
const OS_FAMILIES = new Set(['windows', 'macos', 'android', 'ios', 'ipados', 'harmonyos', 'linux', 'chromeos', 'unknown']);
const CONTACT_METHODS = new Set(['phone', 'telegram', 'whatsapp', 'max_messenger']);
const PACKAGES = new Map([
  ['modal-package-minimal', 'Минимальный'],
  ['modal-package-base', 'Базовый'],
  ['modal-package-full', 'Полный'],
]);

function normalizedHeaders(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, headerValue]) => [
    key.toLowerCase(), Array.isArray(headerValue) ? headerValue.join(', ') : String(headerValue ?? ''),
  ]));
}

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every(key => allowed.has(key));
}

function parseLead(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const phone = typeof value.contact === 'string' ? value.contact.trim() : '';
  const packageName = PACKAGES.get(value.formId);
  const expectedSource = value.formId === 'homepage-inline' ? 'inline' : 'modal';
  if (!['homepage-inline', 'modal-general', ...PACKAGES.keys()].includes(value.formId)
    || value.source !== expectedSource
    || (packageName ? value.packageName !== packageName : Object.hasOwn(value, 'packageName'))
    || name.length < 1 || name.length > 100 || !/\p{L}/u.test(name) || /[\p{N}<>\r\n]/u.test(name)
    || !/^\+[1-9]\d{5,14}$/.test(phone) || !CONTACT_METHODS.has(value.contactMethod)
    || typeof value.phoneCountry !== 'string' || !/^[A-Z]{2}$/.test(value.phoneCountry)) return null;
  // Preserve the existing interiors-compatible schema. MAX is normalised when read by CRM.
  return { name, phone, preferredContact: value.contactMethod === 'max_messenger' ? 'max' : value.contactMethod,
    estimate: { total: 0, items: packageName ? [{ label: packageName, quantity: 1, price: 0 }] : [] } };
}

exports.parseLead = parseLead;
exports.normalizedHeaders = normalizedHeaders;
exports.ALLOWED_ORIGINS = ALLOWED_ORIGINS;
exports.DEVICE_TYPES = DEVICE_TYPES;
exports.OS_FAMILIES = OS_FAMILIES;
exports.hasOnlyKeys = hasOnlyKeys;
