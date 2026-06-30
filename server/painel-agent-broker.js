import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { readJsonBackedStore, writeJsonBackedStore } from "./sql-store.js";

const PORT = Number.parseInt(process.env.PANEL_AGENT_PORT || "5052", 10);
const ALLOWED_ORIGIN = process.env.PANEL_AGENT_ALLOWED_ORIGIN || "*";
const AGENT_TOKEN = String(process.env.PANEL_AGENT_TOKEN || "").trim();
const JOBS_PATH =
  process.env.PANEL_AGENT_JOBS_PATH || "server/data/painel-agent-jobs.json";
const MAX_JOBS = Number.parseInt(process.env.PANEL_AGENT_MAX_JOBS || "2000", 10);
const PAINEL_CUSTOMERS_PATH =
  process.env.PANEL_NEWBR_CUSTOMERS_PATH || "server/data/painel-customers.json";
const DEFAULT_COUNTRY_CODE = String(
  process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "55",
).replace(/\D/g, "") || "55";

const setCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Panel-Agent-Token");
};

const unauthorized = (res) => {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
};

const isAuthorized = (req) => {
  if (!AGENT_TOKEN) return true;
  const provided = String(req.headers["x-panel-agent-token"] || "").trim();
  return provided && provided === AGENT_TOKEN;
};

const safeReadJsonFile = async (filePath, fallback) => {
  const readFromJsonFile = async () => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : fallback;
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      return fallback;
    }
  };

  return readJsonBackedStore(filePath, fallback, readFromJsonFile);
};

const atomicWriteJson = async (filePath, data) => {
  const writeToJsonFile = async () => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  };

  await writeJsonBackedStore(filePath, data, writeToJsonFile);
};

const readStore = async () => {
  const store = await safeReadJsonFile(JOBS_PATH, { jobs: [], agents: {} });
  if (!Array.isArray(store.jobs)) store.jobs = [];
  if (!store.agents || typeof store.agents !== "object") store.agents = {};
  return store;
};

const writeStore = async (store) => {
  const jobs = Array.isArray(store.jobs) ? store.jobs : [];
  if (Number.isFinite(MAX_JOBS) && MAX_JOBS > 0 && jobs.length > MAX_JOBS) {
    jobs.sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
    store.jobs = jobs.slice(0, MAX_JOBS);
  } else {
    store.jobs = jobs;
  }
  if (!store.agents || typeof store.agents !== "object") {
    store.agents = {};
  }
  await atomicWriteJson(JOBS_PATH, store);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const now = () => new Date().toISOString();

const normalizePhone = (value) => {
  if (!value) return "";
  let digits = String(value).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length > 11) {
    digits = digits.replace(/^0+/, "");
  }
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) return digits;
  if (digits.length === 10 || digits.length === 11) return `${DEFAULT_COUNTRY_CODE}${digits}`;
  return digits;
};

const normalizeIdentity = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const sanitizeKeyPart = (value, fallback = "unknown") => {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/gi, "_")
    .slice(0, 120);
  return cleaned || fallback;
};

const buildCustomerKey = (row, fallbackSeed = "row") => {
  const identity = normalizeIdentity(
    row?.customerId || row?.id || row?.usuario || row?.username || row?.user || row?.email || "",
  );
  if (identity) return `id:${sanitizeKeyPart(identity, fallbackSeed)}`;
  const normalizedPhone = normalizePhone(
    row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
  );
  if (normalizedPhone) return `ph:${normalizedPhone}`;
  const fallback =
    row?.renewUrl || row?.renew_url || row?.m3uUrl || row?.playlist || row?.vencimento || fallbackSeed;
  return `na:${sanitizeKeyPart(fallback, fallbackSeed)}`;
};

const getCustomerEntries = (store) =>
  Object.entries(store?.customers || {}).filter(([, row]) => row && typeof row === "object");

const findCustomerEntry = (store, { phone, customerId, usuario } = {}) => {
  const entries = getCustomerEntries(store);
  const normalizedPhone = normalizePhone(phone);
  const normalizedCustomerId = normalizeIdentity(customerId);
  const normalizedUsuario = normalizeIdentity(usuario);

  if (normalizedCustomerId) {
    const match = entries.find(([, row]) => normalizeIdentity(row?.customerId || row?.id || "") === normalizedCustomerId);
    if (match) return { key: match[0], row: match[1] };
  }

  if (normalizedUsuario) {
    const match = entries.find(([, row]) => normalizeIdentity(row?.usuario || row?.username || row?.user || "") === normalizedUsuario);
    if (match) return { key: match[0], row: match[1] };
  }

  if (normalizedPhone) {
    const match = entries.find(([, row]) => {
      const rowPhone = normalizePhone(
        row?.phone || row?.whatsapp || row?.telefone || row?.mobile || row?.numero || row?.number || "",
      );
      return rowPhone === normalizedPhone;
    });
    if (match) return { key: match[0], row: match[1] };
  }

  return null;
};

const resolveCustomerStrongIdentity = (row) => ({
  customerId: normalizeIdentity(row?.customerId || row?.id || ""),
  usuario: normalizeIdentity(row?.usuario || row?.username || row?.user || ""),
});

const canMergeCustomerByUsuario = ({ incomingRow, existingRow }) => {
  if (!incomingRow || !existingRow) return false;
  const incoming = resolveCustomerStrongIdentity(incomingRow);
  const existing = resolveCustomerStrongIdentity(existingRow);

  if (!incoming.usuario || !existing.usuario) {
    return false;
  }
  if (incoming.usuario !== existing.usuario) {
    return false;
  }
  if (incoming.customerId && existing.customerId) {
    return incoming.customerId === existing.customerId;
  }
  return true;
};

const canMergeCustomerByPhone = ({ incomingRow, existingRow }) => {
  if (!incomingRow || !existingRow) return false;
  const incoming = resolveCustomerStrongIdentity(incomingRow);
  const existing = resolveCustomerStrongIdentity(existingRow);

  const incomingHasStrong = Boolean(incoming.customerId || incoming.usuario);
  const existingHasStrong = Boolean(existing.customerId || existing.usuario);

  if (!incomingHasStrong || !existingHasStrong) {
    return true;
  }
  if (incoming.customerId && existing.customerId) {
    return incoming.customerId === existing.customerId;
  }
  if (incoming.usuario && existing.usuario) {
    return incoming.usuario === existing.usuario;
  }
  return false;
};

const emptyPainelStore = () => ({
  updatedAt: null,
  customers: {},
});

const readPainelStore = async () => {
  const store = await safeReadJsonFile(PAINEL_CUSTOMERS_PATH, emptyPainelStore());
  if (!store || typeof store !== "object") return emptyPainelStore();
  const customers =
    store.customers && typeof store.customers === "object" ? store.customers : {};
  return { ...emptyPainelStore(), ...store, customers };
};

const writePainelStore = async (store) => {
  const next = store && typeof store === "object" ? store : emptyPainelStore();
  await atomicWriteJson(PAINEL_CUSTOMERS_PATH, next);
};

const toNullableNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNullableString = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

const toTextValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => {
        if (item === null || item === undefined) return "";
        if (typeof item === "string") return item.trim();
        return JSON.stringify(item);
      })
      .filter((item) => item.length > 0);
    if (!lines.length) return null;
    return lines.join("\n");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const mapImportedRow = (row) => {
  if (!row || typeof row !== "object") return null;
  const playlistValue = toTextValue(
    row.playlist ??
      row.Playlist ??
      row.m3u_url ??
      row.m3uUrl ??
      row.m3u_url_short ??
      row.m3uUrlShort,
  );
  const phone =
    normalizePhone(
      row.phone ||
        row.whatsapp ||
        row.waId ||
        row.wa_id ||
        row.msisdn ||
        row.phone_number ||
        row.numero ||
        row.telefone,
    ) || "";
  const customerId = toNullableString(row.customerId || row.customer_id || row.id);
  const usuario = toNullableString(row.usuario || row.username || row.user || row.login);
  if (!phone && !customerId && !usuario) return null;
  const safePhone = phone || "n/a";
  return {
    phone: safePhone,
    id: toNullableString(row.id || row.customerId || row.customer_id),
    customerId,
    usuario,
    username: toNullableString(row.username || row.usuario || row.user || row.login),
    password: toNullableString(row.password || row.pass),
    createdAt: toNullableString(row.created_at || row.createdAt),
    whatsapp: toNullableString(row.whatsapp || row.phone || row.telefone || row.numero || safePhone),
    status: toNullableString(row.status || row.situacao || row.state),
    connections: toNullableNumber(row.connections ?? row.conexoes ?? row.max_connections),
    planoAtual: toNullableString(
      row.planoAtual || row.plan || row.package || row.package_name || row.subscription,
    ),
    packageId: toNullableString(row.package_id || row.packageId),
    package_id: toNullableString(row.package_id || row.packageId),
    packageName: toNullableString(
      row.package || row.package_name || row.plan || row.planoAtual || row.subscription,
    ),
    conexoes: toNullableNumber(row.conexoes ?? row.connections ?? row.max_connections),
    vencimento: toNullableString(
      row.vencimento || row.expires_at_tz || row.expiry || row.expires_at || row.expiration || row.due_date,
    ),
    expiresAt: toNullableString(row.expires_at || row.expiry || row.expiration || row.due_date),
    expiresAtTz: toNullableString(row.expires_at_tz || row.expiresAtTz),
    valor: toNullableString(row.valor || row.price || row.amount),
    notas: toNullableString(row.notas || row.notes || row.obs || row.observacao),
    note: toNullableString(row.note || row.notas || row.notes || row.obs || row.observacao),
    situacao: toNullableString(row.situacao || row.status || row.state),
    renewUrl: toNullableString(row.renew_url || row.renewUrl),
    playlist: playlistValue,
    m3uUrl: toNullableString(row.m3u_url || row.m3uUrl),
    m3uUrlShort: toNullableString(row.m3u_url_short || row.m3uUrlShort),
  };
};

const upsertPainelCustomers = (store, rows) => {
  const updatedAt = now();
  const stats = {
    received: Array.isArray(rows) ? rows.length : 0,
    processed: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    mergedByCustomerId: 0,
    mergedByUsuario: 0,
    mergedByPhone: 0,
    phoneConflictSkipped: 0,
    aliasKeysRemoved: 0,
    totalBefore: Object.keys(store?.customers || {}).length,
    totalAfter: 0,
    delta: 0,
  };

  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object") {
      stats.skipped += 1;
      return;
    }
    stats.processed += 1;

    const rawPhone = row.phone ?? row.whatsapp ?? row.telefone ?? row.mobile ?? row.numero ?? row.number ?? "";
    const normalizedPhone = normalizePhone(rawPhone);
    const safePhone = normalizedPhone || String(rawPhone || "").trim() || "n/a";
    const customerKey = buildCustomerKey(
      {
        ...row,
        phone: safePhone,
        whatsapp: row.whatsapp ?? safePhone,
      },
      `row-${rowIndex}`,
    );

    const identityCustomerId = row.customerId || row.id || null;
    const identityUsuario = row.usuario || row.username || row.user || null;
    const identityPhone = safePhone && safePhone !== "n/a" ? safePhone : null;

    let matchedEntry = null;
    let matchedBy = null;
    if (identityCustomerId) {
      matchedEntry = findCustomerEntry(store, { customerId: identityCustomerId });
      if (matchedEntry) matchedBy = "customerId";
    }
    if (!matchedEntry && !identityCustomerId && identityUsuario) {
      const usuarioEntry = findCustomerEntry(store, { usuario: identityUsuario });
      if (usuarioEntry && canMergeCustomerByUsuario({ incomingRow: row, existingRow: usuarioEntry.row })) {
        matchedEntry = usuarioEntry;
        matchedBy = "usuario";
      }
    }
    if (!matchedEntry && !identityCustomerId && identityPhone) {
      const phoneEntry = findCustomerEntry(store, { phone: identityPhone });
      if (phoneEntry && canMergeCustomerByPhone({ incomingRow: row, existingRow: phoneEntry.row })) {
        matchedEntry = phoneEntry;
        matchedBy = "phone";
      } else if (phoneEntry) {
        stats.phoneConflictSkipped += 1;
      }
    }

    if (matchedBy === "customerId") stats.mergedByCustomerId += 1;
    if (matchedBy === "usuario") stats.mergedByUsuario += 1;
    if (matchedBy === "phone") stats.mergedByPhone += 1;

    if (matchedEntry?.key && matchedEntry.key !== customerKey) {
      delete store.customers[matchedEntry.key];
      stats.aliasKeysRemoved += 1;
    }

    const existing = {
      ...(matchedEntry?.row || store.customers?.[customerKey] || {}),
    };
    const hadExisting = Object.keys(existing).length > 0;
    store.customers[customerKey] = {
      ...existing,
      ...row,
      phone: safePhone,
      whatsapp: row.whatsapp ?? (safePhone && safePhone !== "n/a" ? safePhone : existing.whatsapp ?? existing.phone ?? null),
      customerId: row.customerId ?? row.id ?? existing.customerId ?? existing.id ?? null,
      id: row.id ?? row.customerId ?? existing.id ?? existing.customerId ?? null,
      usuario: row.usuario ?? row.username ?? existing.usuario ?? existing.username ?? null,
      username: row.username ?? row.usuario ?? existing.username ?? existing.usuario ?? null,
      missingInSync: false,
      source: row.source ?? existing.source ?? "painel-sync",
    };

    if (hadExisting) {
      stats.updated += 1;
    } else {
      stats.inserted += 1;
    }
  });

  store.updatedAt = updatedAt;
  stats.totalAfter = Object.keys(store?.customers || {}).length;
  stats.delta = stats.totalAfter - stats.totalBefore;
  return stats;
};

const isImportJob = (job) => job && job.type === "import_customers";
const isImportJobActive = (job) =>
  isImportJob(job) && (job.status === "queued" || job.status === "running");

const findLatestImportJob = (store, predicate = () => true) =>
  [...(store.jobs || [])]
    .filter((job) => isImportJob(job) && predicate(job))
    .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0))[0] || null;

const buildSyncStatus = (store) => {
  const importJobs = [...(store.jobs || [])]
    .filter(isImportJob)
    .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
  const latest = importJobs[0] || null;
  const running = latest ? latest.status === "queued" || latest.status === "running" : false;
  const logs = importJobs.slice(0, 50).map((job) => {
    const status = String(job.status || "queued");
    const when = job.updatedAt || job.createdAt || now();
    let message = `Job ${status}`;
    if (status === "queued") message = "Job enfileirado para agente local";
    if (status === "running") message = `Executando no agente ${job.assignedAgent || "local-agent"}`;
    if (status === "done") {
      const imported = Number(job.result?.importedRows ?? job.result?.processed ?? 0) || 0;
      const inserted = Number(job.result?.inserted ?? 0) || 0;
      const updated = Number(job.result?.updated ?? 0) || 0;
      const merged =
        (Number(job.result?.mergedByCustomerId ?? 0) || 0) +
        (Number(job.result?.mergedByUsuario ?? 0) || 0) +
        (Number(job.result?.mergedByPhone ?? 0) || 0);
      const aliases = Number(job.result?.aliasKeysRemoved ?? 0) || 0;
      const phoneConflictSkipped = Number(job.result?.phoneConflictSkipped ?? 0) || 0;
      const total = Number(job.result?.totalAfter ?? job.result?.total ?? 0) || 0;
      message =
        `Sincronizacao concluida: recebidos=${imported}, novos=${inserted}, atualizados=${updated}, ` +
        `mesclados=${merged}, conflitos-telefone=${phoneConflictSkipped}, aliases-removidos=${aliases}, total-local=${total}`;
    }
    if (status === "failed") message = `Falha: ${job.error || "erro desconhecido"}`;
    if (status === "rejected") message = `Rejeitado no agente: ${job.error || "sem motivo informado"}`;
    if (status === "cancelled") message = `Sincronizacao cancelada: ${job.error || "cancelado pelo usuario"}`;
    return { at: when, message };
  });
  const agents = Object.values(store?.agents || {}).filter((item) => item && typeof item === "object");
  agents.sort((a, b) => (Date.parse(b.lastSeenAt || "") || 0) - (Date.parse(a.lastSeenAt || "") || 0));
  const latestAgent = agents[0] || null;
  const latestSeenAt = Date.parse(latestAgent?.lastSeenAt || "") || 0;
  const agentOnline = Boolean(latestAgent && latestSeenAt > Date.now() - 30000);

  return {
    running,
    startedAt: latest?.startedAt || latest?.createdAt || null,
    finishedAt: latest?.finishedAt || null,
    error:
      latest?.status === "failed" ||
      latest?.status === "rejected" ||
      latest?.status === "cancelled"
        ? latest?.error || null
        : null,
    agentOnline,
    lastAgentAt: latestAgent?.lastSeenAt || null,
    lastAgentId: latestAgent?.agentId || null,
    logs,
    job: latest,
  };
};

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/painel-agent/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, now: now() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel-agent/sync-status") {
    try {
      const store = await readStore();
      const status = buildSyncStatus(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "sync status error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel-agent/agents/heartbeat") {
    try {
      const body = await readJson(req);
      const agentId = String(body.agentId || "").trim();
      if (!agentId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing agentId" }));
        return;
      }
      const store = await readStore();
      store.agents[agentId] = {
        agentId,
        lastSeenAt: now(),
        version: body.version ? String(body.version) : null,
      };
      await writeStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "heartbeat error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel-agent/sync/start") {
    try {
      const body = await readJson(req);
      const store = await readStore();
      const active = findLatestImportJob(store, isImportJobActive);
      if (active) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildSyncStatus(store)));
        return;
      }

      const job = {
        id: randomUUID(),
        type: "import_customers",
        payload: body.payload && typeof body.payload === "object" ? body.payload : {},
        status: "queued",
        requestedBy: body.requestedBy || "gerenciamento-ui",
        createdAt: now(),
        updatedAt: now(),
        assignedAgent: null,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      };
      store.jobs.push(job);
      await writeStore(store);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildSyncStatus(store)));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "sync start error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel-agent/sync/cancel") {
    try {
      const body = await readJson(req);
      const reason = String(body.reason || "Cancelado pelo usuario").trim();
      const targetJobId = String(body.jobId || "").trim();

      const store = await readStore();
      const target = targetJobId
        ? store.jobs.find((job) => job.id === targetJobId && isImportJob(job))
        : findLatestImportJob(store, isImportJobActive);

      if (!target) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildSyncStatus(store)));
        return;
      }

      if (target.status === "done" || target.status === "failed" || target.status === "rejected" || target.status === "cancelled") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildSyncStatus(store)));
        return;
      }

      target.status = "cancelled";
      target.updatedAt = now();
      target.finishedAt = now();
      target.error = reason || "Cancelado pelo usuario";

      const index = store.jobs.findIndex((job) => job.id === target.id);
      if (index >= 0) {
        store.jobs[index] = target;
      }

      await writeStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildSyncStatus(store)));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "sync cancel error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel-agent/customers/import") {
    try {
      const body = await readJson(req);
      const incomingRows = Array.isArray(body.rows) ? body.rows : [];
      const replaceAll = body.replaceAll !== false;
      const source = String(body.source || "local-agent").trim();
      const normalizedRows = incomingRows
        .map(mapImportedRow)
        .filter(Boolean);

      const painelStore = await readPainelStore();
      if (replaceAll) {
        painelStore.customers = {};
      }
      const stats = upsertPainelCustomers(painelStore, normalizedRows);
      await writePainelStore(painelStore);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        imported: normalizedRows.length,
        processed: stats.processed,
        skipped: stats.skipped,
        inserted: stats.inserted,
        updated: stats.updated,
        mergedByCustomerId: stats.mergedByCustomerId,
        mergedByUsuario: stats.mergedByUsuario,
        mergedByPhone: stats.mergedByPhone,
        phoneConflictSkipped: stats.phoneConflictSkipped,
        aliasKeysRemoved: stats.aliasKeysRemoved,
        total: stats.totalAfter,
        totalBefore: stats.totalBefore,
        totalAfter: stats.totalAfter,
        delta: stats.delta,
        stats,
        updatedAt: painelStore.updatedAt,
        source,
      }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "customers import error" }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/painel-agent/jobs") {
    try {
      const body = await readJson(req);
      const type = String(body.type || "").trim();
      if (!type) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing type" }));
        return;
      }

      const store = await readStore();
      const job = {
        id: randomUUID(),
        type,
        payload: body.payload && typeof body.payload === "object" ? body.payload : {},
        status: "queued",
        requestedBy: body.requestedBy || "vps",
        createdAt: now(),
        updatedAt: now(),
        assignedAgent: null,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      };
      store.jobs.push(job);
      await writeStore(store);

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "create job error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel-agent/jobs") {
    try {
      const limit = Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10));
      const status = String(url.searchParams.get("status") || "").trim();
      const store = await readStore();
      let jobs = [...store.jobs];
      jobs.sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0));
      if (status) jobs = jobs.filter((job) => job.status === status);
      jobs = jobs.slice(0, limit);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobs }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "list jobs error" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/painel-agent/jobs/next") {
    try {
      const store = await readStore();
      const job = [...store.jobs]
        .filter((item) => item.status === "queued")
        .sort((a, b) => (Date.parse(a.createdAt || "") || 0) - (Date.parse(b.createdAt || "") || 0))[0] || null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "next job error" }));
    }
    return;
  }

  const decisionMatch =
    req.method === "POST" &&
    url.pathname.match(/^\/api\/painel-agent\/jobs\/([^/]+)\/decision$/);
  if (decisionMatch) {
    try {
      const jobId = decisionMatch[1];
      const body = await readJson(req);
      const approved = Boolean(body.approved);
      const agentId = String(body.agentId || "local-agent").trim();

      const store = await readStore();
      const index = store.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Job not found" }));
        return;
      }

      const job = store.jobs[index];
      if (job.status !== "queued") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Job is ${job.status}` }));
        return;
      }

      job.updatedAt = now();
      job.assignedAgent = agentId;
      if (approved) {
        job.status = "running";
        job.startedAt = now();
      } else {
        job.status = "rejected";
        job.finishedAt = now();
        job.error = body.reason || "Rejected by local agent";
      }

      store.jobs[index] = job;
      await writeStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "decision error" }));
    }
    return;
  }

  const resultMatch =
    req.method === "POST" &&
    url.pathname.match(/^\/api\/painel-agent\/jobs\/([^/]+)\/result$/);
  if (resultMatch) {
    try {
      const jobId = resultMatch[1];
      const body = await readJson(req);
      const store = await readStore();
      const index = store.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Job not found" }));
        return;
      }

      const job = store.jobs[index];
      if (job.status === "cancelled") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ job, ignored: true, message: "Job cancelado; resultado ignorado" }));
        return;
      }
      if (job.status !== "running") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Job is ${job.status}` }));
        return;
      }

      const success = Boolean(body.success);
      job.status = success ? "done" : "failed";
      job.updatedAt = now();
      job.finishedAt = now();
      job.result = body.result ?? null;
      job.error = body.error ?? null;
      if (body.agentId) {
        job.assignedAgent = String(body.agentId);
      }

      store.jobs[index] = job;
      await writeStore(store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "result error" }));
    }
    return;
  }

  const getJobMatch =
    req.method === "GET" &&
    url.pathname.match(/^\/api\/painel-agent\/jobs\/([^/]+)$/);
  if (getJobMatch) {
    try {
      const jobId = getJobMatch[1];
      const store = await readStore();
      const job = store.jobs.find((item) => item.id === jobId);
      if (!job) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Job not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "get job error" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Painel agent broker running on http://localhost:${PORT}`);
});
