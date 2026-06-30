import React, { memo } from 'react';
import { Draggable, Droppable } from '@hello-pangea/dnd';
import { Filter, Search } from 'lucide-react';

import LabelBadge from '@/components/labels/LabelBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import KanbanLeadCard from './KanbanLeadCard';

function KanbanColumnComponent({
  label,
  totalCount,
  visibleCount,
  hasMore,
  conversations,
  filterState,
  onFilterStateChange,
  onLoadMore,
}) {
  const isSearching = Boolean(filterState?.searchOpen);
  const onlyUnread = Boolean(filterState?.onlyUnread);

  return (
    <section className="flex h-[calc(100vh-15rem)] min-h-[580px] max-h-[820px] w-[320px] flex-shrink-0 flex-col rounded-[24px] border border-border/80 bg-card shadow-[0_8px_24px_rgba(15,23,42,0.04)] [contain:layout_style_paint]">
      <div className="border-b border-border/80 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <LabelBadge label={label} className="h-6 px-2.5 text-[11px]" />
            <div className="mt-3 text-sm font-semibold text-foreground">{label.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {Math.min(visibleCount, totalCount)} de {totalCount} conversa{totalCount !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant={isSearching ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground"
              onClick={() =>
                onFilterStateChange(label.id, {
                  searchOpen: !isSearching,
                  query: isSearching ? '' : filterState?.query || '',
                })
              }
              title="Buscar nesta coluna"
            >
              <Search className="h-4 w-4" />
            </Button>

            <Button
              type="button"
              variant={onlyUnread ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground"
              onClick={() => onFilterStateChange(label.id, { onlyUnread: !onlyUnread })}
              title="Filtrar nao lidas"
            >
              <Filter className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {isSearching ? (
          <div className="mt-3">
            <Input
              value={filterState?.query || ''}
              onChange={(event) => onFilterStateChange(label.id, { query: event.target.value })}
              placeholder="Buscar nesta coluna..."
              className="h-9 rounded-full border-border bg-background text-xs"
            />
          </div>
        ) : null}
      </div>

      <Droppable droppableId={label.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              'attendance-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4',
              snapshot.isDraggingOver && 'bg-primary/[0.03]'
            )}
          >
            {conversations.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-border bg-background p-4 text-sm text-muted-foreground">
                Nenhum lead corresponde aos filtros desta coluna.
              </div>
            ) : (
              conversations.map((conversation, index) => (
                <Draggable key={conversation.id} draggableId={conversation.id} index={index}>
                  {(draggableProvided, draggableSnapshot) => (
                    <div
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      className={cn(draggableSnapshot.isDragging && 'opacity-90')}
                    >
                      <KanbanLeadCard
                        conversation={conversation}
                        dragHandleProps={draggableProvided.dragHandleProps}
                        className={cn(draggableSnapshot.isDragging && 'border-primary/30')}
                      />
                    </div>
                  )}
                </Draggable>
              ))
            )}

            {hasMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1 rounded-full"
                onClick={() => onLoadMore(label.id)}
              >
                Carregar mais 20
              </Button>
            ) : null}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </section>
  );
}

const KanbanColumn = memo(KanbanColumnComponent);

export default KanbanColumn;
