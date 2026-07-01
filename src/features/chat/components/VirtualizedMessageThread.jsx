import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { useChatStore } from '../store/useChatStore';

const ChatScroller = React.forwardRef(function ChatScroller({ context: _context, ...props }, ref) {
  return <div {...props} ref={ref} data-chat-overlay-boundary="true" />;
});

const ChatHeader = ({ context }) => context?.topContent || null;
const ChatFooter = () => <div className="h-28" aria-hidden="true" />;
const VIRTUOSO_COMPONENTS = Object.freeze({
  Scroller: ChatScroller,
  Header: ChatHeader,
  Footer: ChatFooter,
});

const resolveFollowOutput = (atBottom) => atBottom ? 'smooth' : false;

const resolveItemKey = (item, index) => {
  if (item?.type === 'separator') return `separator-${item.label}-${index}`;
  const message = item?.data || {};
  return message.client_message_id || message.provider_message_id || message.server_message_id || message.id || index;
};

export default function VirtualizedMessageThread({
  items,
  renderItem,
  onLoadOlder,
  hasOlderMessages,
  isLoadingOlder,
  topContent = null,
  scrollerRef,
  stickToBottomRef,
  className = '',
  style,
}) {
  const virtuosoRef = useRef(null);
  const previousLengthRef = useRef(items.length);
  const isAtBottom = useChatStore((state) => state.isAtBottom);
  const newMessageCount = useChatStore((state) => state.newMessageCount);
  const setIsAtBottom = useChatStore((state) => state.setIsAtBottom);
  const incrementNewMessageCount = useChatStore((state) => state.incrementNewMessageCount);
  const lastReportedAtBottomRef = useRef(isAtBottom);

  useEffect(() => {
    const previousLength = previousLengthRef.current;
    if (items.length > previousLength && !isAtBottom) {
      const latestMessage = [...items].reverse().find((item) => item?.type !== 'separator')?.data;
      if (String(latestMessage?.sender_type || '').toLowerCase() === 'client') incrementNewMessageCount();
    }
    previousLengthRef.current = items.length;
  }, [incrementNewMessageCount, isAtBottom, items]);

  useEffect(() => {
    lastReportedAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  const handleAtBottomChange = useCallback((nextIsAtBottom) => {
    const normalized = Boolean(nextIsAtBottom);
    if (lastReportedAtBottomRef.current !== normalized) {
      lastReportedAtBottomRef.current = normalized;
      setIsAtBottom(normalized);
    }
    if (stickToBottomRef) stickToBottomRef.current = normalized;
  }, [setIsAtBottom, stickToBottomRef]);

  const handleStartReached = useCallback(() => {
    if (hasOlderMessages && !isLoadingOlder) void onLoadOlder?.();
  }, [hasOlderMessages, isLoadingOlder, onLoadOlder]);

  const virtuosoContext = useMemo(() => ({ topContent }), [topContent]);

  const scrollToLatest = () => {
    virtuosoRef.current?.scrollToIndex({ index: Math.max(0, items.length - 1), align: 'end', behavior: 'smooth' });
    setIsAtBottom(true);
  };

  return (
    <div className="relative h-full min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={items}
        className={className}
        style={style}
        scrollerRef={scrollerRef}
        computeItemKey={(index, item) => resolveItemKey(item, index)}
        itemContent={(index, item) => renderItem(item, index)}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        followOutput={resolveFollowOutput}
        atBottomStateChange={handleAtBottomChange}
        startReached={handleStartReached}
        increaseViewportBy={{ top: 500, bottom: 700 }}
        overscan={500}
        context={virtuosoContext}
        components={VIRTUOSO_COMPONENTS}
      />
      {!isAtBottom && newMessageCount > 0 ? (
        <button
          type="button"
          onClick={scrollToLatest}
          className="absolute bottom-32 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {newMessageCount === 1 ? 'Nova mensagem' : `${newMessageCount} novas mensagens`}
        </button>
      ) : null}
    </div>
  );
}
