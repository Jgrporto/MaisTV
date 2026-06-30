import { fetchWhatsappCoexistence, fetchWhatsappSession } from './whatsapp-api';
import {
  DEFAULT_SERVICE_PHONE_NUMBER,
  normalizePhoneDisplay,
  normalizeService,
  sortServices,
} from './services';
import { parseJsonResponse, requestLocalApi } from '@/lib/local-api';

const requestServicesJson = async (path = '', options = {}) => {
  const response = await requestLocalApi(`/entities/Service${path}`, options);
  const data = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(data?.error || 'Falha ao salvar servico.');
  }

  return data;
};

const extractDigitsFromValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  if (raw.includes('@')) {
    return raw.split('@')[0].replace(/\D/g, '');
  }

  return raw.replace(/\D/g, '');
};

const collectSessionNumbers = (value, bucket, depth = 0) => {
  if (depth > 5 || value == null) {
    return;
  }

  if (typeof value === 'string') {
    const digits = extractDigitsFromValue(value);
    if (digits.length >= 10 && digits.length <= 15) {
      bucket.add(normalizePhoneDisplay(digits));
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSessionNumbers(item, bucket, depth + 1));
    return;
  }

  if (typeof value === 'object') {
    const preferredKeys = [
      'phone',
      'phoneNumber',
      'displayPhoneNumber',
      'number',
      'wid',
      'id',
      'me',
      'user',
    ];

    preferredKeys.forEach((key) => {
      if (key in value) {
        collectSessionNumbers(value[key], bucket, depth + 1);
      }
    });
  }
};

const readCommaSeparatedEnv = (value) =>
  String(value || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);

const readDiscoveryApiBaseUrls = () =>
  Array.from(
    new Set(
      readCommaSeparatedEnv(
        import.meta.env.VITE_WHATSAPP_API_DISCOVERY_URLS ||
          import.meta.env.VITE_WHATSAPP_API_ADDITIONAL_BASE_URLS ||
          ''
      )
    )
  );

const readKnownWhatsappNumbers = () =>
  readCommaSeparatedEnv(import.meta.env.VITE_WHATSAPP_KNOWN_NUMBERS || '').map(normalizePhoneDisplay).filter(Boolean);

const readExcludedWhatsappNumbers = () =>
  readCommaSeparatedEnv(import.meta.env.VITE_WHATSAPP_EXCLUDED_NUMBERS || '')
    .map(normalizePhoneDisplay)
    .filter(Boolean);

const collectCoexistenceNumbers = (value, bucket) => {
  if (!value || typeof value !== 'object') {
    return;
  }

  [
    value.displayPhoneNumber,
    value.display_phone_number,
    value.phoneNumber,
    value.phone_number,
    value.number,
  ].forEach((candidate) => {
    const normalized = normalizePhoneDisplay(candidate);
    if (normalized) {
      bucket.add(normalized);
    }
  });
};

export const fetchServices = async () => {
  const data = await requestServicesJson('?sort=name', { method: 'GET' });
  return sortServices((Array.isArray(data) ? data : []).map((service, index) => normalizeService(service, index)));
};

export const saveService = async (serviceId, payload) => {
  if (serviceId) {
    return normalizeService(
      await requestServicesJson(`/${encodeURIComponent(serviceId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload || {}),
      }),
    );
  }

  return normalizeService(
    await requestServicesJson('', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    }),
  );
};

export const deleteService = async (serviceId) => {
  const safeServiceId = String(serviceId || '').trim();
  if (!safeServiceId) {
    return { ok: true };
  }

  return await requestServicesJson(`/${encodeURIComponent(safeServiceId)}`, {
    method: 'DELETE',
  });
};

export const fetchAvailableWhatsappNumbers = async (existingServices = []) => {
  const numbers = new Set([normalizePhoneDisplay(DEFAULT_SERVICE_PHONE_NUMBER)]);
  const excludedNumbers = new Set(readExcludedWhatsappNumbers());

  existingServices.forEach((service) => {
    (Array.isArray(service?.phone_numbers) ? service.phone_numbers : []).forEach((phoneNumber) => {
      const normalized = normalizePhoneDisplay(phoneNumber);
      if (normalized) {
        numbers.add(normalized);
      }
    });
  });

  readKnownWhatsappNumbers().forEach((number) => numbers.add(number));

  const discoveryBaseUrls = readDiscoveryApiBaseUrls();
  const discoveryTasks = [
    async () => {
      const session = await fetchWhatsappSession();
      collectSessionNumbers(session, numbers);
    },
    async () => {
      const coexistence = await fetchWhatsappCoexistence();
      collectCoexistenceNumbers(coexistence, numbers);
    },
    ...discoveryBaseUrls.flatMap((baseUrl) => [
      async () => {
        const session = await fetchWhatsappSession(baseUrl);
        collectSessionNumbers(session, numbers);
      },
      async () => {
        const coexistence = await fetchWhatsappCoexistence(baseUrl);
        collectCoexistenceNumbers(coexistence, numbers);
      },
    ]),
  ];

  await Promise.allSettled(discoveryTasks.map((task) => task()));

  return Array.from(numbers).filter((number) => !excludedNumbers.has(number));
};
