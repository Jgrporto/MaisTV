import React, { useRef } from 'react';
import {
  Clock3,
  FileAudio,
  FileText,
  FlaskConical,
  GripVertical,
  Image as ImageIcon,
  List,
  Plus,
  Send,
  Trash2,
  Video,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const actionMeta = {
  text: { title: 'Criar Mensagem de Texto', icon: FileText, accept: '' },
  image: { title: 'Criar Mensagem de Imagem', icon: ImageIcon, accept: 'image/png,image/jpeg,image/jpg,image/webp,.png,.jpg,.jpeg,.webp' },
  video: { title: 'Criar Mensagem de Vídeo', icon: Video, accept: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov' },
  audio: { title: 'Criar Mensagem de Áudio', icon: FileAudio, accept: 'audio/*,.aac,.amr,.mp3,.m4a,.ogg' },
  document: {
    title: 'Criar Mensagem de Documento',
    icon: FileText,
    accept:
      '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
  },
  timer: { title: 'Espera', icon: Clock3, accept: '' },
  wait: { title: 'Espera', icon: Clock3, accept: '' },
  ura: { title: 'Criar URA', icon: List, accept: '' },
  transfer: { title: 'Transferir Atendimento', icon: Send, accept: '' },
  newbr_test: { title: 'Teste completo 4 horas', icon: FlaskConical, accept: '' },
  utility: { title: 'Utilitário importado', icon: FileText, accept: '' },
  unsupported: { title: 'Ação importada não suportada', icon: FileText, accept: '' },
};

const clampDelay = (value) => Math.max(0, Math.min(300, Number.isFinite(Number(value)) ? Number(value) : 0));

const resolveFileMimeType = (file, actionType) => {
  const fileName = String(file?.name || '').toLowerCase();
  if (file?.type) return file.type;
  if (fileName.endsWith('.webp')) return 'image/webp';
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  if (fileName.endsWith('.webm')) return 'video/webm';
  if (fileName.endsWith('.mov')) return 'video/quicktime';
  if (fileName.endsWith('.ogg')) return 'audio/ogg';
  if (fileName.endsWith('.mp3')) return 'audio/mpeg';
  return actionType === 'image'
    ? 'image/png'
    : actionType === 'video'
      ? 'video/mp4'
      : actionType === 'audio'
        ? 'audio/ogg'
        : 'application/octet-stream';
};

const fileToDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });

const DelayInput = ({ label, value, onChange }) => (
  <label className="space-y-1.5">
    <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    <Input
      type="number"
      min="0"
      max="300"
      value={value ?? 0}
      onChange={(event) => onChange(clampDelay(event.target.value))}
      className="h-9 border-border bg-background text-sm"
    />
  </label>
);

export default function QuickReplyActionCard({
  action,
  index,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onFocusText,
  variables = [],
  onInsertVariable,
}) {
  const fileInputRef = useRef(null);
  const meta = actionMeta[action.type] || actionMeta.text;
  const Icon = meta.icon;

  const patch = (updates) => onChange({ ...action, ...updates });
  const patchMetadata = (updates) => patch({ metadata: { ...(action.metadata || {}), ...updates } });

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const dataUrl = await fileToDataUrl(file);
    patch({
      media: {
        dataUrl,
        fileName: file.name || 'arquivo',
        mimeType: resolveFileMimeType(file, action.type),
        kind: action.type,
      },
    });
  };

  const renderMediaFields = () => {
    if (!['image', 'video', 'audio', 'document'].includes(action.type)) return null;

    return (
      <div className="space-y-3">
        <input ref={fileInputRef} type="file" className="hidden" accept={meta.accept} onChange={handleFile} />
        <Button
          type="button"
          variant="outline"
          className="h-9 border-border bg-background text-foreground hover:bg-accent"
          onClick={() => fileInputRef.current?.click()}
        >
          Selecionar arquivo
        </Button>

        {action.media?.dataUrl ? (
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            {action.type === 'image' ? (
              <img src={action.media.dataUrl} alt="" className="max-h-44 w-full object-cover" />
            ) : action.type === 'video' ? (
              <video src={action.media.dataUrl} controls className="max-h-44 w-full bg-black" />
            ) : action.type === 'audio' ? (
              <div className="p-3">
                <audio src={action.media.dataUrl} controls className="w-full" />
              </div>
            ) : (
              <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <FileText className="h-4 w-4 text-primary" />
                <span className="truncate">{action.media.fileName || 'Documento selecionado'}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-background/60 px-3 py-4 text-xs text-muted-foreground">
            Nenhum arquivo selecionado.
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-3 shadow-lg shadow-black/10">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{meta.title}</p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="shrink-0 rounded-full">
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
          <button
            type="button"
            onClick={() => onInsertVariable?.(variables[0]?.key)}
            className="mt-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
          >
            Insere no campo de texto ativo
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title="Mover ação"
            onClick={index > 0 ? onMoveUp : onMoveDown}
          >
            <GripVertical className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Excluir ação"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {action.type === 'timer' || action.type === 'wait' ? (
        <DelayInput
          label="Tempo de espera em segundos"
          value={action.waitSeconds ?? action.nextActionDelaySeconds}
          onChange={(value) => patch({ waitSeconds: value, nextActionDelaySeconds: value })}
        />
      ) : action.type === 'ura' ? (
        <div className="space-y-3">
          <Input
            value={action.ura?.title || action.metadata?.listTitle || ''}
            onChange={(event) => {
              patch({
                ura: { ...(action.ura || {}), title: event.target.value },
                metadata: { ...(action.metadata || {}), listTitle: event.target.value },
              });
            }}
            placeholder="Título da URA"
            className="h-9 border-border bg-background text-sm"
          />
          <Input
            value={action.ura?.description || action.metadata?.description || ''}
            onChange={(event) => {
              patch({
                ura: { ...(action.ura || {}), description: event.target.value },
                metadata: { ...(action.metadata || {}), description: event.target.value },
              });
            }}
            placeholder="Descrição opcional"
            className="h-9 border-border bg-background text-sm"
          />
          <Textarea
            value={action.content || ''}
            onFocus={(event) => onFocusText(action.id, 'content', event.currentTarget.selectionStart)}
            onSelect={(event) => onFocusText(action.id, 'content', event.currentTarget.selectionStart)}
            onChange={(event) => patch({ content: event.target.value })}
            placeholder="Texto principal da mensagem"
            className="min-h-[82px] border-border bg-background text-sm"
          />
          <Input
            value={action.ura?.buttonText || action.metadata?.buttonText || ''}
            onChange={(event) => {
              patch({
                ura: { ...(action.ura || {}), buttonText: event.target.value },
                metadata: { ...(action.metadata || {}), buttonText: event.target.value },
              });
            }}
            placeholder="Texto do botão principal, ex: Selecionar"
            className="h-9 border-border bg-background text-sm"
          />
          <Input
            value={action.ura?.footer || action.metadata?.footer || ''}
            onChange={(event) => {
              patch({
                ura: { ...(action.ura || {}), footer: event.target.value },
                metadata: { ...(action.metadata || {}), footer: event.target.value },
              });
            }}
            placeholder="Rodapé opcional"
            className="h-9 border-border bg-background text-sm"
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">Botões da URA</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={(action.ura?.options || action.metadata?.uraOptions || []).length >= 3}
                onClick={() => {
                  const currentOptions = action.ura?.options || action.metadata?.uraOptions || [];
                  const nextOptions = [
                    ...currentOptions,
                    { id: `option-${Date.now()}`, label: '', value: '', description: '' },
                  ];
                  patch({
                    ura: { ...(action.ura || {}), options: nextOptions },
                    metadata: { ...(action.metadata || {}), uraOptions: nextOptions },
                  });
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar opção
              </Button>
            </div>
            {(action.ura?.options || action.metadata?.uraOptions || []).map((option, optionIndex) => (
              <div key={option.id || optionIndex} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  value={option.label || ''}
                  onChange={(event) => {
                    const nextOptions = [...(action.ura?.options || action.metadata?.uraOptions || [])];
                    nextOptions[optionIndex] = { ...option, label: event.target.value };
                    patch({
                      ura: { ...(action.ura || {}), options: nextOptions },
                      metadata: { ...(action.metadata || {}), uraOptions: nextOptions },
                    });
                  }}
                  placeholder="Texto exibido"
                  className="h-9 border-border bg-background text-xs"
                />
                <Input
                  value={option.value || ''}
                  onChange={(event) => {
                    const nextOptions = [...(action.ura?.options || action.metadata?.uraOptions || [])];
                    nextOptions[optionIndex] = { ...option, value: event.target.value };
                    patch({
                      ura: { ...(action.ura || {}), options: nextOptions },
                      metadata: { ...(action.metadata || {}), uraOptions: nextOptions },
                    });
                  }}
                  placeholder="Valor"
                  className="h-9 border-border bg-background text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    const nextOptions = (action.ura?.options || action.metadata?.uraOptions || []).filter((_, currentIndex) => currentIndex !== optionIndex);
                    patch({
                      ura: { ...(action.ura || {}), options: nextOptions },
                      metadata: { ...(action.metadata || {}), uraOptions: nextOptions },
                    });
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Input
                  value={option.description || ''}
                  onChange={(event) => {
                    const nextOptions = [...(action.ura?.options || action.metadata?.uraOptions || [])];
                    nextOptions[optionIndex] = { ...option, description: event.target.value };
                    patch({
                      ura: { ...(action.ura || {}), options: nextOptions },
                      metadata: { ...(action.metadata || {}), uraOptions: nextOptions },
                    });
                  }}
                  placeholder="Descrição opcional"
                  className="col-span-3 h-9 border-border bg-background text-xs"
                />
              </div>
            ))}
            {(action.ura?.options || action.metadata?.uraOptions || []).some((option) => option.label) ? (
              <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-background/60 p-2">
                {(action.ura?.options || action.metadata?.uraOptions || [])
                  .filter((option) => option.label)
                  .map((option) => (
                    <Badge key={option.id || option.label} variant="outline" className="border-primary/25 bg-primary/10 text-[10px] text-primary">
                      {option.label}
                    </Badge>
                  ))}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <DelayInput label="Delay antes do envio" value={action.typingDelaySeconds} onChange={(value) => patch({ typingDelaySeconds: value })} />
            <DelayInput label="Delay antes da próxima ação" value={action.nextActionDelaySeconds} onChange={(value) => patch({ nextActionDelaySeconds: value })} />
          </div>
        </div>
      ) : action.type === 'newbr_test' ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Cria teste NewBR de 4 horas.</p>
            <p className="mt-1">As variaveis do teste ficam disponiveis nos modulos de texto seguintes.</p>
          </div>
          <Input
            value={action.label || 'Teste completo 4 horas'}
            onChange={(event) => patch({ label: event.target.value })}
            placeholder="Nome exibido"
            className="h-9 border-border bg-background text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Duracao em minutos</span>
              <Input
                type="number"
                min="1"
                value={action.durationMinutes ?? 240}
                onChange={(event) => patch({ durationMinutes: Math.max(1, Number(event.target.value) || 240) })}
                className="h-9 border-border bg-background text-sm"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">Follow-up antes do fim</span>
              <Input
                type="number"
                min="0"
                value={action.followUpBeforeMinutes ?? 10}
                onChange={(event) => patch({ followUpBeforeMinutes: Math.max(0, Number(event.target.value) || 0) })}
                className="h-9 border-border bg-background text-sm"
              />
            </label>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2">
            <span className="text-xs text-muted-foreground">Enviar follow-up em 03:50 apos criacao</span>
            <Switch checked={action.followUpEnabled !== false} onCheckedChange={(value) => patch({ followUpEnabled: value })} />
          </label>
          <Textarea
            value={action.followUpMessage || ''}
            onFocus={(event) => onFocusText(action.id, 'followUpMessage', event.currentTarget.selectionStart)}
            onSelect={(event) => onFocusText(action.id, 'followUpMessage', event.currentTarget.selectionStart)}
            onChange={(event) => patch({ followUpMessage: event.target.value })}
            placeholder="Mensagem de follow-up"
            className="min-h-[82px] border-border bg-background text-sm"
          />
          <div className="rounded-lg border border-border bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
            Cria teste de 4 horas. Follow-up em 03:50 apos criacao quando habilitado.
          </div>
        </div>
      ) : action.type === 'transfer' ? (
        <div className="space-y-3">
          <Input
            value={action.metadata?.targetDepartment || ''}
            onChange={(event) => patchMetadata({ targetDepartment: event.target.value })}
            placeholder="Setor/departamento destino"
            className="h-9 border-border bg-background text-sm"
          />
          <Input
            value={action.metadata?.targetAgent || ''}
            onChange={(event) => patchMetadata({ targetAgent: event.target.value })}
            placeholder="Atendente destino"
            className="h-9 border-border bg-background text-sm"
          />
          <Textarea
            value={action.metadata?.internalMessage || ''}
            onChange={(event) => patchMetadata({ internalMessage: event.target.value })}
            placeholder="Mensagem interna opcional"
            className="min-h-[72px] border-border bg-background text-sm"
          />
          <Textarea
            value={action.metadata?.customerMessage || ''}
            onFocus={(event) => onFocusText(action.id, 'metadata.customerMessage', event.currentTarget.selectionStart)}
            onSelect={(event) => onFocusText(action.id, 'metadata.customerMessage', event.currentTarget.selectionStart)}
            onChange={(event) => patchMetadata({ customerMessage: event.target.value })}
            placeholder="Mensagem opcional para o cliente antes da transferência"
            className="min-h-[72px] border-border bg-background text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <DelayInput label="Delay antes da ação" value={action.typingDelaySeconds} onChange={(value) => patch({ typingDelaySeconds: value })} />
            <DelayInput label="Delay antes da próxima ação" value={action.nextActionDelaySeconds} onChange={(value) => patch({ nextActionDelaySeconds: value })} />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {renderMediaFields()}

          {action.type === 'text' ? (
            <Textarea
              value={action.content || ''}
              onFocus={(event) => onFocusText(action.id, 'content', event.currentTarget.selectionStart)}
              onSelect={(event) => onFocusText(action.id, 'content', event.currentTarget.selectionStart)}
              onChange={(event) => patch({ content: event.target.value })}
              placeholder="Digite a mensagem"
              className="min-h-[104px] border-border bg-background text-sm"
            />
          ) : (
            <Textarea
              value={action.caption || ''}
              onFocus={(event) => onFocusText(action.id, 'caption', event.currentTarget.selectionStart)}
              onSelect={(event) => onFocusText(action.id, 'caption', event.currentTarget.selectionStart)}
              onChange={(event) => patch({ caption: event.target.value })}
              placeholder="Legenda/mensagem"
              className="min-h-[82px] border-border bg-background text-sm"
            />
          )}

          {action.type === 'image' ? (
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2">
              <span className="text-xs text-muted-foreground">Imagem com visualização única</span>
              <Switch checked={Boolean(action.displayOnce)} onCheckedChange={(value) => patch({ displayOnce: value })} />
            </label>
          ) : null}

          <div className={cn('grid gap-2', action.type === 'text' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2')}>
            <DelayInput
              label="Exibir digitando por X segundos"
              value={action.typingDelaySeconds}
              onChange={(value) => patch({ typingDelaySeconds: value })}
            />
            <DelayInput
              label="Aguardar próxima ação por X segundos"
              value={action.nextActionDelaySeconds}
              onChange={(value) => patch({ nextActionDelaySeconds: value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
