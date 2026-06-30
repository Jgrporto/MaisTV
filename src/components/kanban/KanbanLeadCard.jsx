import React, { memo } from 'react';
import {
  CalendarClock,
  Copy,
  ExternalLink,
  GripVertical,
  Image as ImageIcon,
  MessageCircleMore,
  Mic,
  MoreHorizontal,
  NotebookPen,
  Phone,
  UserRound,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';

import ContactAvatar from '@/components/chat/ContactAvatar';
import LabelBadge from '@/components/labels/LabelBadge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatDateLabel(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '';

  const date = new Date(timestamp);
  const today = new Date();
  const isSameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();

  if (isSameDay) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

async function copyText(value, label) {
  if (!String(value || '').trim()) {
    toast.message(`Sem ${label.toLowerCase()} disponivel neste card.`);
    return;
  }

  try {
    await navigator.clipboard.writeText(String(value));
    toast.success(`${label} copiado.`);
  } catch {
    toast.error(`Nao foi possivel copiar ${label.toLowerCase()}.`);
  }
}

function getMediaSummary(conversation) {
  const items = [];

  if (conversation.media_summary?.hasAudio) {
    items.push({ id: 'audio', label: 'Audio', icon: Mic });
  }

  if (conversation.media_summary?.hasImage) {
    items.push({ id: 'image', label: 'Imagem', icon: ImageIcon });
  }

  if (conversation.media_summary?.hasVideo) {
    items.push({ id: 'video', label: 'Video', icon: Video });
  }

  return items;
}

function KanbanLeadCardComponent({
  conversation,
  dragHandleProps,
  className,
  showStageBadge = false,
}) {
  const phoneDigits = normalizePhoneDigits(conversation.contact_phone);
  const mediaSummary = getMediaSummary(conversation);
  const hasNote = Boolean(conversation.notes);
  const hasFollowUp = Boolean(conversation.follow_up_at);
  const hasAgent = Boolean(conversation.assigned_agent_name);

  return (
    <article
      className={cn(
        'group rounded-[20px] border border-border/70 bg-card p-3 shadow-[0_6px_18px_rgba(15,23,42,0.03)] [contain:layout_style_paint] transition-colors hover:border-primary/20',
        className
      )}
    >
      <div className="flex items-start gap-3">
        <ContactAvatar
          src={conversation.avatar_url}
          name={conversation.contact_name}
          className="h-10 w-10"
          fallbackClassName="from-primary/70 to-primary"
          textClassName="text-xs"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">{conversation.contact_name}</h3>
                {conversation.unread_count > 0 ? (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                    {conversation.unread_count}
                  </span>
                ) : null}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                {conversation.contact_phone ? <span className="truncate">{conversation.contact_phone}</span> : null}
                {conversation.updated_date || conversation.last_message_time ? (
                  <span>{formatDateLabel(conversation.updated_date || conversation.last_message_time)}</span>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-1">
              {phoneDigits ? (
                <Button asChild variant="ghost" size="icon" className="h-8 w-8 rounded-full text-emerald-700 hover:text-emerald-800">
                  <a
                    href={`https://wa.me/${phoneDigits}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Abrir no WhatsApp"
                  >
                    <MessageCircleMore className="h-4 w-4" />
                  </a>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground"
                  onClick={() => toast.message('Este contato ainda nao possui telefone valido para acao rapida.')}
                  title="Abrir no WhatsApp"
                >
                  <Phone className="h-4 w-4" />
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full text-muted-foreground opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                    title="Mais acoes"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{conversation.contact_name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => copyText(conversation.contact_phone, 'Telefone')}>
                    <Copy className="h-4 w-4" />
                    Copiar telefone
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copyText(conversation.notes, 'Nota')}>
                    <NotebookPen className="h-4 w-4" />
                    Copiar nota
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      hasFollowUp
                        ? copyText(conversation.follow_up_at, 'Data de follow-up')
                        : toast.message('Este lead ainda nao possui follow-up agendado.')
                    }
                  >
                    <CalendarClock className="h-4 w-4" />
                    Follow-up
                  </DropdownMenuItem>
                  {phoneDigits ? (
                    <DropdownMenuItem asChild>
                      <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        Abrir no WhatsApp
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  {hasAgent ? (
                    <DropdownMenuItem disabled>
                      <UserRound className="h-4 w-4" />
                      {conversation.assigned_agent_name}
                    </DropdownMenuItem>
                  ) : null}
                  {mediaSummary.map(({ id, label, icon: Icon }) => (
                    <DropdownMenuItem key={id} disabled>
                      <Icon className="h-4 w-4" />
                      {label} recente
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <button
                type="button"
                className="hidden rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:block md:opacity-0 md:group-hover:opacity-100"
                aria-label="Arrastar card"
                {...dragHandleProps}
              >
                <GripVertical className="h-4 w-4" />
              </button>
            </div>
          </div>

          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {conversation.last_message || 'Sem mensagens registradas ate o momento.'}
          </p>

          <div className="mt-2 flex items-center gap-1.5">
            {showStageBadge && conversation.stage_label ? (
              <LabelBadge label={conversation.stage_label} compact />
            ) : null}
            {hasAgent ? (
              <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[10px] text-muted-foreground">
                {conversation.assigned_agent_name}
              </span>
            ) : null}
            {hasNote ? (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground" title="Possui nota">
                <NotebookPen className="h-3 w-3" />
              </span>
            ) : null}
            {hasFollowUp ? (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground" title="Possui follow-up">
                <CalendarClock className="h-3 w-3" />
              </span>
            ) : null}
            {mediaSummary.slice(0, 2).map(({ id, icon: Icon, label }) => (
              <span key={id} className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-muted-foreground" title={label}>
                <Icon className="h-3 w-3" />
              </span>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

const KanbanLeadCard = memo(KanbanLeadCardComponent);

export default KanbanLeadCard;
