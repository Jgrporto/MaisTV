import React from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = ['#25D366', '#1E88E5', '#FFC107', '#8E44AD'];
const deptLabels = { general: 'Geral', sales: 'Vendas', support: 'Suporte', billing: 'Financeiro' };

export default function DepartmentBreakdown({ conversations }) {
  const deptCounts = {};

  conversations.forEach((conversation) => {
    const department = conversation.department || 'general';
    deptCounts[department] = (deptCounts[department] || 0) + 1;
  });

  const data = Object.entries(deptCounts).map(([key, value]) => ({
    name: deptLabels[key] || key,
    value,
  }));

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-foreground">Por departamento</h3>
        <p className="py-8 text-center text-sm text-muted-foreground">Sem dados</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-foreground">Por departamento</h3>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} dataKey="value">
            {data.map((_, index) => (
              <Cell key={index} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              fontSize: '12px',
              boxShadow: '0px 2px 4px rgba(0,0,0,0.05)',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        {data.map((item, index) => (
          <div key={item.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
            {item.name} ({item.value})
          </div>
        ))}
      </div>
    </div>
  );
}
