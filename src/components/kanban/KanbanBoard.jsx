import React, { memo, useCallback, useMemo, useState } from 'react';
import { DragDropContext } from '@hello-pangea/dnd';
import { Filter, LayoutPanelTop, Search, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import KanbanColumn from './KanbanColumn';

const PAGE_SIZE = 20;

function matchesGlobalSearch(conversation, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    conversation.contact_name,
    conversation.contact_phone,
    conversation.last_message,
    conversation.assigned_agent_name,
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function matchesColumnSearch(conversation, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    conversation.contact_name,
    conversation.contact_phone,
    conversation.last_message,
    conversation.notes,
  ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
}

function KanbanBoardComponent({
  labels,
  conversations,
  onStageChange,
  isLoading = false,
}) {
  const [globalSearch, setGlobalSearch] = useState('');
  const [globalOnlyUnread, setGlobalOnlyUnread] = useState(false);
  const [globalOnlyAssigned, setGlobalOnlyAssigned] = useState(false);
  const [columnFilters, setColumnFilters] = useState({});
  const [visibleCounts, setVisibleCounts] = useState({});

  const filteredConversations = useMemo(
    () =>
      conversations.filter((conversation) => {
        if (!matchesGlobalSearch(conversation, globalSearch)) {
          return false;
        }

        if (globalOnlyUnread && Number(conversation.unread_count || 0) <= 0) {
          return false;
        }

        if (globalOnlyAssigned && !String(conversation.assigned_agent_name || '').trim()) {
          return false;
        }

        return true;
      }),
    [conversations, globalOnlyAssigned, globalOnlyUnread, globalSearch]
  );

  const columns = useMemo(
    () =>
      labels.map((label) => {
        const filterState = columnFilters[label.id] || {};
        const matchedConversations = filteredConversations
          .filter((conversation) => conversation.stage_label_id === label.id)
          .filter((conversation) => {
            if (filterState.onlyUnread && Number(conversation.unread_count || 0) <= 0) {
              return false;
            }

            return matchesColumnSearch(conversation, filterState.query);
          });
        const visibleCount = visibleCounts[label.id] || PAGE_SIZE;

        return {
          ...label,
          filterState,
          totalCount: matchedConversations.length,
          visibleCount,
          hasMore: matchedConversations.length > visibleCount,
          conversations: matchedConversations.slice(0, visibleCount),
        };
      }),
    [columnFilters, filteredConversations, labels, visibleCounts]
  );

  const activeFiltersCount = [globalOnlyUnread, globalOnlyAssigned, Boolean(globalSearch.trim())].filter(Boolean).length;

  const handleDragEnd = useCallback(
    (result) => {
      if (!result.destination || result.destination.droppableId === result.source.droppableId) {
        return;
      }

      onStageChange?.(result.draggableId, result.destination.droppableId);
    },
    [onStageChange]
  );

  const updateColumnFilter = useCallback((labelId, nextPartialState) => {
    setColumnFilters((current) => ({
      ...current,
      [labelId]: {
        ...(current[labelId] || {}),
        ...nextPartialState,
      },
    }));
    setVisibleCounts((current) => ({
      ...current,
      [labelId]: PAGE_SIZE,
    }));
  }, []);

  const loadMoreColumn = useCallback((labelId) => {
    setVisibleCounts((current) => ({
      ...current,
      [labelId]: (current[labelId] || PAGE_SIZE) + PAGE_SIZE,
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setGlobalSearch('');
    setGlobalOnlyUnread(false);
    setGlobalOnlyAssigned(false);
    setColumnFilters({});
    setVisibleCounts({});
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-[28px] border border-border/80 bg-card p-4 shadow-[0_8px_24px_rgba(15,23,42,0.04)] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative max-w-2xl flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={globalSearch}
              onChange={(event) => setGlobalSearch(event.target.value)}
              placeholder="Buscar lead, telefone, mensagem ou responsavel..."
              className="h-10 rounded-full border-border bg-background pl-9 text-sm shadow-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={globalOnlyAssigned ? 'secondary' : 'outline'}
              size="sm"
              className="rounded-full"
              onClick={() => setGlobalOnlyAssigned((current) => !current)}
            >
              <LayoutPanelTop className="h-4 w-4" />
              Com responsavel
            </Button>

            <Button
              type="button"
              variant={globalOnlyUnread ? 'secondary' : 'outline'}
              size="sm"
              className="rounded-full"
              onClick={() => setGlobalOnlyUnread((current) => !current)}
            >
              <Filter className="h-4 w-4" />
              Nao lidas
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-full bg-background px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {filteredConversations.length} lead{filteredConversations.length !== 1 ? 's' : ''} visiveis
          </Badge>
          <Badge variant="outline" className="rounded-full bg-background px-3 py-1 text-[11px] font-medium text-muted-foreground">
            20 por lote
          </Badge>

          {activeFiltersCount > 0 ? (
            <Button type="button" variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Limpar filtros
            </Button>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-border/80 bg-background shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        {isLoading ? (
          <div className="flex min-h-[420px] items-center justify-center">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="attendance-scrollbar flex gap-4 overflow-x-auto p-4">
              {columns.map((column) => (
                <KanbanColumn
                  key={column.id}
                  label={column}
                  totalCount={column.totalCount}
                  visibleCount={column.visibleCount}
                  hasMore={column.hasMore}
                  conversations={column.conversations}
                  filterState={column.filterState}
                  onFilterStateChange={updateColumnFilter}
                  onLoadMore={loadMoreColumn}
                />
              ))}
            </div>
          </DragDropContext>
        )}
      </div>
    </div>
  );
}

const KanbanBoard = memo(KanbanBoardComponent);

export default KanbanBoard;
