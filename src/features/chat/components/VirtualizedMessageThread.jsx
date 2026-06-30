import React, { useEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { useChatStore } from '../store/useChatStore';

const ChatScroller = React.forwardRef(function ChatScroller(props, ref) {
  return <div {...props} ref={ref} data-chat-overlay-boundary="true" />;
});

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

  useEffect(() => {
    const previousLength = previousLengthRef.current;
    if (items.length > previousLength && !isAtBottom) {
      const latestMessage = [...items].reverse().find((item) => item?.type !== 'separator')?.data;
      if (String(latestMessage?.sender_type || '').toLowerCase() === 'client') incrementNewMessageCount();
    }
    previousLengthRef.current = items.length;
  }, [incrementNewMessageCount, isAtBottom, items]);

  const handleAtBottomChange = (nextIsAtBottom) => {
    setIsAtBottom(nextIsAtBottom);
    if (stickToBottomRef) stickToBottomRef.current = nextIsAtBottom;
  };

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
        followOutput={(atBottom) => atBottom ? 'smooth' : false}
        atBottomStateChange={handleAtBottomChange}
        startReached={() => {
          if (hasOlderMessages && !isLoadingOlder) void onLoadOlder?.();
        }}
        increaseViewportBy={{ top: 500, bottom: 700 }}
        overscan={500}
        components={{
          Scroller: ChatScroller,
          Header: () => topContent,
          Footer: () => <div className="h-28" aria-hidden="true" />,
        }}
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
