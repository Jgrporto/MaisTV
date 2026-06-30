import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ExternalLink,
  FileText,
  Headphones,
  Info,
  LoaderCircle,
  Plus,
  RotateCcw,
  Reply,
  SmilePlus,
  UserRound,
} from 'lucide-react';

import { getAttachmentDisplayLabel, resolveAttachmentKind } from '@/lib/whatsapp-media';
import { cn } from '@/lib/utils';
import ContactAvatar from './ContactAvatar';
import AudioTranscriptionPanel from './AudioTranscriptionPanel';
import AudioMessagePlayer from './AudioMessagePlayer';
import LazyMedia from '@/features/chat/components/LazyMedia';
import { fetchChatMediaUrl } from '@/lib/whatsapp-api';

const QUICK_REACTIONS = [
  '\uD83D\uDC4D',
  '\u2764\uFE0F',
  '\uD83D\uDE02',
  '\uD83D\uDE2E',
  '\uD83D\uDE22',
  '\uD83D\uDE4F',
];

const CHECKOUT_PUBLIC_URL = String(import.meta.env.VITE_CHECKOUT_PUBLIC_URL || 'https://maistv.hakione.tech/checkout')
  .trim()
  .replace(/\/+$/, '');

const REACTION_MENU_GAP_PX = 12;
const REACTION_MENU_VIEWPORT_PADDING_PX = 12;
const REACTION_MENU_CLOSE_DELAY_MS = 140;
const CONTEXT_MENU_VIEWPORT_PADDING_PX = 10;
const REACTION_ACTIVE_ZONE_PADDING_PX = 10;

function findOverlayBoundary(element) {
  if (!element || typeof element.closest !== 'function') return null;
  return element.closest('[data-chat-overlay-boundary="true"]');
}

function resolveFloatingOverlayPosition({
  anchorRect,
  overlayRect,
  boundaryRect,
  gap = 12,
  padding = 12,
}) {
  const minLeft = boundaryRect.left + padding;
  const maxLeft = boundaryRect.right - padding - overlayRect.width;

  let left = anchorRect.left + anchorRect.width / 2 - overlayRect.width / 2;
  if (maxLeft >= minLeft) {
    left = Math.max(minLeft, Math.min(left, maxLeft));
  } else {
    left = Math.max(boundaryRect.left, boundaryRect.left + (boundaryRect.width - overlayRect.width) / 2);
  }

  const preferredTop = anchorRect.top - overlayRect.height - gap;
  const preferredBottom = anchorRect.bottom + gap;
  const fitsAbove = preferredTop >= boundaryRect.top + padding;
  const fitsBelow = preferredBottom + overlayRect.height <= boundaryRect.bottom - padding;

  let top;
  let placement = 'above';
  if (fitsAbove) {
    top = preferredTop;
  } else if (fitsBelow) {
    top = preferredBottom;
    placement = 'below';
  } else {
    const minTop = boundaryRect.top + padding;
    const maxTop = boundaryRect.bottom - padding - overlayRect.height;
    top = Math.max(minTop, Math.min(preferredBottom, maxTop));
    placement = top > anchorRect.top ? 'below' : 'above';
  }

  return { top, left, placement };
}

function resolveContextMenuPosition({
  point,
  overlayRect,
  boundaryRect,
  padding = CONTEXT_MENU_VIEWPORT_PADDING_PX,
}) {
  const minLeft = boundaryRect.left + padding;
  const maxLeft = boundaryRect.right - padding - overlayRect.width;
  const minTop = boundaryRect.top + padding;
  const maxTop = boundaryRect.bottom - padding - overlayRect.height;

  const left =
    maxLeft >= minLeft ? Math.max(minLeft, Math.min(point.x, maxLeft)) : Math.max(boundaryRect.left, minLeft);
  const top =
    maxTop >= minTop ? Math.max(minTop, Math.min(point.y, maxTop)) : Math.max(boundaryRect.top, minTop);

  return { top, left };
}

function isPointInsideRect(point, rect, padding = 0) {
  if (!rect) return false;

  return (
    point.x >= rect.left - padding &&
    point.x <= rect.right + padding &&
    point.y >= rect.top - padding &&
    point.y <= rect.bottom + padding
  );
}

function buildRectsUnion(rects) {
  const validRects = rects.filter(Boolean);
  if (validRects.length === 0) return null;

  return {
    left: Math.min(...validRects.map((rect) => rect.left)),
    top: Math.min(...validRects.map((rect) => rect.top)),
    right: Math.max(...validRects.map((rect) => rect.right)),
    bottom: Math.max(...validRects.map((rect) => rect.bottom)),
  };
}

function resolveAttachmentType(attachment) {
  if (String(attachment?.type || '').trim().toLowerCase() === 'contact') return 'contact';
  const kind = resolveAttachmentKind(attachment);
  if (kind === 'sticker') return 'image';
  return kind || 'document';
}

function isDecorativeMediaLabel(content, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  const normalized = String(content || '').trim().toLowerCase();
  const hasContactAttachment = attachments.some((attachment) => resolveAttachmentType(attachment) === 'contact');
  if (hasContactAttachment && normalized.startsWith('[contato]')) return true;
  return ['[audio]', '[image]', '[imagem]', '[video]', '[figurinha]', '[sticker]', '[contato]'].includes(normalized);
}

function getFirstName(value, fallback = 'Mensagem') {
  const safeValue = String(value || '').trim();
  if (!safeValue) return fallback;
  return safeValue.split(/\s+/)[0] || fallback;
}

function isGenericAgentSenderName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['agente', 'agent'].includes(normalized);
}

function resolveAgentSenderName(message = {}) {
  const raw = message?.raw || {};
  const candidates = [
    message.sender_name,
    message.agentName,
    message.agent_name,
    message.senderName,
    message.operatorName,
    message.operator_name,
    message.attendantName,
    message.attendant_name,
    message.createdByName,
    message.created_by_name,
    message.userName,
    message.user_name,
    raw.sender_name,
    raw.agentName,
    raw.agent_name,
    raw.senderName,
    raw.operatorName,
    raw.operator_name,
    raw.attendantName,
    raw.attendant_name,
    raw.createdByName,
    raw.created_by_name,
    raw.userName,
    raw.user_name,
    raw.user?.full_name,
    raw.user?.name,
    raw.agent?.full_name,
    raw.agent?.name,
  ];

  return candidates
    .map((candidate) => String(candidate || '').trim())
    .find((candidate) => candidate && !isGenericAgentSenderName(candidate)) || '';
}

function resolveReplyPreview(message, fallbackName, isAgentMessage) {
  const preview = message?.reply_preview;
  if (preview && typeof preview === 'object') {
    return {
      senderName: getFirstName(preview.senderName || fallbackName || 'Mensagem'),
      text: String(preview.text || '').trim() || 'Mensagem',
      kind: String(preview.kind || 'text').trim().toLowerCase() || 'text',
    };
  }

  const fallbackText = String(message?.reply_to || '').trim();
  const normalizedFallback = fallbackText.toLowerCase();
  if (normalizedFallback === '[audio]') {
    return { senderName: fallbackName || 'Mensagem', text: 'Audio', kind: 'audio' };
  }
  if (normalizedFallback === '[image]' || normalizedFallback === '[imagem]') {
    return { senderName: fallbackName || 'Mensagem', text: 'Imagem', kind: 'image' };
  }
  if (normalizedFallback === '[video]') {
    return { senderName: getFirstName(fallbackName, 'Mensagem'), text: 'Video', kind: 'video' };
  }

  return {
    senderName: getFirstName(fallbackName || (isAgentMessage ? 'Cliente' : 'Agente'), 'Mensagem'),
    text: fallbackText || 'Mensagem',
    kind: 'text',
  };
}

function aggregateReactions(reactions) {
  const map = new Map();

  (Array.isArray(reactions) ? reactions : []).forEach((reaction) => {
    const emoji = String(reaction?.emoji || '').trim();
    if (!emoji) return;

    const current = map.get(emoji) || {
      emoji,
      count: 0,
      reactedByAgent: false,
    };

    current.count += 1;
    if (reaction?.from === 'agent') {
      current.reactedByAgent = true;
    }
    map.set(emoji, current);
  });

  return [...map.values()];
}

function BrokenAttachment({ attachment, type }) {
  return (
    <div className="mt-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 flex-shrink-0" />
        <span className="font-medium">Midia indisponivel</span>
      </div>
      <p className="mt-1 text-xs text-amber-900/80">
        Nao foi possivel carregar este {type === 'document' ? 'arquivo' : 'anexo'} pela API atual.
      </p>
      {attachment?.url ? (
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
        >
          Abrir anexo
          <ExternalLink className="w-3 h-3" />
        </a>
      ) : null}
    </div>
  );
}

function AttachmentPreview({
  attachment,
  mediaItem,
  onOpenMedia,
  transcription,
  isTranscribing = false,
  onTranscribeAudio,
  isAgent = false,
}) {
  const [failed, setFailed] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const attachmentType = useMemo(() => resolveAttachmentType(attachment), [attachment]);
  const isSticker = resolveAttachmentKind(attachment) === 'sticker' || String(attachment?.name || '').trim().toLowerCase() === 'sticker';
  const attachmentUrl = String(attachment?.url || '').trim();
  const mediaId = String(attachment?.mediaId || attachment?.media_id || attachment?.id || '').trim();
  const resolveMediaSource = mediaId
    ? () => fetchChatMediaUrl(mediaId, attachmentType === 'image' ? 'thumbnail' : 'original')
    : undefined;

  if (attachmentType === 'contact') {
    const contact = attachment?.contact && typeof attachment.contact === 'object' ? attachment.contact : {};
    const contactName = String(contact.name || attachment.name || 'Contato').trim();
    const phones = Array.isArray(contact.phones) ? contact.phones : [];
    const phone = String(contact.wa_id || contact.waId || contact.phone || phones[0] || '').replace(/\D/g, '');
    return (
      <div className="mt-2 min-w-[220px] rounded-xl border border-black/10 bg-black/5 p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserRound className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{contactName}</p>
            {phone ? <p className="truncate text-xs opacity-70">+{phone}</p> : null}
          </div>
        </div>
        {phone ? (
          <button
            type="button"
            className="mt-3 w-full rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary transition hover:bg-primary/15"
            onClick={() => mediaItem?.onStartConversation?.(phone)}
          >
            Iniciar Conversa
          </button>
        ) : null}
      </div>
    );
  }

  if (!attachmentUrl && !mediaId) return null;
  if (failed) return <BrokenAttachment attachment={attachment} type={attachmentType} />;

  if (attachmentType === 'image') {
    return (
      <LazyMedia
        className="mt-2"
        sourceUrl={attachmentUrl}
        resolveSource={resolveMediaSource}
        placeholder={<div className="h-36 w-full animate-pulse rounded-xl bg-black/10" aria-label="Carregando imagem" />}
      >
        {({ src }) => (
        <button
          type="button"
          className={cn(
            'block overflow-hidden rounded-xl border border-black/5 bg-black/5',
            isSticker ? 'w-fit max-w-[150px] bg-transparent p-1' : 'w-full',
          )}
          onClick={() => onOpenMedia?.(mediaItem)}
        >
          <img
            src={src}
            alt={attachment?.name || getAttachmentDisplayLabel(attachment)}
            className={cn(isSticker ? 'max-h-32 max-w-[140px] object-contain' : 'max-h-72 w-full object-contain')}
            onError={() => setFailed(true)}
            loading="lazy"
          />
        </button>
        )}
      </LazyMedia>
    );
  }

  if (attachmentType === 'video') {
    return (
      <LazyMedia
        className="mt-2"
        loadOnInteraction
        sourceUrl={attachmentUrl}
        resolveSource={resolveMediaSource}
        placeholder={({ activate }) => (
          <button
            type="button"
            className="flex h-36 w-full items-center justify-center rounded-xl border border-black/5 bg-black/10 text-xs font-medium"
            onClick={activate}
          >
            Carregar video
          </button>
        )}
      >
        {({ src }) => (
        <button
          type="button"
          className="relative block w-full overflow-hidden rounded-xl border border-black/5 bg-black/10"
          onClick={() => onOpenMedia?.(mediaItem)}
        >
          <video
            preload="metadata"
            muted
            playsInline
            className="max-h-72 w-full object-cover"
            onError={() => setFailed(true)}
          >
            <source src={src} type={attachment?.mimeType || 'video/mp4'} />
          </video>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/12">
            <div className="rounded-full bg-black/45 px-3 py-1.5 text-xs font-medium text-white">
              Abrir video
            </div>
          </div>
        </button>
        )}
      </LazyMedia>
    );
  }

  if (attachmentType === 'audio') {
    return (
      <LazyMedia
        className="mt-2"
        loadOnInteraction
        sourceUrl={attachmentUrl}
        resolveSource={resolveMediaSource}
        placeholder={({ activate }) => (
          <button
            type="button"
            className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-black/10 bg-black/5 px-3 py-2 text-sm font-medium"
            onClick={activate}
          >
            <Headphones className="h-4 w-4" />
            Carregar audio
          </button>
        )}
      >
        {({ src }) => (
        <>
        <AudioMessagePlayer
          src={src}
          mimeType={attachment?.mimeType || 'audio/ogg'}
          className=""
          avatarSrc={mediaItem?.avatarUrl || ''}
          avatarName={mediaItem?.senderName || 'Contato'}
          onError={() => setFailed(true)}
        />
        <AudioTranscriptionPanel
          transcription={transcription}
          isActive={isTranscribing}
          onTranscribe={onTranscribeAudio}
          isAgent={isAgent}
        />
        </>
        )}
      </LazyMedia>
    );
  }

  const openDocument = async () => {
    if (documentLoading) return;
    setDocumentError('');
    setDocumentLoading(true);
    try {
      const url = attachmentUrl || await fetchChatMediaUrl(mediaId, 'original');
      if (!url) throw new Error('URL do documento indisponível.');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setDocumentError(error?.message || 'Não foi possível abrir o documento.');
    } finally {
      setDocumentLoading(false);
    }
  };
  const size = Number(attachment?.size || 0);
  const sizeLabel = size > 0 ? `${(size / (size >= 1048576 ? 1048576 : 1024)).toFixed(1)} ${size >= 1048576 ? 'MB' : 'KB'}` : '';
  return (
    <button
      type="button"
      onClick={openDocument}
      disabled={documentLoading}
      className="mt-2 flex w-full items-center gap-2 rounded-xl border border-black/10 bg-black/5 px-3 py-2 text-left text-sm disabled:opacity-70"
    >
      <FileText className="w-4 h-4" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{attachment?.name || 'Documento'}</span>
        <span className="block truncate text-[10px] opacity-65">{documentError || [attachment?.mimeType, sizeLabel].filter(Boolean).join(' · ')}</span>
      </span>
      {documentLoading ? <LoaderCircle className="ml-auto h-3.5 w-3.5 flex-shrink-0 animate-spin" /> : <ExternalLink className="ml-auto h-3.5 w-3.5 flex-shrink-0" />}
    </button>
  );
}

function UploadState({ message, isAgent, onRetry }) {
  if (message.status !== 'uploading' && message.status !== 'failed') return null;

  if (message.status === 'failed') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <div
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-medium',
            isAgent ? 'text-primary-foreground/85' : 'text-destructive'
          )}
        >
          <AlertCircle className="w-3.5 h-3.5" />
          <span>Falha no envio</span>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
              isAgent
                ? 'border-primary-foreground/25 text-primary-foreground/90 hover:bg-primary-foreground/10'
                : 'border-border text-foreground hover:bg-muted'
            )}
          >
            <RotateCcw className="h-3 w-3" />
            Reenviar
          </button>
        ) : null}
      </div>
    );
  }

  const progress = Math.max(0, Math.min(100, Number(message.upload_progress || 0)));
  return (
    <div className="mt-2 space-y-1.5">
      <div
        className={cn(
          'text-[11px] font-medium',
          isAgent ? 'text-primary-foreground/80' : 'text-muted-foreground'
        )}
      >
        Enviando midia... {progress}%
      </div>
      <div className={cn('h-1.5 rounded-full overflow-hidden', isAgent ? 'bg-primary-foreground/20' : 'bg-muted')}>
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            isAgent ? 'bg-primary-foreground/80' : 'bg-primary'
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function TemplateButtons({ buttons, isAgent }) {
  const safeButtons = Array.isArray(buttons) ? buttons.filter((button) => button?.label || button?.text) : [];
  if (!safeButtons.length) return null;

  return (
    <div className={cn('mt-2 overflow-hidden rounded-xl border', isAgent ? 'border-primary-foreground/15 bg-primary-foreground/8' : 'border-border bg-muted/45')}>
      {safeButtons.map((button, index) => (
        <div
          key={button.id || `${button.label || button.text}-${index}`}
          className={cn(
            'flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium',
            isAgent ? 'text-primary-foreground' : 'text-primary',
            index !== safeButtons.length - 1 && (isAgent ? 'border-b border-primary-foreground/15' : 'border-b border-border'),
          )}
        >
          <ExternalLink className="h-3.5 w-3.5 opacity-75" />
          <span className="truncate">{button.label || button.text || 'Botão'}</span>
        </div>
      ))}
    </div>
  );
}

function resolveTemplateButtonUrl(button) {
  const url = String(button?.url || button?.href || button?.link || '').trim();
  if (/^https?:\/\//i.test(url)) return url;

  const value = String(button?.value || button?.token || '').trim();
  if (!value || /^https?:\/\//i.test(value)) return value;
  if (!/^[A-Za-z0-9_-]{12,}$/.test(value)) return '';

  return `${CHECKOUT_PUBLIC_URL}?token=${encodeURIComponent(value)}`;
}

function AgentTemplateButtons({ buttons, isAgent }) {
  const safeButtons = Array.isArray(buttons) ? buttons.filter((button) => button?.label || button?.text) : [];
  if (!safeButtons.length) return null;
  if (!safeButtons.some((button) => resolveTemplateButtonUrl(button))) {
    return <TemplateButtons buttons={safeButtons} isAgent={isAgent} />;
  }

  return (
    <div className={cn('mt-2 overflow-hidden rounded-xl border', isAgent ? 'border-primary-foreground/15 bg-primary-foreground/8' : 'border-border bg-muted/45')}>
      {safeButtons.map((button, index) => {
        const label = button.label || button.text || 'Botao';
        const buttonUrl = resolveTemplateButtonUrl(button);
        const className = cn(
          'flex w-full items-center justify-center gap-2 px-3 py-2 text-xs font-medium transition-colors',
          isAgent ? 'text-primary-foreground hover:bg-primary-foreground/10' : 'text-primary hover:bg-primary/10',
          index !== safeButtons.length - 1 && (isAgent ? 'border-b border-primary-foreground/15' : 'border-b border-border'),
        );

        if (buttonUrl) {
          return (
            <a
              key={button.id || `${label}-${index}`}
              href={buttonUrl}
              target="_blank"
              rel="noreferrer"
              className={className}
              title="Abrir checkout"
            >
              <ExternalLink className="h-3.5 w-3.5 opacity-75" />
              <span className="truncate">{label}</span>
            </a>
          );
        }

        return (
          <div key={button.id || `${label}-${index}`} className={className}>
            <ExternalLink className="h-3.5 w-3.5 opacity-75" />
            <span className="truncate">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function resolveVisibleTemplateButtons(message) {
  const storedButtons = Array.isArray(message?.template_buttons) && message.template_buttons.length > 0
    ? message.template_buttons
    : Array.isArray(message?.templateButtons) && message.templateButtons.length > 0
      ? message.templateButtons
      : [];
  if (storedButtons.length > 0) return storedButtons;

  const content = String(message?.content || '');
  const linkMatch = content.match(/(?:^|\n)Link botao:\s*(https?:\/\/\S+)/i);
  if (!linkMatch?.[1]) return [];
  return [
    {
      id: 'template-link-from-content',
      label: 'Abrir checkout',
      text: 'Abrir checkout',
      url: linkMatch[1],
      agentOnly: true,
    },
  ];
}

function ReactionMenu({
  isOpen,
  position,
  placement,
  maxWidth,
  currentReaction,
  onSelectReaction,
  onPlusClick,
  onMouseEnter,
  onMouseLeave,
  menuRef,
}) {
  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      className={cn(
        'fixed z-40 transition-all duration-150 ease-out animate-in fade-in-0 zoom-in-95',
        placement === 'below' ? 'origin-top slide-in-from-top-2' : 'origin-bottom slide-in-from-bottom-2'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        maxWidth: maxWidth ? `${maxWidth}px` : undefined,
      }}
    >
      <div className="rounded-full border border-white/10 bg-[#202c33] px-2 py-1 text-white shadow-[0_10px_30px_rgba(0,0,0,0.32)]">
        <div className="flex items-center gap-1 sm:gap-1.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => onSelectReaction(emoji)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full text-[20px] transition-colors hover:bg-white/10 sm:h-9 sm:w-9 sm:text-[22px]',
                currentReaction === emoji && 'bg-white/10'
              )}
              title={`Reagir com ${emoji}`}
            >
              {emoji}
            </button>
          ))}

          <div className="mx-0.5 h-5 w-px bg-white/12" />

          <button
            onClick={onPlusClick}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-white/10 sm:h-9 sm:w-9"
            title="Mais reacoes"
          >
            <Plus className="h-4 w-4 text-white/80" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageReactionBadge({ isAgent, reactions, onClick, badgeRef }) {
  const emojiList = reactions.map((reaction) => reaction.emoji);
  const totalCount = reactions.reduce((sum, reaction) => sum + reaction.count, 0);
  const shouldShowCount = totalCount > 1;

  return (
    <button
      ref={badgeRef}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-md',
        isAgent
          ? 'bg-[#111b21] border-white/10 text-white'
          : 'bg-white border-black/10 text-slate-700'
      )}
      title="Editar reacao"
    >
      <span className="flex items-center gap-0.5">
        {emojiList.slice(0, shouldShowCount ? 2 : 1).map((emoji) => (
          <span key={emoji}>{emoji}</span>
        ))}
      </span>
      {shouldShowCount ? <span>{totalCount}</span> : null}
    </button>
  );
}

function MessageContextMenu({ isOpen, position, maxWidth, items, menuRef, onClose }) {
  if (!isOpen) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className="fixed z-50 min-w-52 overflow-hidden rounded-xl border border-white/10 bg-[#202c33] py-1 text-white shadow-[0_16px_40px_rgba(0,0,0,0.38)] outline-none"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        maxWidth: maxWidth ? `${maxWidth}px` : undefined,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none"
          onClick={item.onSelect}
        >
          <item.icon className="h-4 w-4 text-white/80" />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function ChatMessage({
  message,
  contactAvatarUrl,
  contactName,
  currentUserName,
  onReply,
  onReact,
  onRetry,
  onInfo,
  onOpenMedia,
  onStartConversation,
  onTranscribeAudio,
  isTranscribingAudio,
}) {
  const [failedReactionFallback, setFailedReactionFallback] = useState('');
  const [isHovered, setIsHovered] = useState(false);
  const [isReactionMenuOpen, setIsReactionMenuOpen] = useState(false);
  const [reactionMenuPosition, setReactionMenuPosition] = useState({ top: -9999, left: -9999 });
  const [reactionMenuPlacement, setReactionMenuPlacement] = useState('above');
  const [reactionMenuMaxWidth, setReactionMenuMaxWidth] = useState(null);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [contextMenuAnchor, setContextMenuAnchor] = useState({ x: 0, y: 0 });
  const [contextMenuPosition, setContextMenuPosition] = useState({ top: -9999, left: -9999 });
  const [contextMenuMaxWidth, setContextMenuMaxWidth] = useState(null);
  const [contextMenuFocusIndex, setContextMenuFocusIndex] = useState(0);
  const containerRef = useRef(null);
  const bubbleRef = useRef(null);
  const reactionTriggerRef = useRef(null);
  const reactionBadgeRef = useRef(null);
  const reactionMenuRef = useRef(null);
  const contextMenuRef = useRef(null);
  const closeReactionMenuTimeoutRef = useRef(null);

  const isAgent = message.sender_type === 'agent';
  const isSystem = message.sender_type === 'system';
  const normalizedSenderName = resolveAgentSenderName(message);
  const isBotMessage = Boolean(message.is_bot_message);
  const botOriginLabel = (() => {
    const origin = String(message.origin || message.raw?.origin || '').trim().toLowerCase();
    if (origin === 'routine' || origin === 'routine-dispatch') return 'Bot de rotina';
    if (origin === 'chatbot' || origin === 'flow') return 'Bot de atendimento';
    if (origin === 'scheduled-message') return 'Bot agendado';
    if (origin === 'label-campaign' || origin === 'campaign-dispatch') return 'Bot de campanha';
    return 'Bot';
  })();
  const shouldShowAgentName =
    isAgent &&
    normalizedSenderName &&
    !isGenericAgentSenderName(normalizedSenderName) &&
    !isBotMessage;
  const shouldHideTextContent = isDecorativeMediaLabel(message.content, message.attachments);
  const replyPreview = resolveReplyPreview(
    message,
    isAgent ? contactName || 'Cliente' : 'Agente',
    isAgent
  );
  const reactionGroups = aggregateReactions(message.reactions);
  const agentReaction =
    (Array.isArray(message.reactions) ? message.reactions : []).find((reaction) => reaction.from === 'agent')
      ?.emoji || failedReactionFallback;
  const contextMenuItems = useMemo(
    () => [
      {
        key: 'reply',
        label: 'Responder',
        icon: Reply,
        onSelect: () => {
          setIsContextMenuOpen(false);
          onReply?.(message);
        },
      },
      {
        key: 'react',
        label: 'Reagir',
        icon: SmilePlus,
        onSelect: () => {
          setIsContextMenuOpen(false);
          setIsReactionMenuOpen(true);
        },
      },
      {
        key: 'info',
        label: 'Informacoes',
        icon: Info,
        onSelect: () => {
          setIsContextMenuOpen(false);
          onInfo?.(message);
        },
      },
    ],
    [message, onInfo, onReply]
  );

  const clearReactionMenuCloseTimeout = () => {
    if (closeReactionMenuTimeoutRef.current) {
      window.clearTimeout(closeReactionMenuTimeoutRef.current);
      closeReactionMenuTimeoutRef.current = null;
    }
  };

  const scheduleReactionMenuClose = () => {
    clearReactionMenuCloseTimeout();
    closeReactionMenuTimeoutRef.current = window.setTimeout(() => {
      setIsReactionMenuOpen(false);
    }, REACTION_MENU_CLOSE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!isReactionMenuOpen || !bubbleRef.current || !reactionMenuRef.current || typeof window === 'undefined') {
      return undefined;
    }

    const updateReactionMenuPosition = () => {
      if (!bubbleRef.current || !reactionMenuRef.current) return;

      const bubbleRect = bubbleRef.current.getBoundingClientRect();
      const triggerRect = reactionTriggerRef.current?.getBoundingClientRect() || null;
      const badgeRect = reactionBadgeRef.current?.getBoundingClientRect() || null;
      const menuRect = reactionMenuRef.current.getBoundingClientRect();
      const boundaryElement = findOverlayBoundary(bubbleRef.current);
      const boundaryRect =
        boundaryElement?.getBoundingClientRect() || {
          top: REACTION_MENU_VIEWPORT_PADDING_PX,
          right: window.innerWidth - REACTION_MENU_VIEWPORT_PADDING_PX,
          bottom: window.innerHeight - REACTION_MENU_VIEWPORT_PADDING_PX,
          left: REACTION_MENU_VIEWPORT_PADDING_PX,
          width: window.innerWidth - REACTION_MENU_VIEWPORT_PADDING_PX * 2,
          height: window.innerHeight - REACTION_MENU_VIEWPORT_PADDING_PX * 2,
        };

      const nextMaxWidth = Math.max(220, boundaryRect.width - REACTION_MENU_VIEWPORT_PADDING_PX * 2);
      const anchorRect = triggerRect
        ? {
            ...bubbleRect,
            top: triggerRect.top,
            bottom: triggerRect.bottom,
            height: triggerRect.height,
          }
        : badgeRect || bubbleRect;
      const { top: nextTop, left: nextLeft, placement: nextPlacement } = resolveFloatingOverlayPosition({
        anchorRect,
        overlayRect: menuRect,
        boundaryRect,
        gap: REACTION_MENU_GAP_PX,
        padding: REACTION_MENU_VIEWPORT_PADDING_PX,
      });

      setReactionMenuMaxWidth((currentWidth) =>
        currentWidth === nextMaxWidth ? currentWidth : nextMaxWidth
      );

      setReactionMenuPosition((currentPosition) => {
        if (currentPosition.top === nextTop && currentPosition.left === nextLeft) {
          return currentPosition;
        }

        return { top: nextTop, left: nextLeft };
      });
      setReactionMenuPlacement((currentPlacement) =>
        currentPlacement === nextPlacement ? currentPlacement : nextPlacement
      );
    };

    updateReactionMenuPosition();

    window.addEventListener('resize', updateReactionMenuPosition);
    window.addEventListener('scroll', updateReactionMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateReactionMenuPosition);
      window.removeEventListener('scroll', updateReactionMenuPosition, true);
    };
  }, [isReactionMenuOpen]);

  useLayoutEffect(() => {
    if (!isContextMenuOpen || !contextMenuRef.current || !bubbleRef.current || typeof window === 'undefined') {
      return undefined;
    }

    const updateContextMenuPosition = () => {
      if (!contextMenuRef.current || !bubbleRef.current) return;

      const menuRect = contextMenuRef.current.getBoundingClientRect();
      const boundaryElement = findOverlayBoundary(bubbleRef.current);
      const boundaryRect =
        boundaryElement?.getBoundingClientRect() || {
          top: CONTEXT_MENU_VIEWPORT_PADDING_PX,
          right: window.innerWidth - CONTEXT_MENU_VIEWPORT_PADDING_PX,
          bottom: window.innerHeight - CONTEXT_MENU_VIEWPORT_PADDING_PX,
          left: CONTEXT_MENU_VIEWPORT_PADDING_PX,
          width: window.innerWidth - CONTEXT_MENU_VIEWPORT_PADDING_PX * 2,
          height: window.innerHeight - CONTEXT_MENU_VIEWPORT_PADDING_PX * 2,
        };

      const nextMaxWidth = Math.max(180, boundaryRect.width - CONTEXT_MENU_VIEWPORT_PADDING_PX * 2);
      const nextPosition = resolveContextMenuPosition({
        point: contextMenuAnchor,
        overlayRect: menuRect,
        boundaryRect,
      });

      setContextMenuMaxWidth((currentValue) => (currentValue === nextMaxWidth ? currentValue : nextMaxWidth));
      setContextMenuPosition((currentValue) =>
        currentValue.top === nextPosition.top && currentValue.left === nextPosition.left
          ? currentValue
          : nextPosition
      );
    };

    updateContextMenuPosition();

    window.addEventListener('resize', updateContextMenuPosition);
    window.addEventListener('scroll', updateContextMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateContextMenuPosition);
      window.removeEventListener('scroll', updateContextMenuPosition, true);
    };
  }, [contextMenuAnchor, isContextMenuOpen]);

  useEffect(() => {
    if (!isReactionMenuOpen && !isContextMenuOpen) return undefined;

    const handlePointerDown = (event) => {
      if (
        !containerRef.current?.contains(event.target) &&
        !reactionMenuRef.current?.contains(event.target) &&
        !contextMenuRef.current?.contains(event.target)
      ) {
        setIsReactionMenuOpen(false);
        setIsContextMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isContextMenuOpen, isReactionMenuOpen]);

  useEffect(() => () => clearReactionMenuCloseTimeout(), []);

  useEffect(() => {
    if (!isReactionMenuOpen || typeof window === 'undefined') return undefined;

    const handlePointerMove = (event) => {
      const point = { x: event.clientX, y: event.clientY };
      const bubbleRect = bubbleRef.current?.getBoundingClientRect() || null;
      const triggerRect = reactionTriggerRef.current?.getBoundingClientRect() || null;
      const badgeRect = reactionBadgeRef.current?.getBoundingClientRect() || null;
      const menuRect = reactionMenuRef.current?.getBoundingClientRect() || null;
      const activeZoneRect = buildRectsUnion([bubbleRect, triggerRect, badgeRect, menuRect]);

      const isInsideReactionZone = isPointInsideRect(point, activeZoneRect, REACTION_ACTIVE_ZONE_PADDING_PX);

      if (isInsideReactionZone) {
        clearReactionMenuCloseTimeout();
        return;
      }

      scheduleReactionMenuClose();
    };

    window.addEventListener('mousemove', handlePointerMove);
    return () => window.removeEventListener('mousemove', handlePointerMove);
  }, [isReactionMenuOpen]);

  useEffect(() => {
    if (!isContextMenuOpen || !contextMenuRef.current) return;
    contextMenuRef.current.focus();
  }, [isContextMenuOpen]);

  useEffect(() => {
    if (!isContextMenuOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setContextMenuFocusIndex((currentValue) => (currentValue + 1) % contextMenuItems.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setContextMenuFocusIndex((currentValue) =>
          currentValue === 0 ? contextMenuItems.length - 1 : currentValue - 1
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        contextMenuItems[contextMenuFocusIndex]?.onSelect?.();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setIsContextMenuOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [contextMenuFocusIndex, contextMenuItems, isContextMenuOpen]);

  useEffect(() => {
    if (!isContextMenuOpen || !contextMenuRef.current) return;
    const nextItem = contextMenuRef.current.querySelectorAll('[role="menuitem"]')[contextMenuFocusIndex];
    nextItem?.focus();
  }, [contextMenuFocusIndex, isContextMenuOpen]);

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <span className="text-[11px] text-muted-foreground bg-muted/80 px-4 py-1.5 rounded-full shadow-sm">
          {message.content}
        </span>
      </div>
    );
  }

  const time = message.created_date ? format(new Date(message.created_date), 'HH:mm') : '';

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex group',
        isAgent ? 'justify-end' : 'justify-start',
        reactionGroups.length > 0 ? 'mb-3' : 'mb-2',
        (reactionGroups.length > 0 || isReactionMenuOpen) && 'relative z-20'
      )}
      onMouseEnter={() => {
        clearReactionMenuCloseTimeout();
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
      }}
    >
      {!isAgent && (
        <ContactAvatar
          src={message.avatar_url}
          name={message.sender_name || 'Contato'}
          className="w-7 h-7 flex-shrink-0 mt-auto mr-1.5 mb-1"
          fallbackClassName="from-primary/30 to-primary/60"
          textClassName="text-[10px]"
        />
      )}

      <div className={cn('flex items-end gap-1.5 max-w-[72%]', isAgent && 'flex-row-reverse')}>
        <div className="relative">
          <MessageContextMenu
            isOpen={isContextMenuOpen}
            position={contextMenuPosition}
            maxWidth={contextMenuMaxWidth}
            items={contextMenuItems}
            menuRef={contextMenuRef}
            onClose={() => setIsContextMenuOpen(false)}
          />

          <ReactionMenu
            isOpen={isReactionMenuOpen}
            position={reactionMenuPosition}
            placement={reactionMenuPlacement}
            maxWidth={reactionMenuMaxWidth}
            currentReaction={agentReaction}
            onMouseEnter={clearReactionMenuCloseTimeout}
            onMouseLeave={scheduleReactionMenuClose}
            menuRef={reactionMenuRef}
            onSelectReaction={(emoji) => {
              clearReactionMenuCloseTimeout();
              setIsReactionMenuOpen(false);
              setFailedReactionFallback('');
              onReact?.(message, emoji);
            }}
            onPlusClick={() => {
              setFailedReactionFallback(agentReaction || QUICK_REACTIONS[0]);
            }}
          />

          {isHovered && !isReactionMenuOpen && !isContextMenuOpen && onReact ? (
            <button
              ref={reactionTriggerRef}
              onClick={() => setIsReactionMenuOpen((currentValue) => !currentValue)}
              className={cn(
                'absolute z-20 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full border border-border bg-background shadow-sm hover:bg-muted flex items-center justify-center transition-all',
                isAgent ? 'left-0 -translate-x-[calc(100%+8px)]' : 'right-0 translate-x-[calc(100%+8px)]'
              )}
              title="Reagir"
            >
              <SmilePlus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          ) : null}

          <div className="space-y-1">
            {isBotMessage ? (
              <div className="flex justify-end px-1">
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Bot className="h-3.5 w-3.5" />
                  {botOriginLabel}
                </span>
              </div>
            ) : null}
            {shouldShowAgentName ? (
              <p className="px-1 text-[11px] font-medium text-muted-foreground">
                {normalizedSenderName}
              </p>
            ) : null}

            <div
              ref={bubbleRef}
              data-chat-selection-surface="true"
              className={cn(
                'rounded-2xl px-3.5 py-2 relative shadow-sm select-text',
                isAgent
                  ? 'chat-message-sent text-primary-foreground rounded-tr-sm'
                  : 'chat-message-received border border-border/60 text-foreground rounded-tl-sm'
              )}
              onDoubleClick={() => {
                if (isSystem) return;
                onReply?.(message);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                clearReactionMenuCloseTimeout();
                setIsReactionMenuOpen(false);
                setContextMenuFocusIndex(0);
                setContextMenuAnchor({ x: event.clientX, y: event.clientY });
                setIsContextMenuOpen(true);
              }}
            >
              {(message.reply_to || message.reply_preview) && (
              <div
                data-chat-selection-surface="true"
                className={cn(
                  'mb-2 rounded-2xl border px-3 py-2 select-text',
                  isAgent
                    ? 'border-primary-foreground/14 bg-black/12 text-primary-foreground'
                    : 'border-border/70 bg-muted/70 text-foreground'
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={cn('mt-0.5 h-10 w-1 rounded-full', isAgent ? 'bg-[#ff5ca8]' : 'bg-primary')} />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'truncate text-xs font-semibold select-text',
                        isAgent ? 'text-[#ff77b8]' : 'text-primary'
                      )}
                    >
                      {replyPreview.senderName}
                    </p>
                    <div
                      className={cn(
                        'mt-0.5 flex items-center gap-1.5 text-sm leading-tight select-text',
                        isAgent ? 'text-primary-foreground/88' : 'text-muted-foreground'
                      )}
                    >
                      {replyPreview.kind === 'audio' ? <Headphones className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                      <span className="truncate">{replyPreview.text}</span>
                    </div>
                  </div>
                </div>
              </div>
              )}

              {Array.isArray(message.attachments) && message.attachments.length > 0 && (
              <div className="space-y-2">
                {message.attachments.map((attachment, index) => (
                  <AttachmentPreview
                    key={`${message.id}-attachment-${index}`}
                    attachment={attachment}
                    mediaItem={{
                      id: `${message.id}-attachment-${index}`,
                      url: String(attachment?.url || '').trim(),
                      name: attachment?.name || message.content || 'Midia',
                      mimeType: attachment?.mimeType || '',
                      kind: resolveAttachmentKind(attachment) || 'image',
                      caption: message.content || '',
                      createdDate: message.created_date || message.timestamp || '',
                      senderName: message.sender_name || contactName || '',
                      avatarUrl: message.sender_type === 'client' ? contactAvatarUrl || '' : '',
                      onStartConversation,
                    }}
                    onOpenMedia={onOpenMedia}
                    transcription={message.transcription}
                    isTranscribing={Boolean(isTranscribingAudio)}
                    onTranscribeAudio={() => onTranscribeAudio?.(message)}
                    isAgent={isAgent}
                  />
                ))}
              </div>
              )}

              {message.content && !shouldHideTextContent && (
              <p
                data-chat-selection-surface="true"
                className="text-sm leading-relaxed whitespace-pre-wrap break-words select-text"
              >
                {message.content}
              </p>
              )}

              <AgentTemplateButtons buttons={resolveVisibleTemplateButtons(message)} isAgent={isAgent} />

              <UploadState message={message} isAgent={isAgent} onRetry={() => onRetry?.(message)} />

              <div
                className={cn(
                  'flex items-center justify-end gap-1 mt-1',
                  isAgent ? 'text-primary-foreground/50' : 'text-muted-foreground'
                )}
              >
                <span className="text-[10px]">{time}</span>
                {isAgent &&
                  (message.status === 'pending' ? (
                    <LoaderCircle className="w-3.5 h-3.5 opacity-70 animate-spin" />
                  ) : message.status === 'uploading' ? (
                    <LoaderCircle className="w-3.5 h-3.5 opacity-80 animate-spin" />
                  ) : message.status === 'failed' ? (
                    <AlertCircle className="w-3.5 h-3.5 text-red-200" />
                  ) : message.status === 'read' ? (
                    <CheckCheck className="w-3.5 h-3.5 text-blue-300" />
                  ) : message.status === 'delivered' ? (
                    <CheckCheck className="w-3.5 h-3.5 opacity-60" />
                  ) : message.status === 'sent' ? (
                    <Check className="w-3.5 h-3.5 opacity-60" />
                  ) : (
                    <Check className="w-3.5 h-3.5 opacity-60" />
                  ))}
              </div>

            </div>
          </div>

          {reactionGroups.length > 0 && (
            <div className="mt-1 flex justify-center">
              <MessageReactionBadge
                badgeRef={reactionBadgeRef}
                isAgent={isAgent}
                reactions={reactionGroups}
                onClick={() => {
                  setFailedReactionFallback('');
                  setIsContextMenuOpen(false);
                  setIsReactionMenuOpen(true);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
