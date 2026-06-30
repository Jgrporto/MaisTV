import React, { useMemo, useState } from 'react';
import {
  AudioLines,
  ChevronDown,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  List,
  MessageSquareText,
  Send,
  Timer,
  Video,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import QuickReplyActionCard from './QuickReplyActionCard';

const createAction = (type) => ({
  id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  type,
  title: '',
  content: '',
  caption: '',
  media: { dataUrl: '', fileName: '', mimeType: '', kind: type },
  displayOnce: false,
  typingDelaySeconds: 0,
  nextActionDelaySeconds: type === 'timer' ? 2 : 0,
  metadata:
    type === 'ura'
      ? {
          listTitle: '',
          description: '',
          uraOptions: [
            { id: 'option-1', label: 'Opção 1', value: 'Opção 1' },
            { id: 'option-2', label: 'Opção 2', value: 'Opção 2' },
          ],
        }
      : type === 'transfer'
        ? { targetDepartment: '', targetAgent: '', internalMessage: '', customerMessage: '' }
        : {},
  ...(type === 'newbr_test'
    ? {
        label: 'Teste completo 4 horas',
        durationMinutes: 240,
        followUpEnabled: true,
        followUpBeforeMinutes: 10,
        followUpMessage: 'Seu teste esta quase acabando. Ainda posso te ajudar a ativar o acesso definitivo?',
      }
    : {}),
});

const actionGroups = [
  {
    label: 'Enviar Mensagem',
    items: [
      { type: 'text', label: 'Texto', icon: MessageSquareText, available: true },
      { type: 'image', label: 'Imagem', icon: ImageIcon, available: true },
      { type: 'video', label: 'Vídeo', icon: Video, available: true },
      { type: 'audio', label: 'Áudio', icon: AudioLines, available: true },
      { type: 'document', label: 'Documentos', icon: FileText, available: true },
      { type: 'ura', label: 'URA', icon: List, available: true },
    ],
  },
  {
    label: 'Temporizador',
    items: [{ type: 'timer', label: 'Espera', icon: Timer, available: true }],
  },
  {
    label: 'Testes',
    items: [{ type: 'newbr_test', label: 'Teste completo 4 horas', icon: FlaskConical, available: true }],
  },
  {
    label: 'Transferir Atendimento',
    items: [{ type: 'transfer', label: 'Transferir', icon: Send, available: true }],
  },
];

export default function QuickReplyActionBuilder({
  actions,
  onActionsChange,
  onFocusText,
  variables = [],
  onInsertVariable,
  leadingContent = null,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set(['Enviar Mensagem']));

  const safeActions = useMemo(() => (Array.isArray(actions) ? actions : []), [actions]);

  const addAction = (item) => {
    onActionsChange([...safeActions, createAction(item.type)]);
    setMenuOpen(false);
  };

  const updateAction = (index, action) => {
    const nextActions = [...safeActions];
    nextActions[index] = action;
    onActionsChange(nextActions);
  };

  const moveAction = (index, direction) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= safeActions.length) return;
    const nextActions = [...safeActions];
    const [item] = nextActions.splice(index, 1);
    nextActions.splice(targetIndex, 0, item);
    onActionsChange(nextActions);
  };

  const toggleMenuGroup = (label) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card/90 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Ação da Resposta Rápida</p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="mt-1 inline-flex rounded-full">
                <Badge className="border-primary/25 bg-primary/10 text-[10px] text-primary">#Variáveis {`{}`}</Badge>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {variables.map((variable) => (
                <DropdownMenuItem key={variable.key} onClick={() => onInsertVariable?.(variable.key)}>
                  {variable.key}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="relative">
          <Button type="button" size="sm" className="h-8 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setMenuOpen((value) => !value)}>
            Adicionar Ação
          </Button>
          {menuOpen ? (
            <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-2xl">
              {actionGroups.map((group) => (
                <div key={group.label} className="py-0.5">
                  <button
                    type="button"
                    onClick={() => toggleMenuGroup(group.label)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-semibold text-foreground transition-colors hover:bg-accent"
                  >
                    <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', !expandedGroups.has(group.label) && '-rotate-90')} />
                    <span className="flex-1">{group.label}</span>
                  </button>
                  {expandedGroups.has(group.label) ? (
                    <div className="ml-4 mt-1 space-y-1 border-l border-border pl-2">
                      {group.items.map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.type}
                            type="button"
                            onClick={() => addAction(item)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <Icon className="h-3.5 w-3.5 text-primary" />
                            <span className="min-w-0 truncate">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {leadingContent ? <div className="mb-3">{leadingContent}</div> : null}

      {safeActions.length === 0 ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/50 p-5 text-center">
          <MessageSquareText className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">Nenhuma ação foi atribuída</p>
          <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-muted-foreground">
            Adicione ação para criar e configurar modelos de envio personalizados para seus clientes
          </p>
          <Button type="button" className="mt-4 h-9 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setMenuOpen(true)}>
            Adicionar Ação
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {safeActions.map((action, index) => (
            <QuickReplyActionCard
              key={action.id}
              action={action}
              index={index}
              onChange={(nextAction) => updateAction(index, nextAction)}
              onDelete={() => onActionsChange(safeActions.filter((_, itemIndex) => itemIndex !== index))}
              onMoveUp={() => moveAction(index, -1)}
              onMoveDown={() => moveAction(index, 1)}
              onFocusText={onFocusText}
              variables={variables}
              onInsertVariable={onInsertVariable}
            />
          ))}
        </div>
      )}
    </div>
  );
}
