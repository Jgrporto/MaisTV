const TEMPLATE_MEDIA_ROUTE_PREFIX = "/api/whatsapp/templates/local/media/";

const normalizeOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
};

const buildAbsoluteUrl = (origin, raw) => {
  if (!origin || !raw.startsWith("/")) return raw;
  return `${origin.replace(/\/+$/, "")}${raw}`;
};

export const resolveTemplateMediaPublicOrigin = ({
  explicitOrigin = "",
  apiBaseUrl = "",
  fallbackOrigin = "",
} = {}) => {
  return (
    normalizeOrigin(explicitOrigin) ||
    normalizeOrigin(apiBaseUrl) ||
    normalizeOrigin(fallbackOrigin) ||
    ""
  );
};

export const normalizeTemplateMediaUrl = (
  value,
  {
    publicOrigin = "",
    apiBaseUrl = "",
    fallbackOrigin = "",
  } = {},
) => {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const resolvedOrigin = resolveTemplateMediaPublicOrigin({
    explicitOrigin: publicOrigin,
    apiBaseUrl,
    fallbackOrigin,
  });

  if (raw.startsWith(TEMPLATE_MEDIA_ROUTE_PREFIX)) {
    return buildAbsoluteUrl(resolvedOrigin, raw);
  }

  if (!/^https?:\/\//i.test(raw)) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if (!url.pathname.startsWith(TEMPLATE_MEDIA_ROUTE_PREFIX)) {
      return raw;
    }
    if (!resolvedOrigin) {
      return raw;
    }
    return `${resolvedOrigin}${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
};
