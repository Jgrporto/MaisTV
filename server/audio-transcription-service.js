import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_WHISPER_TIMEOUT_MS = 180000;
const DEFAULT_WHISPER_LANGUAGE = "pt";
const DEFAULT_WHISPER_MODEL = "tiny";
const PROCESSING_FRESH_MARGIN_MS = 5000;

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const resolveWhisperTimeoutMs = () =>
  parsePositiveInteger(process.env.WHISPER_TIMEOUT_MS, DEFAULT_WHISPER_TIMEOUT_MS);

const resolveWhisperTmpDir = () =>
  path.resolve(process.env.WHISPER_TMP_DIR || path.join(os.tmpdir(), "maistv-whisper"));

const resolveWhisperServiceUrl = () => String(process.env.WHISPER_SERVICE_URL || "").trim().replace(/\/+$/, "");

export const getAudioTranscriptionStatus = (message = {}) => {
  const transcription = message?.transcription && typeof message.transcription === "object"
    ? message.transcription
    : null;
  return {
    status: transcription?.status || null,
    text: String(transcription?.text || "").trim(),
    error: String(transcription?.error || "").trim(),
    language: transcription?.language || null,
    model: transcription?.model || null,
    updatedAt: transcription?.updatedAt || null,
    startedAt: transcription?.startedAt || null,
  };
};

export const isProcessingTranscriptionFresh = (transcription = {}) => {
  if (!transcription || transcription.status !== "processing") return false;
  const startedAtMs = Date.parse(String(transcription.startedAt || transcription.updatedAt || ""));
  if (!Number.isFinite(startedAtMs)) return false;
  return Date.now() - startedAtMs <= resolveWhisperTimeoutMs() + PROCESSING_FRESH_MARGIN_MS;
};

const resolveAudioExtension = (mimeType = "") => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mp4") || normalized.includes("aac")) return "m4a";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("amr")) return "amr";
  return "ogg";
};

const runWhisperViaService = async ({ buffer, mimeType, timeoutMs, model, language }) => {
  const serviceUrl = resolveWhisperServiceUrl();
  if (!serviceUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serviceUrl}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: buffer.toString("base64"),
        mimeType,
        model,
        language,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!response.ok) {
      throw new Error(data?.error || `Whisper service failed (${response.status})`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
};

const runWhisperProcess = ({ filePath, timeoutMs, model, language }) =>
  new Promise((resolve, reject) => {
    const pythonBin = process.env.WHISPER_PYTHON_BIN || process.env.PYTHON_BIN || "python";
    const scriptPath = path.resolve("server", "whisper-transcribe.py");
    const args = [
      scriptPath,
      filePath,
      "--model",
      model,
      "--language",
      language,
    ];
    const child = spawn(pythonBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Whisper excedeu ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Whisper falhou com codigo ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        resolve(parsed);
      } catch {
        const text = stdout.trim();
        if (text) {
          resolve({ text });
          return;
        }
        reject(new Error(stderr.trim() || "Whisper nao retornou texto"));
      }
    });
  });

export const transcribeAudioMessage = async ({
  message,
  downloadAudioBuffer,
  updateMessageTranscription,
  force = false,
}) => {
  const existing = getAudioTranscriptionStatus(message);
  if (existing.text && !force) return existing;
  if (existing.status === "processing" && isProcessingTranscriptionFresh(message.transcription) && !force) {
    return existing;
  }

  const attachment = (Array.isArray(message?.attachments) ? message.attachments : []).find(
    (item) => String(item?.type || "").toLowerCase() === "audio",
  );
  if (!attachment) {
    throw new Error("Mensagem nao possui audio para transcrever");
  }

  const model = process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
  const language = process.env.WHISPER_LANGUAGE || DEFAULT_WHISPER_LANGUAGE;
  const timeoutMs = resolveWhisperTimeoutMs();
  const now = new Date().toISOString();
  await updateMessageTranscription({
    status: "processing",
    text: existing.text || "",
    error: "",
    model,
    language,
    startedAt: now,
    updatedAt: now,
  });

  const tmpDir = resolveWhisperTmpDir();
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${randomUUID()}.${resolveAudioExtension(attachment.mimeType)}`);

  try {
    const { buffer, mimeType } = await downloadAudioBuffer(attachment);
    if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
      throw new Error("Audio vazio ou indisponivel");
    }
    await fs.writeFile(filePath, buffer);
    const result =
      (await runWhisperViaService({ buffer, mimeType, timeoutMs, model, language })) ||
      (await runWhisperProcess({ filePath, timeoutMs, model, language }));
    const text = String(result?.text || "").trim();
    if (!text) {
      throw new Error("Whisper nao encontrou texto no audio");
    }
    const completed = {
      status: "completed",
      text,
      error: "",
      model,
      language: result?.language || language,
      mimeType: mimeType || attachment.mimeType || null,
      duration: result?.duration || null,
      startedAt: now,
      updatedAt: new Date().toISOString(),
    };
    await updateMessageTranscription(completed);
    return completed;
  } catch (error) {
    const failed = {
      status: "failed",
      text: "",
      error: error?.message || "Falha ao transcrever audio",
      model,
      language,
      startedAt: now,
      updatedAt: new Date().toISOString(),
    };
    await updateMessageTranscription(failed);
    throw error;
  } finally {
    await fs.unlink(filePath).catch(() => undefined);
  }
};
