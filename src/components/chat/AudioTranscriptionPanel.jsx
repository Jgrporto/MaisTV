import React from 'react';
import { AlertCircle, FileText, LoaderCircle, RotateCcw, Wand2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export default function AudioTranscriptionPanel({
  transcription,
  isActive = false,
  onTranscribe,
  isAgent = false,
}) {
  const status = transcription?.status || null;
  const text = String(transcription?.text || '').trim();
  const error = String(transcription?.error || '').trim();
  const isProcessing = Boolean(isActive);

  if (text) {
    return (
      <div
        className={cn(
          'mt-2 rounded-md border px-3 py-2 text-xs leading-relaxed',
          isAgent ? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground/90' : 'border-border bg-muted/60 text-foreground'
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <FileText className="h-3.5 w-3.5" />
          <span>Transcricao</span>
        </div>
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div
        className={cn(
          'mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium',
          isAgent ? 'border-primary-foreground/20 text-primary-foreground/85' : 'border-border text-muted-foreground'
        )}
      >
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Transcrevendo audio
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onTranscribe}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
          isAgent
            ? 'border-primary-foreground/25 text-primary-foreground/90 hover:bg-primary-foreground/10'
            : 'border-border bg-background text-foreground hover:bg-muted'
        )}
      >
        {status === 'failed' || status === 'processing' ? <RotateCcw className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />}
        {status === 'failed' || status === 'processing' ? 'Tentar novamente' : 'Transcrever audio'}
      </button>
      {error ? (
        <span className={cn('inline-flex items-center gap-1 text-xs', isAgent ? 'text-primary-foreground/75' : 'text-destructive')}>
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </span>
      ) : null}
    </div>
  );
}
