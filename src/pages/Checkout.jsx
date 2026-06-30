import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, Copy, CreditCard, Loader2, Phone, QrCode, User, Wallet } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  createMercadoPagoPreference,
  createPixPayment,
  claimCheckoutRenewals,
  completeCheckoutRenewal,
  fetchCheckoutRenewalCheckoutStatus,
  fetchMercadoPagoConfig,
  notifyCheckoutNewbrBrowserStart,
  resolveCheckoutToken,
  saveCheckoutNewbrBrowserToken,
  saveCheckoutRenewalIntent,
} from '@/lib/checkout-api';
import { isAllowedCheckoutConnections, isAllowedCheckoutMonths, resolveCheckoutPrice } from '@/lib/checkout-pricing';
import { resolveCheckoutPlan } from '@/lib/checkout-plan';
import { runNewbrBrowserWorker } from '@/lib/newbr-browser-worker';
import { cn } from '@/lib/utils';

const splitName = (fullName) => {
  const normalized = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return { firstName: undefined, lastName: undefined };
  const [firstName, ...rest] = normalized.split(' ');
  const lastName = rest.join(' ').trim();
  return { firstName, lastName: lastName || undefined };
};

const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

const formatCurrency = (value) =>
  Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const toEmailSafe = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const CHECKOUT_NEWBR_ACCOUNT_KEY = 'newbr-main';

const buildMetadata = ({ token, payload, summary, externalReference }) => ({
  checkout_token: token,
  token,
  external_reference: externalReference,
  phone: summary.phone,
  whatsapp: summary.phone,
  user: summary.username,
  username: summary.username,
  customer_id: summary.customerId,
  customerId: summary.customerId,
  plan_months: summary.planMonths,
  plan: summary.planMonths,
  plan_label: summary.plan.planLabel,
  package_id: summary.plan.packageId,
  packageId: summary.plan.packageId,
  connections: summary.connections,
  owner_worker_id: payload?.ownerWorkerId || payload?.owner_worker_id || '',
});

const StatusMessage = ({ tone = 'info', children }) => {
  const className =
    tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
      : tone === 'error'
        ? 'border-red-500/40 bg-red-500/10 text-red-100'
        : 'border-white/10 bg-white/5 text-white/70';

  return <div className={`rounded-xl border px-4 py-3 text-sm ${className}`}>{children}</div>;
};

const Checkout = () => {
  const [searchParams] = useSearchParams();
  const token = String(searchParams.get('token') || '').trim();
  const paymentStatus = String(searchParams.get('status') || searchParams.get('collection_status') || '').toLowerCase();

  const [payload, setPayload] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(Boolean(token));
  const [tokenError, setTokenError] = useState('');
  const [configDescription, setConfigDescription] = useState('Plano Completo');
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState('');
  const [newbrPreparing, setNewbrPreparing] = useState(false);
  const [browserRenewing, setBrowserRenewing] = useState(false);
  const [browserRenewalMessage, setBrowserRenewalMessage] = useState('');
  const browserRenewalStartedRef = useRef(false);

  const [pixEmail, setPixEmail] = useState('');
  const [pixName, setPixName] = useState('');
  const [pixDocument, setPixDocument] = useState('');
  const [pixLoading, setPixLoading] = useState(false);
  const [pixError, setPixError] = useState('');
  const [pixResult, setPixResult] = useState(null);
  const [pixCopied, setPixCopied] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenLoading(false);
      setTokenError('Link de checkout invalido: token ausente.');
      return undefined;
    }

    let mounted = true;
    setTokenLoading(true);
    resolveCheckoutToken(token)
      .then((data) => {
        if (!mounted) return;
        setPayload(data);
        setTokenError('');
      })
      .catch((error) => {
        if (!mounted) return;
        setTokenError(error.message || 'Token invalido ou expirado.');
      })
      .finally(() => {
        if (mounted) setTokenLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [token]);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const config = await fetchMercadoPagoConfig();
        if (config?.description) setConfigDescription(config.description);
      } catch {
        // Visual fallback only.
      }
    };

    loadConfig();
  }, []);

  const summary = useMemo(() => {
    if (!payload) return null;

    const planMonths = Number(payload?.plan || payload?.planMonths || payload?.months || 1) || 1;
    const connections = Number(payload?.connections || payload?.conexoes || 1) || 1;
    const plan = resolveCheckoutPlan(planMonths);
    const amount = resolveCheckoutPrice({ connections, planMonths });
    const username = String(payload?.user || payload?.usuario || payload?.username || '').trim() || 'Nao informado';
    const customerId = String(payload?.customer_id || payload?.customerId || payload?.id || '').trim();
    const phone = normalizeDigits(payload?.whatsapp || payload?.phone);

    return {
      amount,
      connections,
      customerId,
      phone,
      plan,
      planMonths,
      username,
      initial: username.charAt(0).toUpperCase() || 'C',
      valid: Boolean(plan && amount && isAllowedCheckoutConnections(connections) && isAllowedCheckoutMonths(planMonths)),
    };
  }, [payload]);

  const approvedReturn = ['approved', 'accredited'].includes(paymentStatus);
  const canPay = Boolean(summary?.valid && !tokenLoading && !tokenError);
  const paymentDescription = summary?.plan ? `${configDescription} - ${summary.plan.planLabel}` : configDescription;
  const externalReference = token ? `checkout:${token}` : '';
  const metadata = summary && payload ? buildMetadata({ token, payload, summary, externalReference }) : null;

  const fallbackEmail = useMemo(() => {
    if (!summary) return 'cliente@example.com';
    if (summary.phone) return `cliente${summary.phone}@example.com`;
    return `${toEmailSafe(summary.username) || 'cliente'}@example.com`;
  }, [summary]);

  const pixData = useMemo(() => {
    const data = pixResult?.point_of_interaction?.transaction_data;
    if (!data) return null;
    return {
      qrCode: data.qr_code || '',
      qrCodeBase64: data.qr_code_base64 || '',
      ticketUrl: data.ticket_url || '',
    };
  }, [pixResult]);

  useEffect(() => {
    setPixResult(null);
    setPixError('');
    setCardError('');
  }, [paymentMethod]);

  useEffect(() => {
    if (paymentMethod !== 'pix' || !summary) return;
    if (!pixEmail) setPixEmail(fallbackEmail);
    if (!pixName && summary.username !== 'Nao informado') setPixName(summary.username);
  }, [paymentMethod, pixEmail, pixName, fallbackEmail, summary]);

  const runNewbrPrepareWorker = async (renewal) => {
    const result = await runNewbrBrowserWorker({ mode: 'PREPARE_ONLY', renewal });
    return result.login;
  };

  const prepareNewbrRenewal = async () => {
    if (!summary || !metadata || !externalReference) {
      throw new Error('Dados insuficientes para preparar a renovacao NewBR.');
    }

    const renewal = {
      account_key: CHECKOUT_NEWBR_ACCOUNT_KEY,
      checkoutToken: token,
      checkout_token: token,
      customer_id: summary.customerId,
      customerId: summary.customerId,
      package_id: summary.plan.packageId,
      packageId: summary.plan.packageId,
      connections: summary.connections,
      external_reference: externalReference,
      phone: summary.phone,
      whatsapp: summary.phone,
      username: summary.username,
      plan_months: summary.planMonths,
      plan_label: summary.plan.planLabel,
      amount: summary.amount,
    };

    setNewbrPreparing(true);
    try {
      await notifyCheckoutNewbrBrowserStart({
        mode: 'checkout_payment_click',
        source: 'checkout-browser-worker',
        account_key: CHECKOUT_NEWBR_ACCOUNT_KEY,
        checkoutToken: token,
        renewal,
      });

      const login = await runNewbrPrepareWorker(renewal);

      await saveCheckoutNewbrBrowserToken({
        account_key: CHECKOUT_NEWBR_ACCOUNT_KEY,
        source: 'checkout-browser-worker',
        checkoutToken: token,
        token,
        username: login.username,
        bearerToken: login.token,
        status: login.status,
      });

      await saveCheckoutRenewalIntent({
        ...renewal,
        metadata,
      });
    } finally {
      setNewbrPreparing(false);
    }
  };

  const runBrowserRenewal = async (statusPayload) => {
    if (!summary || browserRenewalStartedRef.current) return;
    browserRenewalStartedRef.current = true;
    setBrowserRenewing(true);
    setBrowserRenewalMessage('Pagamento aprovado. Renovando acesso...');
    try {
      const workerId = `checkout-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const claim = await claimCheckoutRenewals({
        workerId,
        checkoutToken: token,
        limit: 1,
      });
      const job = Array.isArray(claim?.claimed) ? claim.claimed[0] : null;
      if (!job?.payment?.paymentId) {
        browserRenewalStartedRef.current = false;
        setBrowserRenewalMessage('Pagamento aprovado. Renovacao aguardando Worker do site.');
        return;
      }

      const result = await runNewbrBrowserWorker({
        mode: 'RENEW_NOW_BROWSER',
        renewal: job.renewal,
        bearerToken: '',
      });
      const completePayload = {
        paymentId: job.payment.paymentId,
        workerId,
        source: 'checkout-page-worker',
        success: Boolean(result.renew?.ok),
        result: result.renew,
        error: result.renew?.ok ? '' : result.renew?.data?.message || result.renew?.data?.error || `NewBR HTTP ${result.renew?.status || 'unknown'}`,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await completeCheckoutRenewal(completePayload);
          break;
        } catch (error) {
          if (attempt >= 2 || !completePayload.success) throw error;
          await delay(1000 * (attempt + 1));
        }
      }
      if (result.renew?.ok) {
        setBrowserRenewalMessage('Renovacao concluida com sucesso.');
      } else {
        browserRenewalStartedRef.current = false;
        setBrowserRenewalMessage('Pagamento aprovado, mas a renovacao nao foi confirmada.');
      }
    } catch (error) {
      browserRenewalStartedRef.current = false;
      setBrowserRenewalMessage(error.message || 'Falha ao renovar pelo navegador.');
    } finally {
      setBrowserRenewing(false);
    }
  };

  useEffect(() => {
    if (!token || !summary?.valid) return undefined;

    let cancelled = false;
    const approvedStatuses = new Set([
      'awaiting_browser_renewal',
      'payment_confirmed',
      'renewal_failed',
      'manual_required',
      'browser_renewal_failed',
    ]);

    const poll = async () => {
      try {
        const status = await fetchCheckoutRenewalCheckoutStatus(token);
        if (cancelled) return;
        const paymentStatusValue = String(status?.payment?.status || '');
        if (paymentStatusValue === 'renewed') {
          setBrowserRenewalMessage('Renovacao concluida com sucesso.');
          return;
        }
        if (approvedStatuses.has(paymentStatusValue)) {
          await runBrowserRenewal(status);
        }
      } catch {
        // Polling is best-effort; visible payment errors stay in the payment panels.
      }
    };

    void poll();
    const interval = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [externalReference, summary, token]);

  const handleGeneratePix = async () => {
    if (!summary || !metadata || !canPay) return;
    setPixError('');
    setPixResult(null);
    setPixCopied(false);
    setPixLoading(true);

    try {
      await prepareNewbrRenewal();
      const resolvedName = pixName.trim() || summary.username;
      const { firstName, lastName } = splitName(resolvedName);
      const result = await createPixPayment({
        amount: summary.amount,
        description: paymentDescription,
        payer: {
          email: pixEmail.trim() || fallbackEmail,
          firstName,
          lastName,
          identification: pixDocument
            ? {
                type: 'CPF',
                number: normalizeDigits(pixDocument),
              }
            : undefined,
        },
        metadata,
        externalReference,
      });
      setPixResult(result);
    } catch (error) {
      setPixError(error.message || 'Erro ao gerar Pix.');
    } finally {
      setPixLoading(false);
    }
  };

  const handleCardCheckout = async () => {
    if (!summary || !metadata || !canPay) return;
    setCardError('');
    setCardLoading(true);

    try {
      await prepareNewbrRenewal();
      const preference = await createMercadoPagoPreference({
        amount: summary.amount,
        title: `Renovacao MaisTV - ${summary.plan.planLabel}`,
        description: paymentDescription,
        metadata,
        externalReference,
      });
      const redirectUrl = preference?.init_point || preference?.sandbox_init_point;
      if (!redirectUrl) throw new Error('Mercado Pago nao retornou o link de pagamento.');
      window.location.href = redirectUrl;
    } catch (error) {
      setCardError(error.message || 'Nao foi possivel iniciar o pagamento.');
      setCardLoading(false);
    }
  };

  const handleCopyPix = async () => {
    if (!pixData?.qrCode) return;
    try {
      await navigator.clipboard.writeText(pixData.qrCode);
      setPixCopied(true);
      setTimeout(() => setPixCopied(false), 2000);
    } catch {
      setPixCopied(false);
    }
  };

  return (
    <main
      className="min-h-screen overflow-y-auto text-white"
      style={{
        background:
          'radial-gradient(circle at top, rgba(88, 101, 242, 0.35), transparent 45%), radial-gradient(circle at 20% 65%, rgba(79, 209, 197, 0.25), transparent 50%), #0c1020',
      }}
    >
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-10 lg:px-8">
        <header className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-sm font-semibold shadow-md">
            {summary?.initial || 'M'}
          </div>
          <h1 className="mt-4 text-2xl font-semibold">Finalizar Pagamento</h1>
          <p className="mt-1 text-sm text-white/60">Complete sua assinatura em poucos passos</p>
        </header>

        <div className="mt-4 space-y-3">
          {tokenLoading ? <StatusMessage>Validando link de pagamento...</StatusMessage> : null}
          {tokenError ? <StatusMessage tone="error">{tokenError}</StatusMessage> : null}
          {approvedReturn ? (
            <StatusMessage tone="success">
              Pagamento recebido pelo Mercado Pago. A renovacao sera processada automaticamente.
            </StatusMessage>
          ) : null}
          {browserRenewalMessage ? (
            <StatusMessage tone={browserRenewalMessage.includes('sucesso') ? 'success' : 'info'}>
              {browserRenewing ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : null}
              {browserRenewalMessage}
            </StatusMessage>
          ) : null}
          {summary && !summary.valid ? (
            <StatusMessage tone="error">
              Link de checkout invalido: plano ou conexoes fora da tabela permitida.
            </StatusMessage>
          ) : null}
        </div>

        <div className="mt-8 flex w-full flex-col gap-6 lg:flex-row">
          <div className="flex-1 space-y-5">
            <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-[0_20px_60px_rgba(12,16,32,0.6)]">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase text-white/50">Etapas</p>
                  <h2 className="text-lg font-semibold">Pagamento</h2>
                </div>
                <BadgeCheck className="h-5 w-5 text-[#22C55E]" />
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-white/60">
                {['Dados', 'Pagamento', 'Confirmacao'].map((step, index) => {
                  const isDone = index === 0;
                  const isActive = index === 1;
                  return (
                    <div key={step} className="flex flex-col items-center gap-2">
                      <div
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold',
                          isDone && 'border-[#22C55E] bg-[#22C55E]/20 text-[#22C55E]',
                          isActive && 'border-[#7C3AED] bg-[#7C3AED] text-white shadow-lg',
                          !isActive && !isDone && 'border-white/20 text-white/60',
                        )}
                      >
                        {index + 1}
                      </div>
                      <span className={cn(isActive && 'text-white')}>{step}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#7C3AED]/20">
                  <User className="h-4 w-4 text-[#A78BFA]" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Informacoes do Cliente</p>
                  <p className="text-xs text-white/50">Confira os dados antes de continuar.</p>
                </div>
              </div>

              <div className="mt-4 space-y-3 text-sm text-white/70">
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <User className="h-4 w-4 text-white/60" />
                    Usuario
                  </span>
                  <span className="text-right text-white">{summary?.username || '-'}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <Phone className="h-4 w-4 text-white/60" />
                    WhatsApp
                  </span>
                  <span className="text-right text-white">{summary?.phone || '-'}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-white/60" />
                    Valor
                  </span>
                  <span className="text-right font-semibold text-[#22C55E]">
                    {summary?.amount ? formatCurrency(summary.amount) : '-'}
                  </span>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <p className="text-sm font-semibold">Plano definido</p>
              <div className="mt-3 rounded-lg border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-3 py-2 text-xs font-semibold uppercase text-[#C4B5FD]">
                {summary?.plan?.planLabel || '-'}
              </div>
              <p className="mt-2 text-xs text-white/60">
                O plano deste checkout ja foi definido previamente no painel.
              </p>
            </section>

            <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <p className="text-sm font-semibold">Escolha o metodo de pagamento</p>
              <div className="mt-4 grid gap-3">
                <button
                  type="button"
                  onClick={() => setPaymentMethod('pix')}
                  disabled={!canPay}
                  className={cn(
                    'flex items-center justify-between rounded-xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                    paymentMethod === 'pix'
                      ? 'border-[#22C55E]/60 bg-[#22C55E]/10'
                      : 'border-white/10 bg-white/5 hover:bg-white/10',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#22C55E]/20">
                      <QrCode className="h-5 w-5 text-[#22C55E]" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Pix</p>
                      <p className="text-xs text-white/60">Pagamento instantaneo e aprovacao imediata</p>
                    </div>
                  </div>
                  <div className={cn('h-4 w-4 rounded-full border', paymentMethod === 'pix' ? 'border-[#22C55E] bg-[#22C55E]' : 'border-white/30')} />
                </button>

                <button
                  type="button"
                  onClick={() => setPaymentMethod('card')}
                  disabled={!canPay}
                  className={cn(
                    'flex items-center justify-between rounded-xl border px-4 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                    paymentMethod === 'card'
                      ? 'border-[#7C3AED]/60 bg-[#7C3AED]/10'
                      : 'border-white/10 bg-white/5 hover:bg-white/10',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#7C3AED]/20">
                      <CreditCard className="h-5 w-5 text-[#A78BFA]" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Cartao de credito</p>
                      <p className="text-xs text-white/60">Pagamento seguro</p>
                    </div>
                  </div>
                  <div className={cn('h-4 w-4 rounded-full border', paymentMethod === 'card' ? 'border-[#7C3AED] bg-[#7C3AED]' : 'border-white/30')} />
                </button>
              </div>

              {!paymentMethod ? (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-xs text-white/60">
                  Selecione um metodo de pagamento.
                </div>
              ) : null}
            </section>

            {paymentMethod === 'pix' ? (
              <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <div className="flex items-center gap-3">
                  <QrCode className="h-5 w-5 text-[#22C55E]" />
                  <div>
                    <p className="text-sm font-semibold">Pix imediato</p>
                    <p className="text-xs text-white/60">Gere o QR Code e finalize pelo banco.</p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pix-name" className="text-white/70">Nome</Label>
                    <Input id="pix-name" value={pixName} onChange={(event) => setPixName(event.target.value)} className="border-white/10 bg-white/5 text-white placeholder:text-white/40" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pix-email" className="text-white/70">E-mail</Label>
                    <Input id="pix-email" type="email" value={pixEmail} onChange={(event) => setPixEmail(event.target.value)} className="border-white/10 bg-white/5 text-white placeholder:text-white/40" />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="pix-document" className="text-white/70">CPF opcional</Label>
                    <Input id="pix-document" value={pixDocument} onChange={(event) => setPixDocument(event.target.value)} placeholder="000.000.000-00" className="border-white/10 bg-white/5 text-white placeholder:text-white/40" />
                  </div>
                </div>

                {pixError ? <div className="mt-4"><StatusMessage tone="error">{pixError}</StatusMessage></div> : null}

                <Button className="mt-4 w-full bg-[#22C55E] text-white hover:bg-[#16A34A]" onClick={handleGeneratePix} disabled={pixLoading || newbrPreparing || !canPay}>
                  {pixLoading || newbrPreparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {newbrPreparing ? 'Preparando renovacao...' : pixLoading ? 'Gerando Pix...' : 'Gerar Pix'}
                </Button>

                {pixData ? (
                  <div className="mt-5 space-y-3">
                    {pixData.qrCodeBase64 ? (
                      <div className="mx-auto max-w-xs rounded-xl border border-white/10 bg-white p-3">
                        <img src={`data:image/png;base64,${pixData.qrCodeBase64}`} alt="QR Code Pix" className="w-full" />
                      </div>
                    ) : null}
                    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                      <p className="text-xs text-white/60">Codigo copia e cola</p>
                      <p className="mt-2 break-all text-xs text-white">{pixData.qrCode}</p>
                      <Button variant="outline" size="sm" className="mt-3 w-full gap-2 border-white/10 bg-white/5 text-white hover:bg-white/10 hover:text-white" onClick={handleCopyPix} disabled={!pixData.qrCode}>
                        <Copy className="h-3 w-3" />
                        {pixCopied ? 'Copiado' : 'Copiar codigo'}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {paymentMethod === 'card' ? (
              <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-[#A78BFA]" />
                  <div>
                    <p className="text-sm font-semibold">Cartao de credito</p>
                    <p className="text-xs text-white/60">Voce sera redirecionado ao Mercado Pago.</p>
                  </div>
                </div>
                {cardError ? <div className="mt-4"><StatusMessage tone="error">{cardError}</StatusMessage></div> : null}
                <Button className="mt-4 w-full bg-[#7C3AED] text-white hover:bg-[#6D28D9]" onClick={handleCardCheckout} disabled={cardLoading || newbrPreparing || !canPay}>
                  {cardLoading || newbrPreparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {newbrPreparing ? 'Preparando renovacao...' : cardLoading ? 'Abrindo Mercado Pago...' : 'Pagar com cartao'}
                </Button>
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 text-xs text-white/60">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Pagamento Seguro</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">SSL Criptografado</span>
            </div>
          </div>

          <aside className="w-full lg:w-[320px]">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-[0_20px_60px_rgba(12,16,32,0.6)]">
              <div className="flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 text-[#A78BFA]" />
                <h3 className="text-sm font-semibold">Resumo do Pedido</h3>
              </div>

              <div className="mt-5 space-y-3 text-sm text-white/70">
                <div className="flex items-center justify-between gap-4">
                  <span>Plano</span>
                  <span className="text-right text-white">{summary?.plan?.planLabel || '-'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Conexoes</span>
                  <span className="text-white">{summary?.connections || '-'}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Assinatura</span>
                  <span className="text-white">{summary?.amount ? formatCurrency(summary.amount) : '-'}</span>
                </div>
              </div>

              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-semibold">Total</span>
                  <span className="text-lg font-semibold text-[#A78BFA]">
                    {summary?.amount ? formatCurrency(summary.amount) : '-'}
                  </span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
};

export default Checkout;
