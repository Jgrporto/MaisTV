import React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function QuickReplyCategorySelect({ value, categories = [], onChange }) {
  return (
    <Select value={value || 'none'} onValueChange={(nextValue) => onChange(nextValue === 'none' ? '' : nextValue)}>
      <SelectTrigger className="h-10 border-border bg-background text-foreground">
        <SelectValue placeholder="Nenhuma selecionada" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Nenhuma selecionada</SelectItem>
        {categories
          .filter((category) => category.id !== 'cat-none')
          .map((category) => (
            <SelectItem key={category.id} value={category.id}>
              {category.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
