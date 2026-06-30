import React, { useEffect, useMemo, useRef, useState } from 'react';
import '@fortawesome/fontawesome-free/css/all.min.css';
import {
  FileText,
  Headphones,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Pause,
  Plus,
  Send,
  Sparkles,
  Ticket,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { inferWhatsappMediaKind, validateWhatsappMediaFile } from '@/lib/whatsapp-media';
import AudioMessagePlayer from './AudioMessagePlayer';
import QuickReplyPicker from './QuickReplyPicker';
import TemplatePicker from './TemplatePicker';

const RECORDING_BAR_COUNT = 30;

const formatRecordingDuration = (seconds) => {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};

const buildRecordingBars = (source, count = RECORDING_BAR_COUNT) => {
  if (!source || source.length === 0) {
    return Array.from({ length: count }, () => 0.2);
  }

  const bars = [];
  const step = Math.max(1, Math.floor(source.length / count));

  for (let index = 0; index < count; index += 1) {
    const start = index * step;
    const end = Math.min(source.length, start + step);
    let sum = 0;
    let samples = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      sum += source[sampleIndex];
      samples += 1;
    }

    bars.push(Math.max(0.18, Math.min(1, samples > 0 ? sum / samples : 0.2)));
  }

  return bars;
};

const resolveQuickReplyCommand = (text, cursorIndex) => {
  const safeText = String(text || '');
  const safeCursor = Math.max(0, Math.min(Number.isFinite(cursorIndex) ? cursorIndex : safeText.length, safeText.length));

  let start = safeCursor;
  while (start > 0 && !/\s/.test(safeText[start - 1])) {
    start -= 1;
  }

  const token = safeText.slice(start, safeCursor);
  if (!token.startsWith('/')) {
    return null;
  }

  let end = safeCursor;
  while (end < safeText.length && !/\s/.test(safeText[end])) {
    end += 1;
  }

  return {
    start,
    end,
    query: token.slice(1),
  };
};

const chooseRecordingMimeType = () => {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
};

const createAudioPreviewPayload = (file) => ({
  file,
  url: URL.createObjectURL(file),
  mimetype: file.type || 'audio/ogg',
});

const AttachmentMenuItem = ({ icon: Icon, label, colorClassName, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/8"
  >
    <span className={cn('flex h-10 w-10 items-center justify-center rounded-full', colorClassName)}>
      <Icon className="h-4.5 w-4.5 text-white" />
    </span>
    <span>{label}</span>
  </button>
);

export default function MessageInput({
  value,
  onValueChange,
  onSendText,
  onSendAudio,
  onSendDocument,
  onSendVideo,
  onSendTemplate,
  onImageFiles,
  isPending,
  replyTo,
  onCancelReply,
  canSendFreeText = true,
  windowStatusLabel = '',
  templates = [],
  focusKey,
  onEscapeToConversationList,
  onOpenQuickReplies,
  onOpenTavinho,
  onOpenTicket,
  tavinhoOpen = false,
  ticketOpen = false,
  onOpenStartConversation,
}) {
  const [quickReplyCommand, setQuickReplyCommand] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [micSupported, setMicSupported] = useState(true);
  const [audioPreview, setAudioPreview] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingBars, setRecordingBars] = useState(() => buildRecordingBars());
  const textareaRef = useRef(null);
  const composerRef = useRef(null);
  const attachmentMenuRef = useRef(null);
  const mediaInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const recordingAnimationRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const recordingFinishModeRef = useRef('preview');
  const lastPointerDownTargetRef = useRef(null);

  const hasText = value.trim().length > 0;
  const shouldShowMicButton = canSendFreeText && !hasText && !audioPreview;
  const isQuickReplyPickerOpen = canSendFreeText && Boolean(quickReplyCommand);
  const openTemplateFlow = () => {
    if (onOpenStartConversation) {
      onOpenStartConversation();
      return;
    }
    setShowTemplatePicker(true);
  };

  const attachmentMenuItems = useMemo(
    () => [
      {
        label: 'Documento',
        icon: FileText,
        colorClassName: 'bg-sky-500',
        onClick: () => {
          setShowAttachmentMenu(false);
          documentInputRef.current?.click();
        },
      },
      {
        label: 'Fotos e vídeos',
        icon: ImageIcon,
        colorClassName: 'bg-emerald-500',
        onClick: () => {
          setShowAttachmentMenu(false);
          mediaInputRef.current?.click();
        },
      },
      {
        label: 'Áudio',
        icon: Headphones,
        colorClassName: 'bg-violet-500',
        onClick: () => {
          setShowAttachmentMenu(false);
          audioInputRef.current?.click();
        },
      },
    ],
    []
  );

  const closeQuickReplyPicker = () => {
    setQuickReplyCommand(null);
  };

  const syncQuickReplyState = (nextValue = value, cursorOverride) => {
    const textarea = textareaRef.current;
    const cursorPosition =
      Number.isFinite(cursorOverride) ? cursorOverride : textarea?.selectionStart ?? String(nextValue || '').length;
    const nextCommand = resolveQuickReplyCommand(nextValue, cursorPosition);
    setQuickReplyCommand(nextCommand);

  };

  useEffect(() => {
    setMicSupported(Boolean(navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'));
  }, []);

  useEffect(() => {
    if (canSendFreeText && !isRecording && !audioPreview) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [audioPreview, canSendFreeText, focusKey, isRecording]);

  useEffect(() => {
    if (!canSendFreeText || isRecording || audioPreview) return undefined;

    const focusTextarea = () => {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };

    const isSelectionSurface = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      return Boolean(element.closest('[data-chat-selection-surface="true"]'));
    };

    const isFocusableInput = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const tagName = element.tagName.toLowerCase();
      if (['input', 'textarea', 'select', 'button'].includes(tagName)) return true;
      return Boolean(element.closest('[role="dialog"], [role="menu"], [contenteditable="true"]'));
    };

    const handlePointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      lastPointerDownTargetRef.current = target;
      if (composerRef.current?.contains(target)) return;
      if (isFocusableInput(target)) return;
      if (isSelectionSurface(target)) return;
      focusTextarea();
    };

    const handleTextareaBlur = () => {
      const lastPointerTarget = lastPointerDownTargetRef.current;
      if (isSelectionSurface(lastPointerTarget)) return;
      if (isFocusableInput(lastPointerTarget)) return;

      const selection = window.getSelection?.();
      if (selection && String(selection).trim()) return;

      const activeElement = document.activeElement;
      if (composerRef.current?.contains(activeElement)) return;
      if (isFocusableInput(activeElement)) return;
      focusTextarea();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    const textarea = textareaRef.current;
    textarea?.addEventListener('blur', handleTextareaBlur);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      textarea?.removeEventListener('blur', handleTextareaBlur);
    };
  }, [audioPreview, canSendFreeText, focusKey, isRecording]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [value]);

  useEffect(() => {
    if (!showAttachmentMenu) return undefined;

    const handlePointerDown = (event) => {
      if (attachmentMenuRef.current?.contains(event.target)) return;
      setShowAttachmentMenu(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [showAttachmentMenu]);

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (isRecording) {
          event.preventDefault();
          void cancelRecording();
          return;
        }

        if (audioPreview) {
          event.preventDefault();
          clearAudioPreview();
          return;
        }

        if (showAttachmentMenu || isQuickReplyPickerOpen || showEmojiPicker || replyTo) {
          event.preventDefault();
          setShowAttachmentMenu(false);
          closeQuickReplyPicker();
          setShowEmojiPicker(false);
          if (replyTo && onCancelReply) {
            onCancelReply();
          }
          return;
        }

        if (onEscapeToConversationList) {
          event.preventDefault();
          onEscapeToConversationList();
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && audioPreview) {
        event.preventDefault();
        void handleSendAudioPreview();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [
    audioPreview,
    isQuickReplyPickerOpen,
    isRecording,
    onCancelReply,
    onEscapeToConversationList,
    replyTo,
    showAttachmentMenu,
    showEmojiPicker,
  ]);

  useEffect(
    () => () => {
      if (audioPreview?.url) {
        URL.revokeObjectURL(audioPreview.url);
      }
      cleanupRecordingResources();
    },
    [audioPreview]
  );

  const cleanupRecordingResources = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (recordingAnimationRef.current) {
      window.cancelAnimationFrame(recordingAnimationRef.current);
      recordingAnimationRef.current = null;
    }

    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
    }

    analyserRef.current = null;
    if (audioContextRef.current?.close) {
      void audioContextRef.current.close().catch(() => undefined);
    }
    audioContextRef.current = null;
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
  };

  const clearAudioPreview = () => {
    setAudioPreview((currentPreview) => {
      if (currentPreview?.url) {
        URL.revokeObjectURL(currentPreview.url);
      }
      return null;
    });
  };

  const resetRecordingVisualState = () => {
    setIsRecording(false);
    setRecordingSeconds(0);
    setRecordingBars(buildRecordingBars());
  };

  const handleSend = async () => {
    if (!value.trim() || !canSendFreeText) return;
    const nextContent = value.trim();

    onValueChange('');
    closeQuickReplyPicker();
    setShowEmojiPicker(false);
    setShowAttachmentMenu(false);

    try {
      await onSendText({
        content: nextContent,
        replyToMessage: replyTo || null,
      });
    } catch {
      onValueChange(nextContent);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  };

  const handleSendAudioPreview = async () => {
    if (!audioPreview?.file) return;
    const preview = audioPreview;
    clearAudioPreview();
    await onSendAudio?.({
      file: preview.file,
      mimetype: preview.mimetype,
      replyToMessage: replyTo || null,
    });
  };

  const openAudioPreview = (file) => {
    clearAudioPreview();
    setAudioPreview(createAudioPreviewPayload(file));
    setShowAttachmentMenu(false);
    closeQuickReplyPicker();
    setShowEmojiPicker(false);
  };

  const handleChange = (event) => {
    const nextValue = event.target.value;
    onValueChange(nextValue);
    syncQuickReplyState(nextValue, event.target.selectionStart);

    if (resolveQuickReplyCommand(nextValue, event.target.selectionStart)) {
      setShowEmojiPicker(false);
      setShowAttachmentMenu(false);
    }
  };

  const handleComposerKeyDown = async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      await handleSend();
    }

    if (event.key === 'Escape') {
      event.preventDefault();

      if (showAttachmentMenu || isQuickReplyPickerOpen || showEmojiPicker) {
        setShowAttachmentMenu(false);
          closeQuickReplyPicker();
        setShowEmojiPicker(false);
        return;
      }

      if (replyTo && onCancelReply) {
        onCancelReply();
        return;
      }

      if (onEscapeToConversationList) {
        onEscapeToConversationList();
      }
    }
  };

  const handleSelectQuickReply = (content) => {
    const textarea = textareaRef.current;
    const cursorStart = textarea?.selectionStart ?? value.length;
    const cursorEnd = textarea?.selectionEnd ?? value.length;
    const replacementStart = quickReplyCommand?.start ?? cursorStart;
    const replacementEnd = quickReplyCommand?.end ?? cursorEnd;
    const nextValue = `${value.slice(0, replacementStart)}${content}${value.slice(replacementEnd)}`;
    const nextCursorPosition = replacementStart + content.length;

    onValueChange(nextValue);
    closeQuickReplyPicker();

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
    });
  };

  const handleAppendFiles = async (files, source = 'mixed') => {
    if (!canSendFreeText) {
      toast.error('A janela de 24h está fechada. Use um template HSM para retomar o contato.');
      return;
    }

    const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];
    if (safeFiles.length === 0) return;

    const previewImages = [];

    for (const file of safeFiles) {
      const kind = inferWhatsappMediaKind(file);
      const validation = await validateWhatsappMediaFile(file);

      if (!validation.ok) {
        toast.error(validation.reason || 'Arquivo não suportado pela API do WhatsApp.');
        continue;
      }

      if (kind === 'image') {
        previewImages.push({
          file,
          url: URL.createObjectURL(file),
        });
        continue;
      }

      if (kind === 'audio') {
        if (source === 'audio' || safeFiles.length === 1) {
          openAudioPreview(file);
        } else {
          toast.message('Selecione um áudio por vez para ouvir antes de enviar.');
        }
        continue;
      }

      if (kind === 'document') {
        await onSendDocument?.({
          file,
          mimetype: file.type || 'application/octet-stream',
          filename: file.name || 'documento',
          replyToMessage: replyTo || null,
        });
        continue;
      }

      if (kind === 'video') {
        await onSendVideo?.({
          file,
          mimetype: file.type || 'video/mp4',
          filename: file.name || 'video.mp4',
          caption: '',
          replyToMessage: replyTo || null,
          previewUrl: URL.createObjectURL(file),
        });
        continue;
      }

      toast.error('Este tipo de arquivo ainda não está disponível neste fluxo.');
    }

    if (previewImages.length > 0) {
      onImageFiles?.(previewImages);
    }

    setShowAttachmentMenu(false);
    closeQuickReplyPicker();
    setShowEmojiPicker(false);
  };

  const handleChooseFile = async (event, source = 'mixed') => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await handleAppendFiles(files, source);
  };

  const handlePaste = async (event) => {
    const mediaFiles = Array.from(event.clipboardData?.files || []).filter(Boolean);
    if (mediaFiles.length === 0) return;

    const hasImage = mediaFiles.some((file) => inferWhatsappMediaKind(file) === 'image');
    if (!hasImage) return;

    event.preventDefault();
    await handleAppendFiles(mediaFiles, 'media');
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setIsDragActive(false);

    const files = Array.from(event.dataTransfer?.files || []).filter(Boolean);
    if (files.length === 0) return;

    await handleAppendFiles(files, 'mixed');
  };

  const finishRecording = (mode = 'preview') => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recordingFinishModeRef.current = mode;
    recorder.stop();
    setIsRecording(false);
  };

  const cancelRecording = async () => {
    recordingFinishModeRef.current = 'cancel';
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupRecordingResources();
    }
    resetRecordingVisualState();
  };

  const startRecordingBars = (stream) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    audioContextRef.current = context;
    analyserRef.current = analyser;

    const render = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);
      const normalized = Array.from(dataArray).map((sample) => sample / 255);
      setRecordingBars(buildRecordingBars(normalized));
      recordingAnimationRef.current = window.requestAnimationFrame(render);
    };

    render();
  };

  const startRecording = async () => {
    if (!canSendFreeText) return;
    if (!micSupported) {
      toast.error('Este dispositivo não disponibiliza gravação por microfone neste navegador.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingStartedAtRef.current = Date.now();
      recordingFinishModeRef.current = 'preview';
      setRecordingSeconds(0);
      setRecordingBars(buildRecordingBars());
      setIsRecording(true);
      setShowAttachmentMenu(false);
      closeQuickReplyPicker();
      setShowEmojiPicker(false);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const finishMode = recordingFinishModeRef.current || 'preview';
        recordingFinishModeRef.current = 'preview';
        const nextMimeType = recorder.mimeType || mimeType || 'audio/ogg';
        const audioParts = [...recordingChunksRef.current];
        cleanupRecordingResources();
        resetRecordingVisualState();

        if (finishMode === 'cancel' || audioParts.length === 0) {
          return;
        }

        const extension = nextMimeType.includes('mp4') ? 'm4a' : nextMimeType.includes('webm') ? 'webm' : 'ogg';
        const blob = new Blob(audioParts, { type: nextMimeType });
        const file = new File([blob], `gravacao-${Date.now()}.${extension}`, { type: nextMimeType });

        if (finishMode === 'send') {
          void onSendAudio?.({
            file,
            mimetype: nextMimeType,
            replyToMessage: replyTo || null,
          });
          return;
        }

        openAudioPreview(file);
      };

      recorder.start();
      startRecordingBars(stream);
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((Date.now() - recordingStartedAtRef.current) / 1000);
      }, 200);
    } catch (error) {
      setIsRecording(false);
      cleanupRecordingResources();
      const message =
        error?.name === 'NotAllowedError'
          ? 'Permita o uso do microfone nas configurações do navegador para gravar áudio.'
          : 'Não foi possível iniciar a gravação de áudio.';
      toast.error(message);
    }
  };

  const handleMicClick = async () => {
    if (isRecording) {
      finishRecording('preview');
      return;
    }

    await startRecording();
  };

  const handleSendRecordedAudio = () => {
    finishRecording('send');
  };

  const renderRecordingState = () => (
    <div className="chat-input-field flex w-full items-center gap-3 rounded-full px-3 py-2.5">
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground"
        onClick={() => void cancelRecording()}
        title="Cancelar gravação"
      >
        <Trash2 className="h-4.5 w-4.5" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inset-0 animate-ping rounded-full bg-red-500/60" />
            <span className="relative rounded-full bg-red-500" />
          </span>
          <span className="shrink-0 text-[1.05rem] font-semibold tabular-nums text-foreground">
            {formatRecordingDuration(recordingSeconds)}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden">
          {recordingBars.map((barValue, index) => (
            <span
              key={`recording-bar-${index}`}
              className="block w-[3px] rounded-full bg-muted-foreground/65"
              style={{ height: `${Math.max(8, Math.round(barValue * 24))}px` }}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary transition-colors hover:bg-primary/10 hover:text-primary"
        onClick={() => finishRecording('preview')}
        title="Parar e revisar"
      >
        <Pause className="h-4 w-4 fill-current" />
      </button>

      <button
        type="button"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
        onClick={handleSendRecordedAudio}
        title="Enviar áudio"
      >
        <Send className="h-4.5 w-4.5" />
      </button>
    </div>
  );

  const renderAudioPreviewState = () => (
    <div className="flex flex-1 items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onClick={clearAudioPreview}
      >
        <Trash2 className="h-4.5 w-4.5" />
      </Button>

      <AudioMessagePlayer
        src={audioPreview?.url || ''}
        mimeType={audioPreview?.mimetype || 'audio/ogg'}
        size="preview"
        showSpeed={false}
        className="min-w-0 flex-1"
      />

      <Button
        type="button"
        onClick={() => void handleSendAudioPreview()}
        size="icon"
        className="h-10 w-10 shrink-0 rounded-full bg-primary hover:bg-primary/90"
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="chat-input-shell flex-shrink-0">
      {replyTo && (
        <div className="chat-input-card flex items-center gap-3 border-b border-border px-4 py-2">
          <div className="h-8 w-0.5 flex-shrink-0 rounded-full bg-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-primary">Respondendo à mensagem</p>
            <p className="truncate text-xs text-muted-foreground">{replyTo.content}</p>
          </div>
          <button onClick={onCancelReply} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!canSendFreeText && (
        <div className="chat-input-card flex items-center justify-between gap-3 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700">
          <span>{windowStatusLabel || 'Fora da janela de 24h. Envie um template HSM.'}</span>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={openTemplateFlow}>
            <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            Escolher HSM
          </Button>
        </div>
      )}

      {isQuickReplyPickerOpen ? (
        <QuickReplyPicker filter={quickReplyCommand?.query || ''} onSelect={handleSelectQuickReply} />
      ) : null}

      <div
        ref={(element) => {
          composerRef.current = element;
          attachmentMenuRef.current = element;
        }}
        className={cn(
          'chat-input-card relative mx-3 mb-3 rounded-2xl px-3 py-2.5 shadow-lg transition-colors',
          isDragActive && 'ring-2 ring-primary bg-primary/5'
        )}
        onDragOver={(event) => {
          event.preventDefault();
          if (!canSendFreeText) return;
          setIsDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setIsDragActive(false);
        }}
        onDrop={(event) => void handleDrop(event)}
      >
        {showAttachmentMenu && canSendFreeText ? (
          <div className="absolute bottom-[calc(100%+10px)] left-0 z-40 w-72 rounded-3xl border border-white/10 bg-[#202c33] p-2.5 shadow-2xl animate-in fade-in-0 slide-in-from-bottom-2 zoom-in-95">
            {attachmentMenuItems.map((item) => (
              <AttachmentMenuItem key={item.label} {...item} />
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            ref={mediaInputRef}
            type="file"
            className="hidden"
            multiple
            accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,.jpg,.jpeg,.png,.webp,.mp4,.3gp"
            onChange={(event) => void handleChooseFile(event, 'media')}
          />
          <input
            ref={documentInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
            onChange={(event) => void handleChooseFile(event, 'document')}
          />
          <input
            ref={audioInputRef}
            type="file"
            className="hidden"
            accept="audio/*,.aac,.amr,.mp3,.m4a,.ogg"
            onChange={(event) => void handleChooseFile(event, 'audio')}
          />

          {isRecording ? (
            renderRecordingState()
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-9 w-9 shrink-0 rounded-full transition-colors',
                  showAttachmentMenu ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                title="Anexar"
                onClick={() => {
                  if (!canSendFreeText) return;
                  setShowAttachmentMenu((currentValue) => !currentValue);
                          setShowEmojiPicker(false);
                  closeQuickReplyPicker();
                }}
                disabled={!canSendFreeText}
              >
                {showAttachmentMenu ? <Plus className="h-5 w-5" /> : <Paperclip className="h-5 w-5" />}
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-9 w-9 rounded-full shrink-0 transition-colors',
                  isQuickReplyPickerOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setQuickReplyCommand(null);
                  setShowEmojiPicker(false);
                  setShowAttachmentMenu(false);
                          onOpenQuickReplies?.();
                }}
                title="Respostas rápidas"
                disabled={Boolean(audioPreview)}
              >
                <Zap className="h-5 w-5" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-9 w-9 rounded-full shrink-0 transition-colors',
                  ticketOpen ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setShowEmojiPicker(false);
                  setShowAttachmentMenu(false);
                  closeQuickReplyPicker();
                  onOpenTicket?.();
                }}
                title="Abrir ticket"
                disabled={Boolean(audioPreview)}
              >
                <Ticket className="h-5 w-5" />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-9 w-9 rounded-full shrink-0 transition-colors',
                  tavinhoOpen
                    ? 'bg-[#f8c400]/15 text-[#c99a00] hover:bg-[#f8c400]/20 dark:text-[#f8c400]'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setShowEmojiPicker(false);
                  setShowAttachmentMenu(false);
                  closeQuickReplyPicker();
                  onOpenTavinho?.();
                }}
                title="Tavinho - Copiloto da +TV"
                disabled={Boolean(audioPreview)}
              >
                <Sparkles className="h-5 w-5" />
              </Button>

              {!canSendFreeText ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground shrink-0"
                  onClick={openTemplateFlow}
                  title="Enviar HSM"
                >
                  <Wand2 className="h-5 w-5" />
                </Button>
              ) : null}

              {audioPreview ? (
                renderAudioPreviewState()
              ) : (
                <textarea
                  ref={textareaRef}
                  value={value}
                  onChange={handleChange}
                  onKeyDown={(event) => void handleComposerKeyDown(event)}
                  onKeyUp={() => syncQuickReplyState()}
                  onClick={() => syncQuickReplyState()}
                  onSelect={() => syncQuickReplyState()}
                  onPaste={(event) => void handlePaste(event)}
                  placeholder={
                    canSendFreeText ? 'Digite uma mensagem' : 'Cliente fora da janela de 24h. Use um template HSM.'
                  }
                  rows={1}
                  disabled={!canSendFreeText}
                  className={cn(
                    'chat-input-field min-h-[38px] max-h-[120px] w-full resize-none rounded-full border-0 px-4 py-2 text-sm',
                    'focus:outline-none focus:ring-1 focus:ring-ring',
                    'placeholder:text-muted-foreground leading-relaxed',
                    'flex-1',
                    !canSendFreeText && 'cursor-not-allowed opacity-70'
                  )}
                />
              )}

              {hasText && canSendFreeText && !audioPreview ? (
                <Button
                  onClick={() => void handleSend()}
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-full bg-primary hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                </Button>
              ) : shouldShowMicButton && micSupported ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full shrink-0 transition-colors text-muted-foreground hover:text-foreground"
                  onClick={() => void handleMicClick()}
                  disabled={!canSendFreeText}
                  title="Gravar áudio"
                >
                  <Mic className="h-5 w-5" />
                </Button>
              ) : null}
            </>
          )}
        </div>

      </div>

      <TemplatePicker
        open={showTemplatePicker}
        onOpenChange={setShowTemplatePicker}
        templates={templates}
        onSelect={async (template) => {
          await onSendTemplate(template);
          setShowTemplatePicker(false);
        }}
        isSending={isPending}
      />
    </div>
  );
}
