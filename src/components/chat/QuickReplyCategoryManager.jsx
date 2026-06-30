import React, { useEffect, useMemo, useState } from 'react';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const palette = ['#38bdf8', '#22c55e', '#a78bfa', '#f59e0b', '#fb7185', '#94a3b8'];

const defaultForm = () => ({ name: '', color: palette[0], icon: 'folder', visibleInQuickReplies: true });

export default function QuickReplyCategoryManager({
  open,
  onOpenChange,
  categories,
  onSave,
  onDelete,
  onSaveOrder,
  isSaving,
}) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const manageableCategories = useMemo(
    () =>
      (Array.isArray(categories) ? categories : [])
        .filter((category) => category.id !== 'cat-none')
        .sort((left, right) => (Number(left.sortOrder) || 9999) - (Number(right.sortOrder) || 9999)),
    [categories]
  );
  const [orderedCategories, setOrderedCategories] = useState([]);

  useEffect(() => {
    setOrderedCategories(manageableCategories);
  }, [manageableCategories]);

  const startCreate = () => {
    setEditing(null);
    setForm(defaultForm());
  };

  const startEdit = (category) => {
    setEditing(category);
    setForm({
      name: category.name || '',
      color: category.color || palette[0],
      icon: category.icon || 'folder',
      visibleInQuickReplies: category.visibleInQuickReplies !== false,
    });
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    onSave({ ...editing, ...form, name: form.name.trim() }, editing?.id || null);
    startCreate();
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;
    if (result.source.index === result.destination.index) return;
    const next = [...orderedCategories];
    const [item] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, item);
    setOrderedCategories(next);
  };

  const handleSaveOrder = () => {
    onSaveOrder?.(orderedCategories);
  };

  const toggleVisibility = (category) => {
    onSave?.(
      {
        ...category,
        visibleInQuickReplies: category.visibleInQuickReplies === false,
      },
      category.id,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] border-border bg-card text-foreground sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Categorias</DialogTitle>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 md:grid-cols-[1fr_260px]">
          <div className="min-h-0">
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="quick-reply-categories">
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} className="flex max-h-[56vh] flex-col gap-2 overflow-y-auto pr-1">
                    {orderedCategories.map((category, index) => (
                      <Draggable key={category.id} draggableId={category.id} index={index}>
                        {(dragProvided) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className="flex items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-2"
                          >
                            <button
                              type="button"
                              {...dragProvided.dragHandleProps}
                              className="text-muted-foreground hover:text-foreground"
                              title="Arrastar categoria"
                            >
                              <GripVertical className="h-4 w-4" />
                            </button>
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: category.color }} />
                            <span className="min-w-0 flex-1 truncate text-sm">{category.name}</span>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleVisibility(category)}>
                              <i
                                className={`fa-solid ${category.visibleInQuickReplies === false ? 'fa-eye-slash' : 'fa-eye'} text-[13px]`}
                                aria-hidden="true"
                              />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(category)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-red-300" onClick={() => onDelete(category.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>

            {orderedCategories.length > 1 ? (
              <Button type="button" variant="outline" className="mt-2 h-9" onClick={handleSaveOrder} disabled={isSaving}>
                Salvar ordenacao
              </Button>
            ) : null}
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-background/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{editing ? 'Editar' : 'Nova categoria'}</p>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={startCreate}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Nome"
              className="h-9 border-border bg-background text-foreground"
            />
            <div className="flex flex-wrap gap-2">
              {palette.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="h-7 w-7 rounded-full border-2"
                  style={{ backgroundColor: color, borderColor: form.color === color ? '#fff' : 'transparent' }}
                  onClick={() => setForm({ ...form, color })}
                  title={color}
                />
              ))}
            </div>
            <label className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              <span>Mostrar no menu operacional</span>
              <button type="button" className="text-foreground" onClick={() => setForm({ ...form, visibleInQuickReplies: !form.visibleInQuickReplies })}>
                <i className={`fa-solid ${form.visibleInQuickReplies ? 'fa-eye' : 'fa-eye-slash'} text-[13px]`} aria-hidden="true" />
              </button>
            </label>
            <Button type="button" className="h-9 w-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Salvando...' : 'Salvar'}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
