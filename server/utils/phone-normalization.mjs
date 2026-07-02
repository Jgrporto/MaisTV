const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const cleanCode = (value, fallback) => digitsOnly(value) || fallback;

export const normalizePhone = (value, options = {}) => {
  let digits = digitsOnly(value);
  if (!digits) return '';

  const countryCode = cleanCode(options.countryCode ?? process.env.PHONE_DEFAULT_COUNTRY_CODE, '55');
  const areaCode = cleanCode(options.areaCode ?? process.env.PHONE_DEFAULT_AREA_CODE, '24');

  while (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length >= 11) digits = digits.slice(1);

  if (digits.startsWith(countryCode) && [countryCode.length + 10, countryCode.length + 11].includes(digits.length)) {
    return digits;
  }
  if ([10, 11].includes(digits.length)) return `${countryCode}${digits}`;
  if ([8, 9].includes(digits.length) && areaCode) return `${countryCode}${areaCode}${digits}`;

  return digits;
};

export const buildPhoneLookupKeys = (value, options = {}) => {
  const raw = digitsOnly(value);
  const normalized = normalizePhone(value, options);
  const keys = new Set([raw, normalized]);
  const countryCode = cleanCode(options.countryCode ?? process.env.PHONE_DEFAULT_COUNTRY_CODE, '55');
  if (normalized.startsWith(countryCode)) keys.add(normalized.slice(countryCode.length));
  if (normalized.length >= 11) keys.add(normalized.slice(-11));
  if (normalized.length >= 10) keys.add(normalized.slice(-10));
  if (normalized.length >= 9) keys.add(normalized.slice(-9));
  return Array.from(keys).filter(Boolean);
};

export const phonesMatch = (left, right, options = {}) => {
  const leftKeys = new Set(buildPhoneLookupKeys(left, options));
  return buildPhoneLookupKeys(right, options).some((key) => leftKeys.has(key));
};

