import React from 'react';
import { format } from 'date-fns';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const statusConfig = {
  waiting: { label: 'Aguardando', class: 'bg-[#FFF8E1] text-[#FFC107] border-[#FFF8E1]' },
  in_progress: { label: 'Em atendimento', class: 'bg-[#E6F7ED] text-primary border-[#E6F7ED]' },
  resolved: { label: 'Resolvida', class: 'bg-[#E6F7ED] text-primary border-[#E6F7ED]' },
  closed: { label: 'Fechada', class: 'bg-secondary text-muted-foreground border-secondary' },
};

const deptLabels = {
  general: 'Geral',
  sales: 'Vendas',
  support: 'Suporte',
  billing: 'Financeiro',
};

export default function ConversationsTable({ conversations }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
      <div className="border-b border-border px-5 py-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-foreground">Conversas recentes</h3>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary/60">
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Contato</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Telefone</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Status</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Departamento</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Agente</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Data</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conversations.slice(0, 10).map((conversation) => (
            <TableRow key={conversation.id} className="hover:bg-secondary/30">
              <TableCell className="text-sm font-medium text-foreground">{conversation.contact_name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{conversation.contact_phone}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn('rounded-full text-[10px] font-medium', statusConfig[conversation.status]?.class)}
                >
                  {statusConfig[conversation.status]?.label}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{deptLabels[conversation.department] || 'Geral'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{conversation.assigned_agent_name || '—'}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {conversation.created_date ? format(new Date(conversation.created_date), 'dd/MM HH:mm') : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
