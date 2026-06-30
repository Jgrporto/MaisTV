import { useEffect, useRef } from 'react';

import { claimCheckoutRenewals, completeCheckoutRenewal } from '@/lib/checkout-api';
import { runNewbrBrowserWorker } from '@/lib/newbr-browser-worker';

const POLL_INTERVAL_MS = 20000;
const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const buildWorkerId = () => {
  const random = Math.random().toString(36).slice(2);
  return `main-site-${Date.now()}-${random}`;
};

const resolveRenewalError = (result) => {
  if (!result?.renew) return 'Worker NewBR nao retornou resultado de renovacao.';
  const data = result.renew.data;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof data?.error === 'string' && data.error.trim()) return data.error.trim();
  return `NewBR HTTP ${result.renew.status || 'unknown'}`;
};

const CheckoutRenewalWorkerBridge = ({ enabled = false }) => {
  const workerIdRef = useRef(buildWorkerId());
  const runningRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let cancelled = false;
    let timer = null;

    const schedule = (delay = POLL_INTERVAL_MS) => {
      if (cancelled) return;
      timer = window.setTimeout(runOnce, delay);
    };

    const completeJob = ({ job, result, success, error }) =>
      completeCheckoutRenewal({
        paymentId: job.payment.paymentId,
        workerId: workerIdRef.current,
        source: 'main-site-worker',
        success,
        result: result?.renew || result || null,
        error: error || '',
      });

    const completeJobWithRetry = async (payload) => {
      let lastError = null;
      const maxAttempts = payload.success ? 20 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          await completeJob(payload);
          return true;
        } catch (error) {
          lastError = error;
          await delay(1000 * (attempt + 1));
        }
      }
      if (!payload.success) throw lastError || new Error('Falha ao concluir renovacao.');
      return false;
    };

    const processJob = async (job) => {
      if (!job?.payment?.paymentId || !job?.renewal) return;
      try {
        const result = await runNewbrBrowserWorker({
          mode: 'RENEW_NOW_BROWSER',
          renewal: job.renewal,
          bearerToken: '',
          timeoutMs: 60000,
        });
        const success = Boolean(result.renew?.ok);
        await completeJobWithRetry({
          job,
          result,
          success,
          error: success ? '' : resolveRenewalError(result),
        });
      } catch (error) {
        await completeJobWithRetry({
          job,
          result: null,
          success: false,
          error: error.message || 'Falha ao executar Worker NewBR.',
        });
      }
    };

    async function runOnce() {
      if (cancelled || runningRef.current) return;
      runningRef.current = true;
      try {
        const payload = await claimCheckoutRenewals({
          workerId: workerIdRef.current,
          limit: 1,
        });
        const jobs = Array.isArray(payload?.claimed) ? payload.claimed : [];
        for (const job of jobs) {
          if (cancelled) break;
          await processJob(job);
        }
        schedule(jobs.length > 0 ? 3000 : POLL_INTERVAL_MS);
      } catch {
        schedule(POLL_INTERVAL_MS);
      } finally {
        runningRef.current = false;
      }
    }

    schedule(1500 + Math.floor(Math.random() * 3000));

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled]);

  return null;
};

export default CheckoutRenewalWorkerBridge;
