export const runNewbrBrowserWorker = ({ mode = 'PREPARE_ONLY', renewal, bearerToken, timeoutMs = 45000 } = {}) =>
  new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.Worker) {
      reject(new Error('Este navegador nao suporta Web Worker.'));
      return;
    }

    const worker = new Worker('/newbr-login-worker.js');
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('Tempo limite ao executar Worker NewBR.'));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event?.message || 'Erro ao executar Worker NewBR.'));
    };

    worker.onmessage = (event) => {
      const result = event.data || {};
      if (result.type === 'FLOW_ERROR') {
        cleanup();
        reject(new Error(result.message || 'Falha no Worker NewBR.'));
        return;
      }

      if (result.type !== 'FLOW_RESULT') return;
      cleanup();

      if (!result.login?.ok || !result.login?.token) {
        reject(new Error('Login NewBR nao retornou token Bearer valido.'));
        return;
      }

      resolve({
        login: result.login,
        renew: result.renew || null,
      });
    };

    worker.postMessage({ type: mode, renewal, bearerToken });
  });
