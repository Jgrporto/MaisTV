import React, { useMemo, useState } from 'react';
import { ArrowLeft, Smile } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CHATBOT_VARIABLES } from '@/lib/chatbot-flows-api';
import { getQuickReplyActions, getQuickReplyPreviewText } from '@/lib/quick-replies';
import QuickReplyActionBuilder from './QuickReplyActionBuilder';
import QuickReplyCategorySelect from './QuickReplyCategorySelect';

const extraVariables = [
  { key: '{#nome}', label: 'Nome' },
  { key: '{#telefone}', label: 'Telefone' },
  { key: '{#protocolo}', label: 'Protocolo' },
  { key: '{#atendente}', label: 'Atendente' },
  { key: '{#servico}', label: 'Serviço' },
  { key: '{#usuarioTeste}', label: 'Usuario do teste' },
  { key: '{#senhaTeste}', label: 'Senha do teste' },
  { key: '{#codigoTeste}', label: 'Codigo do teste' },
  { key: '{#provedorTeste}', label: 'Provedor do teste' },
  { key: '{#urlTeste}', label: 'URL do teste' },
  { key: '{#urlTesteAlternativo}', label: 'URL alternativa' },
  { key: '{#urlTesteAlternativo1}', label: 'URL alternativa 2' },
  { key: '{#vencimentoTeste}', label: 'Vencimento do teste' },
  { key: '{#tempoRestanteTeste}', label: 'Tempo restante do teste' },
];

const normalizeVariableKey = (key) => {
  const raw = String(key || '').trim();
  const chatbotMatch = raw.match(/^\{#([^}]+)\}$/);
  if (chatbotMatch) return raw;
  const legacyMatch = raw.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (legacyMatch) return `{#${legacyMatch[1].trim()}}`;
  return raw;
};

const buildInitialForm = (reply) => ({
  title: String(reply?.title || ''),
  shortcut: String(reply?.shortcut || ''),
  category: String(reply?.category || 'other'),
  categoryId: String(reply?.categoryId || ''),
  actions: reply ? getQuickReplyActions(reply) : [],
});

export default function QuickReplyForm({
  reply,
  categories,
  onBack,
  onSave,
  isSaving,
}) {
  const [form, setForm] = useState(() => buildInitialForm(reply));
  const [activeTextTarget, setActiveTextTarget] = useState(null);

  const variables = useMemo(() => {
    const merged = [...extraVariables, ...CHATBOT_VARIABLES.map((variable) => ({ ...variable, key: normalizeVariableKey(variable.key) }))];
    const seen = new Set();
    return merged.filter((variable) => {
      const key = String(variable.key || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, []);

  const insertVariable = (variableKey) => {
    if (!activeTextTarget?.actionId || !activeTextTarget.field) {
      toast.message('Selecione um campo de texto para inserir a variável.');
      return;
    }

    setForm((current) => ({
      ...current,
      actions: current.actions.map((action) => {
        if (action.id !== activeTextTarget.actionId) return action;
        const currentValue = String(action[activeTextTarget.field] || '');
        const cursor = Math.max(0, Math.min(activeTextTarget.cursor ?? currentValue.length, currentValue.length));
        if (activeTextTarget.field === 'metadata.customerMessage') {
          const metadata = action.metadata || {};
          const metadataValue = String(metadata.customerMessage || '');
          const metadataCursor = Math.max(0, Math.min(activeTextTarget.cursor ?? metadataValue.length, metadataValue.length));
          return {
            ...action,
            metadata: {
              ...metadata,
              customerMessage: `${metadataValue.slice(0, metadataCursor)}${variableKey}${metadataValue.slice(metadataCursor)}`,
            },
          };
        }

        return {
          ...action,
          [activeTextTarget.field]: `${currentValue.slice(0, cursor)}${variableKey}${currentValue.slice(cursor)}`,
        };
      }),
    }));
  };

  const handleSave = () => {
    const title = form.title.trim();
    if (!title) {
      toast.error('Informe o título da resposta rápida.');
      return;
    }
    if (!form.actions.length) {
      toast.error('Adicione pelo menos uma ação.');
      return;
    }

    const content = getQuickReplyPreviewText({ content: '', actions: form.actions });
    onSave({
      ...reply,
      title,
      shortcut: form.shortcut.trim(),
      category: form.category || 'other',
      categoryId: form.categoryId || '',
      type: form.actions[0]?.type || 'text',
      content,
      actions: form.actions,
      usageCount: Number(reply?.usageCount || 0),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div className="grid h-14 shrink-0 grid-cols-[40px_1fr_40px] items-center border-b border-border px-3">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-center text-sm font-semibold text-foreground">
          {reply ? 'Editar Resposta Rápida' : 'Criar Resposta Rápida'}
        </h2>
        <span />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Título</span>
          <div className="relative">
            <Input
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Digite o título da resposta rápida"
              className="h-10 border-border bg-background pr-10 text-sm"
            />
            <Smile className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Atalho</span>
          <Input
            value={form.shortcut}
            onChange={(event) => setForm({ ...form, shortcut: event.target.value })}
            placeholder="/atalho"
            className="h-10 border-border bg-background text-sm"
          />
        </label>

        <QuickReplyActionBuilder
          actions={form.actions}
          onActionsChange={(actions) => setForm({ ...form, actions })}
          onFocusText={(actionId, field, cursor) => setActiveTextTarget({ actionId, field, cursor })}
          variables={variables}
          onInsertVariable={insertVariable}
        />

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Selecione uma categoria</span>
          <QuickReplyCategorySelect
            value={form.categoryId}
            categories={categories}
            onChange={(categoryId) => setForm({ ...form, categoryId })}
          />
        </label>
      </div>

      <div className="shrink-0 border-t border-border p-4">
        <Button
          type="button"
          className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={isSaving}
          onClick={handleSave}
        >
          {isSaving ? 'Salvando...' : reply ? 'Editar' : 'Criar'}
        </Button>
      </div>
    </div>
  );
}
