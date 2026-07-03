import React, { useDeferredValue } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { listQuickReplyCategories } from '@/lib/quick-reply-categories';
import { getQuickReplyPreviewText, listQuickReplies } from '@/lib/quick-replies';

export default function QuickReplyPicker({ filter, onSelect }) {
  const deferredFilter = useDeferredValue(String(filter || '').trim());
  const { data: replies = [] } = useQuery({
    queryKey: ['quick-replies', 'picker', deferredFilter],
    queryFn: () => listQuickReplies({ limit: 50, search: deferredFilter }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ['quick-reply-categories'],
    queryFn: () => listQuickReplyCategories(),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });
  const visibleCategoryIds = new Set(categories.filter((category) => category.visibleInQuickReplies !== false).map((category) => category.id));

  const filtered = replies.filter(r => !r.categoryId || visibleCategoryIds.has(r.categoryId));

  if (filtered.length === 0) return null;

  return (
    <div className="border-t border-border bg-card max-h-52 overflow-y-auto">
      <div className="px-4 py-2 flex items-center gap-1.5 border-b border-border/50">
        <Zap className="w-3.5 h-3.5 text-primary" />
        <span className="text-[11px] font-medium text-muted-foreground">Respostas rápidas</span>
      </div>
      {filtered.map(reply => (
        <button
          key={reply.id}
          onClick={() => onSelect(getQuickReplyPreviewText(reply))}
          className="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-muted transition-colors border-b border-border/30 last:border-0"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs font-semibold text-foreground">{reply.title}</span>
              {reply.shortcut && (
                <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-mono">
                  {reply.shortcut}
                </code>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{getQuickReplyPreviewText(reply)}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
