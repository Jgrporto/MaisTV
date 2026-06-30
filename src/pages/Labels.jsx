import React, { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  BadgePlus,
  Columns3,
  Eye,
  LayoutGrid,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import ContactAvatar from '@/components/chat/ContactAvatar';
import KanbanBoard from '@/components/kanban/KanbanBoard';
import KanbanLeadCard from '@/components/kanban/KanbanLeadCard';
import LabelBadge from '@/components/labels/LabelBadge';
import LabelFormDialog from '@/components/labels/LabelFormDialog';
import PageHeader from '@/components/layout/PageHeader';
import PageSectionCard from '@/components/layout/PageSectionCard';
import PageShell from '@/components/layout/PageShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/AuthContext';
import { fetchPersistedCustomers } from '@/lib/customer-sync-api';
import { buildCustomerRows } from '@/lib/customer-base';
import {
  buildLabelSummary,
  conversationHasLabel,
  deleteCustomLabel,
  enrichConversationsWithLabels,
  saveConversationStageLabel,
  saveCustomLabel,
  useLabelCatalog,
} from '@/lib/labels';
import {
  CONVERSATION_REFRESH_INTERVAL_MS,
  CONVERSATION_BACKGROUND_SUMMARY_LIMIT,
  CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
  SERVICES_REFRESH_INTERVAL_MS,
} from '@/lib/performance-config';
import { decorateConversationsWithServices, filterConversationsBySelectedService } from '@/lib/services';
import { fetchServices } from '@/lib/services-api';
import { fetchWhatsappConversations } from '@/lib/whatsapp-api';

const VIEW_MODES = [
  { id: 'cards', label: 'Cards', icon: LayoutGrid },
  { id: 'kanban', label: 'Kanban', icon: Columns3 },
];
function getSampleContacts(conversations, labelId) {
  return conversations
    .filter((conversation) => conversationHasLabel(conversation, labelId))
    .slice(0, 4);
}

export default function Labels() {
  const { effectiveUser } = useAuth();
  const [viewMode, setViewMode] = useState('cards');
  const [selectedLabelId, setSelectedLabelId] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const { customLabels, assignments, stageAssignments } = useLabelCatalog();

  const { data: conversationsResponse = [], isLoading: isLoadingConversations } = useQuery({
    queryKey: ['conversations', 'labels', 'summary', CONVERSATION_BACKGROUND_SUMMARY_LIMIT],
    queryFn: () => fetchWhatsappConversations({ summary: true, limit: CONVERSATION_BACKGROUND_SUMMARY_LIMIT }),
    refetchInterval: CONVERSATION_REFRESH_INTERVAL_MS,
    staleTime: 10000,
  });

  const { data: customersResponse } = useQuery({
    queryKey: ['persisted-customers'],
    queryFn: fetchPersistedCustomers,
    staleTime: CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
    refetchInterval: CUSTOMER_CACHE_REFRESH_INTERVAL_MS,
    refetchOnMount: 'always',
  });

  const { data: services = [] } = useQuery({
    queryKey: ['services', 'labels'],
    queryFn: fetchServices,
    staleTime: 10000,
    refetchInterval: SERVICES_REFRESH_INTERVAL_MS,
  });

  const persistedCustomers = Array.isArray(customersResponse?.rows) ? customersResponse.rows : [];
  const customerRows = useMemo(
    () => buildCustomerRows(persistedCustomers, conversationsResponse),
    [persistedCustomers, conversationsResponse]
  );
  const conversations = useMemo(
    () =>
      filterConversationsBySelectedService(
        decorateConversationsWithServices(
          enrichConversationsWithLabels(conversationsResponse, customerRows, {
            customLabels,
            assignments,
            stageAssignments,
          }),
          services,
          effectiveUser,
        ),
        'all',
      ),
    [assignments, conversationsResponse, customLabels, customerRows, effectiveUser, services, stageAssignments]
  );
  const labelSummary = useMemo(
    () => buildLabelSummary(conversations, customLabels),
    [conversations, customLabels]
  );

  const selectedLabel = labelSummary.find((label) => label.id === selectedLabelId) || null;
  const selectedConversations = useMemo(
    () =>
      selectedLabelId
        ? conversations.filter((conversation) => conversationHasLabel(conversation, selectedLabelId))
        : [],
    [conversations, selectedLabelId]
  );

  const handleCreateLabel = useCallback(async (payload) => {
    try {
      await saveCustomLabel(payload);
      toast.success('Etiqueta criada com sucesso.');
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel criar a etiqueta.');
      throw error;
    }
  }, []);

  const handleStageChange = useCallback(async (conversationId, labelId) => {
    try {
      await saveConversationStageLabel(conversationId, labelId, customLabels);
    } catch (error) {
      toast.error(error?.message || 'Nao foi possivel mover a conversa entre etiquetas.');
    }
  }, [customLabels]);

  const openLabelDetails = useCallback((labelId) => {
    setSelectedLabelId(labelId);
    setViewMode('cards');
  }, []);

  const showFutureAction = useCallback((message) => {
    toast.message(message);
  }, []);

  return (
    <PageShell>
      <PageHeader
        title="Etiquetas"
        description="Gerencie as etiquetas automaticas do sistema, acompanhe os contatos por estagio e organize a operacao em cards ou em quadro Kanban."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
              {VIEW_MODES.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  variant={viewMode === id ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    setViewMode(id);
                    setSelectedLabelId('');
                  }}
                  className="h-8"
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Button>
              ))}
            </div>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              Nova etiqueta
            </Button>
          </div>
        }
      />

      {viewMode === 'cards' ? (
        selectedLabel ? (
          <PageSectionCard className="overflow-hidden border-border/80 bg-card p-0 shadow-[0_24px_80px_rgba(15,23,42,0.05)]">
            <div className="border-b border-border/80 bg-gradient-to-r from-primary/[0.06] via-transparent to-transparent px-5 py-5 lg:px-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="space-y-3">
                  <Button variant="ghost" size="sm" className="h-8 w-fit px-2" onClick={() => setSelectedLabelId('')}>
                    <ArrowLeft className="h-4 w-4" />
                    Voltar
                  </Button>

                  <div className="flex flex-wrap items-center gap-2">
                    <LabelBadge label={selectedLabel} className="h-7 px-3 text-[11px]" />
                    <Badge variant="outline" className="rounded-full bg-background/80 px-2.5 py-1 text-[11px]">
                      {selectedConversations.length} conversa{selectedConversations.length !== 1 ? 's' : ''}
                    </Badge>
                  </div>

                  <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                    {selectedLabel.description || 'Sem descricao cadastrada para esta etiqueta.'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => showFutureAction('Cadastro direto de lead por etiqueta sera conectado em uma proxima etapa.')}
                  >
                    <BadgePlus className="h-4 w-4" />
                    Novo lead
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => {
                      setViewMode('kanban');
                    }}
                  >
                    <Columns3 className="h-4 w-4" />
                    Ver no Kanban
                  </Button>
                </div>
              </div>
            </div>

            <div className="p-5 lg:p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Contatos vinculados
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Cards compactos com status, ultima interacao e acoes rapidas.
                  </div>
                </div>

                <Button variant="ghost" size="sm" className="rounded-full text-primary" onClick={() => setSelectedLabelId('')}>
                  <ArrowLeft className="h-4 w-4" />
                  Voltar para etiquetas
                </Button>
              </div>

              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {selectedConversations.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-border bg-muted/10 p-6 text-sm text-muted-foreground">
                    Nenhuma conversa encontrada para esta etiqueta.
                  </div>
                ) : (
                  selectedConversations.map((conversation) => (
                    <KanbanLeadCard
                      key={conversation.id}
                      conversation={conversation}
                      showStageBadge={conversation.stage_label_id !== selectedLabelId}
                    />
                  ))
                )}
              </div>
            </div>
          </PageSectionCard>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
            {labelSummary.map((label) => {
              const sampleContacts = getSampleContacts(conversations, label.id);

              return (
                <PageSectionCard
                  key={label.id}
                  className="group relative overflow-hidden rounded-[28px] border-border/80 bg-gradient-to-br from-card via-card to-primary/[0.03] p-5 shadow-[0_14px_40px_rgba(15,23,42,0.05)] transition-all duration-200 hover:-translate-y-1 hover:border-primary/25 hover:shadow-[0_24px_60px_rgba(15,23,42,0.08)]"
                >
                  <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/[0.08] via-primary/[0.02] to-transparent opacity-80" />

                  <div className="relative flex h-full flex-col justify-between">
                    <div className="space-y-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-3">
                          <LabelBadge label={label} className="h-7 px-3 text-[11px]" />
                          <div>
                            <h3 className="text-xl font-bold tracking-[-0.02em] text-foreground">{label.name}</h3>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                              {label.description || 'Sem descricao cadastrada para esta etiqueta.'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 rounded-full border border-border/70 bg-background/80 p-1 shadow-sm">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              showFutureAction('Cadastro direto de lead por etiqueta sera conectado em uma proxima etapa.')
                            }
                            title="Criar lead nesta etiqueta"
                          >
                            <BadgePlus className="h-4 w-4" />
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              label.kind === 'custom'
                                ? showFutureAction('Edicao detalhada da etiqueta personalizada sera ligada na proxima etapa.')
                                : showFutureAction('As etiquetas de sistema continuam controladas pela regra automatica.')
                            }
                            title="Configurar etiqueta"
                          >
                            <Settings2 className="h-4 w-4" />
                          </Button>

                          {label.kind === 'custom' ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                void deleteCustomLabel(label.id)
                                  .then(() => {
                                    if (selectedLabelId === label.id) {
                                      setSelectedLabelId('');
                                    }
                                    toast.success('Etiqueta removida com sucesso.');
                                  })
                                  .catch((error) => {
                                    toast.error(error?.message || 'Nao foi possivel excluir a etiqueta.');
                                  });
                              }}
                              title="Excluir etiqueta personalizada"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-border/70 bg-background/85 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.04)]">
                        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                          Conversas relacionadas
                        </div>
                        <div className="mt-2 flex items-end justify-between gap-3">
                          <div className="text-4xl font-bold tracking-[-0.03em] text-foreground">{label.count}</div>
                          <div className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                            Etapa ativa
                          </div>
                        </div>
                      </div>

                      <div className="rounded-[24px] border border-border/70 bg-background/85 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.04)]">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Contatos em destaque
                          </div>
                          {sampleContacts.length > 0 ? (
                            <div className="flex -space-x-2">
                              {sampleContacts.map((conversation) => (
                                <div key={`${label.id}-${conversation.id}`} title={`${conversation.contact_name}: ${conversation.last_message || 'Sem mensagens registradas.'}`}>
                                  <ContactAvatar
                                    src={conversation.avatar_url}
                                    name={conversation.contact_name}
                                    className="h-9 w-9 border-2 border-background shadow-sm"
                                    textClassName="text-xs"
                                  />
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-3 space-y-2">
                          {sampleContacts.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                              Nenhuma conversa vinculada no momento.
                            </div>
                          ) : (
                            sampleContacts.map((conversation) => (
                              <div
                                key={conversation.id}
                                className="rounded-2xl border border-border/70 bg-muted/[0.18] px-3 py-3 transition-colors group-hover:border-primary/15"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="truncate text-sm font-semibold text-foreground">{conversation.contact_name}</div>
                                  {conversation.unread_count > 0 ? (
                                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                                      {conversation.unread_count}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {conversation.last_message || 'Sem mensagens registradas.'}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 border-t border-border/80 pt-4">
                        <Button type="button" className="rounded-full" onClick={() => openLabelDetails(label.id)}>
                          <Eye className="h-4 w-4" />
                          Abrir lista
                        </Button>
                      </div>
                    </div>
                  </div>
                </PageSectionCard>
              );
            })}
          </div>
        )
      ) : (
        <KanbanBoard
          labels={labelSummary}
          conversations={conversations}
          isLoading={isLoadingConversations}
          onStageChange={handleStageChange}
        />
      )}

      <LabelFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreateLabel}
      />
    </PageShell>
  );
}
