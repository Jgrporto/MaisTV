import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  Copy,
  Edit3,
  FileAudio,
  FileText,
  FlaskConical,
  Folder,
  Image as ImageIcon,
  MoreVertical,
  Search,
  Send,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  DEFAULT_QUICK_REPLY_CATEGORIES,
  deleteQuickReplyCategory,
  listQuickReplyCategories,
  saveQuickReplyCategory,
  saveQuickReplyCategoriesOrder,
} from '@/lib/quick-reply-categories';
import {
  deleteQuickReply,
  getQuickReplyActions,
  getQuickReplyPreviewText,
  listQuickReplies,
  saveQuickReply,
} from '@/lib/quick-replies';
import { fetchScheduleSettings } from '@/lib/schedule-settings';
import QuickReplyCategoryManager from './QuickReplyCategoryManager';
import QuickReplyForm from './QuickReplyForm';
import QuickReplyScheduleModal from './QuickReplyScheduleModal';

const actionIcons = {
  text: FileText,
  image: ImageIcon,
  video: Video,
  audio: FileAudio,
  document: FileText,
  timer: FileText,
  wait: FileText,
  ura: FileText,
  transfer: Send,
  newbr_test: FlaskConical,
  utility: FileText,
  unsupported: FileText,
};

const legacyCategoryLabels = {
  greeting: 'Saudação',
  farewell: 'Despedida',
  faq: 'FAQ',
  sales: 'Vendas',
  support: 'Suporte',
  disparo: 'Disparo',
  other: 'Sem Categoria',
};

const findCategory = (reply, categories) => {
  const byId = categories.find((category) => category.id === reply.categoryId);
  if (byId) return byId;

  const legacyName = legacyCategoryLabels[reply.category] || reply.category || 'Sem Categoria';
  return (
    categories.find((category) => category.name.toLowerCase() === legacyName.toLowerCase()) || {
      ...DEFAULT_QUICK_REPLY_CATEGORIES[3],
      name: legacyName || 'Sem Categoria',
    }
  );
};

const normalizeCategoryText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const isScheduledCategory = (category = {}) => {
  const normalizedName = normalizeCategoryText(category.name || category.id);
  return normalizedName.includes('agendad') || normalizedName.includes('schedule');
};

export default function QuickReplySidePanel({ open, onClose, onExecute, conversation, currentUser, templates = [], isWithin24hWindow = false }) {
  const [mode, setMode] = useState('list');
  const [editingReply, setEditingReply] = useState(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(['cat-apps', 'cat-tests', 'cat-payment', 'cat-none']));
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [scheduleReply, setScheduleReply] = useState(null);
  const queryClient = useQueryClient();

  const repliesQuery = useQuery({
    queryKey: ['quick-replies'],
    queryFn: () => listQuickReplies(),
    enabled: open,
  });

  const categoriesQuery = useQuery({
    queryKey: ['quick-reply-categories'],
    queryFn: () => listQuickReplyCategories(),
    enabled: open,
  });

  const scheduleSettingsQuery = useQuery({
    queryKey: ['settings', 'schedule-settings'],
    queryFn: fetchScheduleSettings,
    enabled: open,
  });

  const categories = useMemo(() => {
    const loaded = Array.isArray(categoriesQuery.data) ? categoriesQuery.data : [];
    const byName = new Map();
    [...loaded, ...DEFAULT_QUICK_REPLY_CATEGORIES].forEach((category) => {
      const key = String(category.name || '').trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, category);
    });
    return Array.from(byName.values()).sort((left, right) => {
      const leftName = String(left.name || '').toLowerCase();
      const rightName = String(right.name || '').toLowerCase();
      const leftIsFallback = left.id === 'cat-none' || leftName === 'sem categoria';
      const rightIsFallback = right.id === 'cat-none' || rightName === 'sem categoria';
      if (leftIsFallback !== rightIsFallback) return leftIsFallback ? 1 : -1;
      const leftOrder = Number.isFinite(Number(left.sortOrder)) ? Number(left.sortOrder) : 9999;
      const rightOrder = Number.isFinite(Number(right.sortOrder)) ? Number(right.sortOrder) : 9999;
      return leftOrder - rightOrder || String(left.name || '').localeCompare(String(right.name || ''), 'pt-BR');
    });
  }, [categoriesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload) => saveQuickReply(payload, payload?.id || null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-replies'] });
      setMode('list');
      setEditingReply(null);
      toast.success('Resposta rápida salva.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuickReply(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-replies'] });
      toast.success('Resposta rápida excluída.');
    },
  });

  const categorySaveMutation = useMutation({
    mutationFn: ({ payload, id }) => saveQuickReplyCategory(payload, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quick-reply-categories'] }),
  });

  const categoryDeleteMutation = useMutation({
    mutationFn: (id) => deleteQuickReplyCategory(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quick-reply-categories'] }),
  });

  const categoryOrderMutation = useMutation({
    mutationFn: (orderedCategories) => saveQuickReplyCategoriesOrder(orderedCategories),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-reply-categories'] });
      toast.success('Ordem das categorias salva.');
    },
  });

  const filteredReplies = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const items = Array.isArray(repliesQuery.data) ? repliesQuery.data : [];

    return items
      .filter((reply) => {
        const category = findCategory(reply, categories);
        const actions = getQuickReplyActions(reply);
        const haystack = [
          reply.title,
          reply.content,
          reply.shortcut,
          category.name,
          ...actions.flatMap((action) => [
            action.type,
            action.content,
            action.caption,
            action.media?.fileName,
            action.metadata?.listTitle,
            action.metadata?.description,
            action.metadata?.targetDepartment,
          ]),
        ]
          .join(' ')
          .toLowerCase();

        const visibleInQuickReplies = category.visibleInQuickReplies !== false;
        return visibleInQuickReplies && (!normalizedSearch || haystack.includes(normalizedSearch));
      })
      .sort((left, right) => String(left.title || '').localeCompare(String(right.title || ''), 'pt-BR'));
  }, [categories, repliesQuery.data, search]);

  const groupedReplies = useMemo(() => {
    const groups = new Map();
    filteredReplies.forEach((reply) => {
      const category = findCategory(reply, categories);
      const key = category.id || category.name;
      if (!groups.has(key)) groups.set(key, { category, replies: [] });
      groups.get(key).replies.push(reply);
    });
    return Array.from(groups.values()).sort((left, right) => {
      const leftName = String(left.category.name || '').toLowerCase();
      const rightName = String(right.category.name || '').toLowerCase();
      const leftIsFallback = left.category.id === 'cat-none' || leftName === 'sem categoria';
      const rightIsFallback = right.category.id === 'cat-none' || rightName === 'sem categoria';
      if (leftIsFallback !== rightIsFallback) return leftIsFallback ? 1 : -1;
      const leftOrder = Number.isFinite(Number(left.category.sortOrder)) ? Number(left.category.sortOrder) : 9999;
      const rightOrder = Number.isFinite(Number(right.category.sortOrder)) ? Number(right.category.sortOrder) : 9999;
      return leftOrder - rightOrder || left.category.name.localeCompare(right.category.name, 'pt-BR');
    });
  }, [categories, filteredReplies]);

  const startCreate = () => {
    setEditingReply(null);
    setMode('form');
  };

  const startEdit = (reply) => {
    setEditingReply(reply);
    setMode('form');
  };

  const duplicateReply = (reply) => {
    saveMutation.mutate({
      ...reply,
      id: '',
      title: `${reply.title} (cópia)`,
      shortcut: '',
      usageCount: 0,
    });
  };

  const confirmDelete = (reply) => {
    if (window.confirm(`Excluir "${reply.title}"?`)) {
      deleteMutation.mutate(reply.id);
    }
  };

  const toggleGroup = (groupId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  if (!open) return null;

  return (
    <aside className="h-full w-full overflow-hidden border-l border-border bg-card shadow-2xl animate-in slide-in-from-right-4 duration-200">
      {mode === 'form' ? (
        <QuickReplyForm
          reply={editingReply}
          categories={categories}
          onBack={() => {
            setMode('list');
            setEditingReply(null);
          }}
          onSave={(payload) => saveMutation.mutate(payload)}
          isSaving={saveMutation.isPending}
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col text-foreground">
          <div className="shrink-0 border-b border-border p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Zap className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Respostas rápidas</h2>
                  <p className="text-[11px] text-muted-foreground">{filteredReplies.length} item(ns)</p>
                </div>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <div className="relative min-w-0">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Pesquisar resposta rápida"
                  className="h-10 border-border bg-background pl-9 text-sm"
                />
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                    <i className="fa-solid fa-layer-group text-[13px]" aria-hidden="true" />
                    Gerenciar
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={startCreate}>Respostas Rápidas</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCategoryDialogOpen(true)}>Categorias</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3">
            {repliesQuery.isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Carregando respostas rápidas...</div>
            ) : groupedReplies.length === 0 ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/50 p-6 text-center">
                <Zap className="mb-3 h-10 w-10 text-muted-foreground" />
                <p className="text-sm font-semibold text-foreground">Nenhuma resposta rápida encontrada.</p>
                <Button type="button" className="mt-4 h-9 bg-primary text-primary-foreground hover:bg-primary/90" onClick={startCreate}>
                  Criar resposta rápida
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {groupedReplies.map(({ category, replies }) => {
                  const groupId = category.id || category.name;
                  const isOpen = expanded.has(groupId);
                  return (
                    <section key={groupId} className="overflow-hidden rounded-xl border border-border bg-background/60">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                        onClick={() => toggleGroup(groupId)}
                        style={{ background: `linear-gradient(90deg, ${category.color}18, transparent)` }}
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: `${category.color}22`, color: category.color }}>
                          <Folder className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{category.name}</span>
                        <Badge className="border-border bg-muted text-[10px] text-muted-foreground">{replies.length}</Badge>
                        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', !isOpen && '-rotate-90')} />
                      </button>

                      {isOpen ? (
                        <div className="divide-y divide-border/60">
                          {replies.map((reply) => {
                            const actions = getQuickReplyActions(reply);
                            const primaryType = actions[0]?.type || reply.type || 'text';
                            const Icon = actionIcons[primaryType] || FileText;
                            const hideImmediateSend = isScheduledCategory(category);
                            return (
                              <div key={reply.id} className="flex min-w-0 items-center gap-2 px-3 py-2.5 hover:bg-accent/40">
                                <Icon className="h-4 w-4 shrink-0 text-primary" />
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => startEdit(reply)}>
                                  <p className="truncate text-xs font-semibold text-foreground">{reply.title}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">{getQuickReplyPreviewText(reply) || `${actions.length} ação(ões)`}</p>
                                </button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className={cn('h-8 w-8 shrink-0 text-primary hover:text-primary', hideImmediateSend && 'hidden')}
                                  onClick={() => onExecute(reply)}
                                  title="Enviar resposta rápida"
                                >
                                  <Send className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                                  onClick={() => setScheduleReply(reply)}
                                  title="Criar Agendamento"
                                  aria-label="Criar Agendamento"
                                >
                                  <i className="fa-solid fa-calendar-days text-[13px]" aria-hidden="true" />
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground">
                                      <MoreVertical className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => startEdit(reply)}>
                                      <Edit3 className="mr-2 h-4 w-4" /> Editar
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => duplicateReply(reply)}>
                                      <Copy className="mr-2 h-4 w-4" /> Duplicar
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-destructive" onClick={() => confirmDelete(reply)}>
                                      <Trash2 className="mr-2 h-4 w-4" /> Excluir
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <QuickReplyCategoryManager
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        categories={categories}
        onSave={(payload, id) => categorySaveMutation.mutate({ payload, id })}
        onSaveOrder={(orderedCategories) => categoryOrderMutation.mutate(orderedCategories)}
        onDelete={(id) => {
          if (window.confirm('Excluir esta categoria?')) categoryDeleteMutation.mutate(id);
        }}
        isSaving={categorySaveMutation.isPending || categoryDeleteMutation.isPending || categoryOrderMutation.isPending}
      />

      <QuickReplyScheduleModal
        open={Boolean(scheduleReply)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setScheduleReply(null);
        }}
        selectedReply={scheduleReply}
        quickReplies={Array.isArray(repliesQuery.data) ? repliesQuery.data : []}
        conversation={conversation}
        currentUser={currentUser}
        templates={templates}
        isWithin24hWindow={isWithin24hWindow}
        scheduleSettings={scheduleSettingsQuery.data || null}
      />
    </aside>
  );
}
