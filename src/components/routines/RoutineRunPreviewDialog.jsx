import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import TemplatePreview from './TemplatePreview';
import { getTemplateName } from './utils';

const formatDate = (value) => {
  if (!value) return '-';
  const [year, month, day] = String(value).split('-');
  return year && month && day ? `${day}/${month}/${year}` : String(value);
};

const getItemId = (item = {}) =>
  String(item.customerId || item.customerKey || item.conversationId || item.phone || '').trim();

export default function RoutineRunPreviewDialog({
  open,
  routine,
  template,
  previewData,
  isLoading,
  isRunning,
  onClose,
  onConfirm,
}) {
  const forecast = previewData?.forecast || null;
  const isFollowUp = routine?.type === 'follow_up';
  const isAdvanceWindow = Boolean(forecast?.isAdvanceWindow);
  const items = useMemo(() => (Array.isArray(forecast?.items) ? forecast.items : []), [forecast?.items]);
  const [selectedIds, setSelectedIds] = useState([]);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(items.map(getItemId).filter(Boolean));
  }, [items, open]);

  if (!open) return null;

  const selectedCount = selectedIds.length;
  const toggleItem = (itemId) => {
    setSelectedIds((current) => (current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]));
  };

  const ignoredText = isFollowUp
    ? `Ignorados: ${forecast?.ignored?.noLead || 0} sem LEAD | ${forecast?.ignored?.belowMinimumTime || 0} abaixo do tempo minimo | ${forecast?.ignored?.aboveMaximumTime || 0} acima de 24h | ${forecast?.ignored?.maxSendsReached || 0} limite atingido | ${forecast?.ignored?.respondedAfterFollowUp || 0} responderam`
    : `Ignorados: ${forecast?.ignored?.invalidPhone || 0} telefone invalido | ${forecast?.ignored?.duplicates || 0} duplicado(s) | ${forecast?.ignored?.missingDate || 0} sem data | ${forecast?.ignored?.outsideDate || 0} fora da regra`;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Executar rotina agora</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isFollowUp && isAdvanceWindow
                ? 'Confira os clientes previstos para a proxima janela e selecione quem deve receber o disparo adiantado.'
                : 'Confira os clientes afetados pela regra e selecione quem deve receber o disparo.'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={isRunning} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-h-0 rounded-lg border border-border p-4">
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-xs uppercase text-muted-foreground">Afetados</div>
                <div className="text-2xl font-semibold text-foreground">{forecast?.affectedCount || 0}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-xs uppercase text-muted-foreground">Selecionados</div>
                <div className="text-2xl font-semibold text-foreground">{selectedCount}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-xs uppercase text-muted-foreground">{isFollowUp ? 'Hora' : 'Data'}</div>
                <div className="text-sm font-semibold text-foreground">{isFollowUp ? forecast?.referenceTime || '-' : formatDate(forecast?.referenceDate)}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-xs uppercase text-muted-foreground">{isFollowUp ? (isAdvanceWindow ? 'Proxima janela' : 'Periodo') : 'Alvo'}</div>
                <div className="text-sm font-semibold text-foreground">{isFollowUp ? forecast?.period?.label || 'Fora da janela' : formatDate(forecast?.targetDate)}</div>
              </div>
            </div>

            {isFollowUp && isAdvanceWindow ? (
              <div className="mb-4 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm text-foreground">
                Fora da janela atual. A lista abaixo usa a proxima janela configurada como referencia e pode ser adiantada manualmente.
              </div>
            ) : null}

            {isLoading ? (
              <div className="flex min-h-60 items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Calculando clientes afetados...
              </div>
            ) : items.length ? (
              <div className="max-h-[460px] space-y-2 overflow-y-auto pr-1">
                {items.map((item) => {
                  const id = getItemId(item);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => id && toggleItem(id)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition ${
                        selectedIds.includes(id) ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted/40'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{item.name || 'Cliente sem nome'}</span>
                        <span className="text-xs text-muted-foreground">
                          {isFollowUp
                            ? `${item.phone || '-'} | ${item.modelLabel || '-'} | ${item.periodLabel || '-'} | ${item.routeKey === 'vendas' ? 'Vendas' : 'Default'} | ${item.idleHours || 0}h sem interacao`
                            : `${item.phone || '-'} | Base: ${formatDate(item.baseDate)} | Execucao: ${formatDate(item.executionDate)}`}
                        </span>
                      </span>
                      <span className="h-4 w-4 rounded-full border border-primary" />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                {isFollowUp ? 'Nenhum lead entra na regra de follow up nesta janela.' : 'Nenhum cliente entra na regra desta rotina para hoje.'}
              </div>
            )}

            {forecast?.ignored ? (
              <div className="mt-4 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">{ignoredText}</div>
            ) : null}
          </section>

          <aside className="space-y-4">
            <section className="rounded-lg border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">Resumo</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Rotina: </span>
                  <span className="font-medium text-foreground">{routine?.name || '-'}</span>
                </div>
                {isFollowUp ? (
                  <>
                    <div>
                      <span className="text-muted-foreground">Etiqueta: </span>
                      <span className="font-medium text-foreground">LEAD</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Regra: </span>
                      <span className="font-medium text-foreground">
                        {routine?.followUp?.minHoursWithoutInteraction || 10}h a {routine?.followUp?.maxHoursWithoutInteraction || 24}h sem interacao
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <span className="text-muted-foreground">HSM: </span>
                      <span className="font-medium text-foreground">{template ? getTemplateName(template) : routine?.hsm?.templateName || '-'}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Intervalo: </span>
                      <span className="font-medium text-foreground">{routine?.sendIntervalSeconds || 0}s</span>
                    </div>
                  </>
                )}
              </div>
            </section>
            {!isFollowUp ? (
              <section className="rounded-lg border border-border p-4">
                <h3 className="mb-3 text-sm font-semibold text-foreground">Previa</h3>
                <TemplatePreview preview={previewData?.preview || null} />
              </section>
            ) : null}
          </aside>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <span className="text-sm text-muted-foreground">A execucao forcada usa apenas os selecionados acima.</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={isRunning} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60">
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => onConfirm(selectedIds)}
              disabled={!selectedCount || isRunning || isLoading}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isFollowUp && isAdvanceWindow ? 'Adiantar follow up' : isFollowUp ? 'Executar follow up' : 'Disparar selecionados'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
