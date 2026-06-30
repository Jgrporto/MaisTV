import { useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';

import TemplatePreview from './TemplatePreview';
import { buildPreviewFromTemplate, getCustomerLabel, getCustomerPhone, getTemplateName, normalizeText } from './utils';

export default function ManualRunDialog({
  open,
  routine,
  template,
  customers = [],
  sampleCustomer = {},
  isRunning,
  onClose,
  onConfirm,
}) {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);

  const filteredCustomers = useMemo(() => {
    const normalizedSearch = normalizeText(search);
    return customers
      .filter((customer) => {
        if (!normalizedSearch) return true;
        const raw = customer.raw && typeof customer.raw === 'object' ? customer.raw : {};
        return normalizeText([getCustomerLabel(customer), getCustomerPhone(customer), raw.documento, raw.cpf, raw.cnpj].join(' ')).includes(
          normalizedSearch,
        );
      })
      .slice(0, 120);
  }, [customers, search]);

  const preview = template ? buildPreviewFromTemplate(template, routine, sampleCustomer) : null;
  const selectedCount = selectedIds.length;

  if (!open) return null;

  const toggleCustomer = (customerId) => {
    setSelectedIds((current) => (current.includes(customerId) ? current.filter((id) => id !== customerId) : [...current, customerId]));
  };

  const handleConfirm = () => {
    if (!selectedIds.length) return;
    onConfirm(selectedIds);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <header className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Envio manual</h2>
            <p className="mt-1 text-sm text-muted-foreground">Selecione clientes da base do SaaSTV antes de executar a rotina.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-h-0 rounded-lg border border-border p-4">
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nome, telefone ou documento"
                className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
              />
            </div>
            <div className="mb-3 text-sm text-muted-foreground">{selectedCount} cliente(s) selecionado(s)</div>
            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {filteredCustomers.map((customer) => {
                const phone = getCustomerPhone(customer);
                return (
                  <button
                    key={customer.id}
                    type="button"
                    onClick={() => toggleCustomer(customer.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left transition ${
                      selectedIds.includes(customer.id) ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted/40'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{getCustomerLabel(customer)}</span>
                      <span className="text-xs text-muted-foreground">{phone || 'Sem telefone válido'}</span>
                    </span>
                    <span className="h-4 w-4 rounded-full border border-primary" />
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-lg border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">Resumo do envio</h3>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Rotina: </span>
                  <span className="font-medium text-foreground">{routine?.name || 'Sem nome'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">HSM: </span>
                  <span className="font-medium text-foreground">{template ? getTemplateName(template) : routine?.hsm?.templateName || '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Clientes: </span>
                  <span className="font-medium text-foreground">{selectedCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Intervalo: </span>
                  <span className="font-medium text-foreground">{routine?.sendIntervalSeconds || 0}s</span>
                </div>
              </div>
            </section>
            <section className="rounded-lg border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">Prévia</h3>
              <TemplatePreview preview={preview} />
            </section>
          </aside>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <span className="text-sm text-muted-foreground">Duplicados e telefones inválidos são tratados no backend.</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selectedCount || isRunning}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirmar envio
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
