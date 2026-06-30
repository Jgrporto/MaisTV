import React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export default function ConversationsChart({ conversations }) {
  const last7Days = [];

  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dayStr = date.toISOString().split('T')[0];
    const dayLabel = date.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric' });

    const dayConvs = conversations.filter((conversation) => conversation.created_date?.split('T')[0] === dayStr);

    last7Days.push({
      name: dayLabel,
      total: dayConvs.length,
      resolved: dayConvs.filter((conversation) => conversation.status === 'resolved' || conversation.status === 'closed').length,
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.08em] text-foreground">Conversas nos últimos 7 dias</h3>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={last7Days}>
          <defs>
            <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#25D366" stopOpacity={0.24} />
              <stop offset="95%" stopColor="#25D366" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorResolved" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#1E88E5" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#1E88E5" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#E0E0E0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="#777777" axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11 }} stroke="#777777" allowDecimals={false} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{
              borderRadius: '8px',
              border: '1px solid #E0E0E0',
              boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.05)',
              fontSize: '12px',
            }}
          />
          <Area type="monotone" dataKey="total" stroke="#25D366" fill="url(#colorTotal)" strokeWidth={2.5} name="Total" />
          <Area
            type="monotone"
            dataKey="resolved"
            stroke="#1E88E5"
            fill="url(#colorResolved)"
            strokeWidth={2.5}
            name="Resolvidas"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
