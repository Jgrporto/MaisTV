import React, { useMemo, useState } from 'react';
import { Bell, History, Megaphone } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { currentBuildLabel, updateHistory } from '@/lib/update-history';

const routeMeta = {
  '/': {
    title: 'Atendimento',
    subtitle: 'Fila ativa, conversas em andamento e histórico recente do produto.',
  },
  '/customers': {
    title: 'Base de Clientes',
    subtitle: 'Gestão operacional da carteira e consultas de clientes.',
  },
  '/dashboard': {
    title: 'Dashboard',
    subtitle: 'Indicadores operacionais e acompanhamento de performance.',
  },
  '/envio': {
    title: 'Envio em Massa',
    subtitle: 'Seleção de clientes, filtros e preparação de disparos em massa.',
  },
  '/labels': {
    title: 'Etiquetas',
    subtitle: 'Etiquetas automáticas e personalizadas para organizar as conversas.',
  },
  '/quick-replies': {
    title: 'Respostas Rápidas',
    subtitle: 'Atalhos de atendimento e textos padronizados.',
  },
  '/hsms': {
    title: 'HSMs',
    subtitle: 'Templates oficiais e configurações de disparo.',
  },
  '/settings': {
    title: 'Configurações',
    subtitle: 'Preferências da equipe e parâmetros da aplicação.',
  },
};

export default function AppTopbar() {
  const location = useLocation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const routeInfo = routeMeta[location.pathname] || routeMeta['/'];
  const notificationCount = updateHistory.length;
  const latestUpdate = updateHistory[0];

  const formattedUpdates = useMemo(() => updateHistory, []);

  return (
    <>
      <div className="sticky top-0 z-40 border-b border-border/80 bg-background/92 backdrop-blur supports-[backdrop-filter]:bg-background/88">
        <div className="flex h-16 items-center justify-between gap-4 px-5 lg:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground sm:text-base">{routeInfo.title}</h2>
              <span className="hidden rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground md:inline-flex">
                {currentBuildLabel}
              </span>
            </div>
            <p className="hidden truncate text-xs text-muted-foreground md:block">{routeInfo.subtitle}</p>
          </div>

          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className={cn(
              'relative inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border bg-card px-3 text-sm text-foreground shadow-sm transition-colors',
              'hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
            )}
            title="Histórico de atualizações"
          >
            <Bell className="h-4 w-4" />
            <span className="hidden font-medium md:inline">Atualizações</span>
            <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {notificationCount}
            </span>
          </button>
        </div>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-3xl p-0 overflow-hidden">
          <DialogHeader className="border-b border-border px-6 py-5">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-primary/10 p-2 text-primary">
                <History className="h-5 w-5" />
              </div>
              <div>
                <DialogTitle>Histórico de atualizações</DialogTitle>
                <DialogDescription className="mt-1">
                  Build atual: <span className="font-medium text-foreground">{currentBuildLabel}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
            {latestUpdate ? (
              <div className="mb-5 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Megaphone className="h-4 w-4 text-primary" />
                  Última publicação registrada
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {latestUpdate.title} em {latestUpdate.date}
                </p>
              </div>
            ) : null}

            <div className="space-y-4">
              {formattedUpdates.map((entry) => (
                <section key={entry.id} className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      {entry.date}
                    </span>
                    <h3 className="text-sm font-semibold text-foreground">{entry.title}</h3>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{entry.summary}</p>
                  <ul className="mt-3 space-y-1 text-sm text-foreground">
                    {entry.items.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-[7px] h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
