import React, { useState } from 'react';
import {
  X,
  Phone,
  Calendar,
  Tag,
  Ticket,
  ChevronDown,
  ChevronUp,
  MapPin,
  BadgeInfo,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import LabelBadge from '@/components/labels/LabelBadge';
import LabelFormDialog from '@/components/labels/LabelFormDialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';
import { saveCustomLabel, toggleConversationCustomLabel, useLabelCatalog } from '@/lib/labels';
import { cn } from '@/lib/utils';
import ContactAvatar from './ContactAvatar';

const priorityConfig = {
  low: { label: 'Baixa', color: 'bg-slate-400' },
  medium: { label: 'Média', color: 'bg-blue-500' },
  high: { label: 'Alta', color: 'bg-amber-500' },
  urgent: { label: 'Urgente', color: 'bg-red-500' },
};

const departmentLabels = {
  general: 'Geral',
  sales: 'Vendas',
  support: 'Suporte',
  billing: 'Financeiro',
};

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border/50">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</span>
        {open ? (
          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

export default function ContactInfoPanel({ conversation, onClose }) {
  const { customLabels } = useLabelCatalog();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  if (!conversation) return null;

  const prio = priorityConfig[conversation.priority] || priorityConfig.medium;
  const customer = conversation.customer || {};
  const labels = Array.isArray(conversation.visible_labels) ? conversation.visible_labels : [];
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  const assignedCustomLabelIds = new Set(
    Array.isArray(conversation.custom_labels) ? conversation.custom_labels.map((label) => label.id) : []
  );

  const handleCreateLabel = async (payload) => {
    try {
      const nextLabel = await saveCustomLabel(payload);
      await toggleConversationCustomLabel(conversation.id, nextLabel.id, true);
      toast.success('Etiqueta criada e vinculada à conversa.');
    } catch (error) {
      toast.error(error?.message || 'Não foi possível criar a etiqueta personalizada.');
      throw error;
    }
  };

  return (
    <>
      <div className="chat-panel w-[300px] flex-shrink-0 border-l border-border flex flex-col h-full">
        <div className="chat-header h-14 px-4 flex items-center justify-between border-b border-border flex-shrink-0">
          <h3 className="font-semibold text-sm text-foreground">Informações</h3>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="attendance-scrollbar flex-1 overflow-y-auto">
          <div className="px-4 py-5 text-center border-b border-border/50">
            <ContactAvatar
              src={conversation.avatar_url}
              name={conversation.contact_name}
              className="w-16 h-16 mx-auto mb-3 shadow-md"
              textClassName="text-2xl"
            />
            <h4 className="font-bold text-base text-foreground">{conversation.contact_name}</h4>
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
              <Phone className="w-3 h-3" />
              {conversation.contact_phone || '-'}
            </p>
            <div className="flex items-center justify-center gap-2 mt-3">
              <div className={cn('w-2 h-2 rounded-full', prio.color)} />
              <span className="text-xs text-muted-foreground">{prio.label} prioridade</span>
            </div>
          </div>

          <Section title="Detalhes">
            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Departamento</label>
                <p className="text-foreground">{departmentLabels[conversation.department] || 'Geral'}</p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                  <Calendar className="w-3 h-3" /> Iniciado em
                </label>
                <p className="text-foreground">
                  {conversation.created_date ? format(new Date(conversation.created_date), 'dd/MM/yyyy HH:mm') : '-'}
                </p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Última atividade</label>
                <p className="text-foreground">
                  {conversation.updated_date ? format(new Date(conversation.updated_date), 'dd/MM/yyyy HH:mm') : '-'}
                </p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Status atual</label>
                <p className="text-foreground">{conversation.status || '-'}</p>
              </div>
              {customer.username && (
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Usuário</label>
                  <p className="text-foreground">{customer.username}</p>
                </div>
              )}
              {customer.plan && (
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Plano</label>
                  <p className="text-foreground">{customer.plan}</p>
                </div>
              )}
              {customer.city && (
                <div>
                  <label className="text-[11px] font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> Cidade
                  </label>
                  <p className="text-foreground">{customer.city}</p>
                </div>
              )}
            </div>
          </Section>

          <Section title="Etiquetas">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 text-[11px]">
                      Gerenciar etiquetas
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>Etiquetas personalizadas</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {customLabels.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        Nenhuma etiqueta personalizada criada ainda.
                      </div>
                    ) : (
                      customLabels.map((label) => (
                        <DropdownMenuCheckboxItem
                          key={label.id}
                          checked={assignedCustomLabelIds.has(label.id)}
                          onCheckedChange={(checked) =>
                            void toggleConversationCustomLabel(conversation.id, label.id, Boolean(checked)).catch((error) => {
                              toast.error(error?.message || 'Não foi possível atualizar a etiqueta da conversa.');
                            })
                          }
                        >
                          <span className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: label.color }}
                            />
                            {label.name}
                          </span>
                        </DropdownMenuCheckboxItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button variant="ghost" size="sm" className="h-8 text-[11px]" onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="w-3.5 h-3.5" />
                  Nova etiqueta
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5 min-h-[24px]">
                {labels.length === 0 && tags.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nenhuma etiqueta encontrada</p>
                ) : null}
                {labels.map((label) => (
                  <LabelBadge key={label.id} label={label} className="h-6 px-2.5 text-[11px]" />
                ))}
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[11px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </Section>

          <Section title="Base e leitura">
            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Existe na base</label>
                <p className="text-foreground">{customer.existsInBase ? 'Sim' : 'Não'}</p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Cliente teste</label>
                <p className="text-foreground">{customer.isTeste ? 'Sim' : 'Não'}</p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Mensagens não lidas</label>
                <p className="text-foreground">{conversation.unread_count || 0}</p>
              </div>
            </div>
          </Section>

          <Section title="Observação">
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <BadgeInfo className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <p>
                  Este painel continua sem edição de notas, prioridade ou departamento pela API atual. As etiquetas
                  personalizadas ficam locais no frontend para organização operacional.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Relacionamento" defaultOpen={false}>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Ticket className="w-3.5 h-3.5" />
                <span>Plan status: {customer.planStatus || '-'}</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Tag className="w-3.5 h-3.5" />
                <span>Payment status: {customer.paymentStatus || '-'}</span>
              </div>
            </div>
          </Section>
        </div>
      </div>

      <LabelFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreateLabel}
        title="Criar etiqueta personalizada"
        description="A etiqueta será criada e vinculada imediatamente a esta conversa."
        submitLabel="Criar e vincular"
      />
    </>
  );
}
