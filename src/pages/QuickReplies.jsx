import React from 'react';
import { toast } from 'sonner';

import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import QuickReplySidePanel from '@/components/chat/QuickReplySidePanel';

export default function QuickReplies() {
  return (
    <PageShell>
      <PageHeader
        title="Respostas Rápidas"
        description="Gerencie as mesmas respostas, categorias e ações usadas no atalho do Zap no atendimento."
      />

      <PageSectionCard className="h-[calc(100vh-180px)] min-h-[620px] overflow-hidden p-0">
        <QuickReplySidePanel
          open
          onClose={() => {}}
          onExecute={() => toast.message('Abra uma conversa para enviar uma resposta rápida.')}
          conversation={null}
          currentUser={null}
          templates={[]}
          isWithin24hWindow={false}
        />
      </PageSectionCard>
    </PageShell>
  );
}
