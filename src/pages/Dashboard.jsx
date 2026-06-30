import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import {
  Award,
  BarChart3,
  Calendar,
  CalendarDays,
  ChevronDown,
  Clock3,
  Frown,
  HeartHandshake,
  Loader2,
  Megaphone,
  MessageCircle,
  MessageSquare,
  PiggyBank,
  Repeat2,
  Send,
  Smile,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserCheck,
  Users,
} from 'lucide-react';

import PageShell from '@/components/layout/PageShell';
import { useAuth } from '@/lib/AuthContext';
import { requestLocalApiJson } from '@/lib/local-api';
import { isAdminLikeUser } from '@/lib/navigation-permissions';
import { cn } from '@/lib/utils';

const MOVEMENT_COLORS = ['#c50015', '#ef6b78', '#f3b4bb'];
const DEFAULT_DASHBOARD_DATA = {
  customers: {
    active: 0,
    delinquent: 0,
    cancelled: 0,
    ltvDays: 0,
    renewed: 0,
    contracted: 0,
    cancelledInRange: 0,
  },
  ads: {
    adCustomers: 0,
    testsGenerated: 0,
    contracted: 0,
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    ads: [],
    bestAd: null,
    worstAd: null,
  },
  followup: {
    sent: 0,
    appointments: 0,
    recovered: 0,
    crc: 0,
    bestTemplate: null,
    worstTemplate: null,
    responseRate: 0,
    responses: 0,
    templates: [],
  },
  attendance: {
    totalConversations: 0,
    customerConversations: 0,
    leadConversations: 0,
    slices: [
      { label: 'Clientes', value: 0 },
      { label: 'Leads', value: 0 },
    ],
  },
  individual: {
    agents: [],
    salesRanking: [],
    supportRanking: [],
  },
};

const managerTabs = [
  {
    id: 'clientes',
    title: 'DASH 01 - Base de Clientes',
    shortTitle: 'Clientes',
    description: '',
    icon: Users,
  },
  {
    id: 'anuncios',
    title: 'DASH 02 - Aquisição por Anúncios',
    shortTitle: 'Anúncios',
    description: '',
    icon: Megaphone,
  },
  {
    id: 'recuperacao',
    title: 'DASH 03 - Recuperação',
    shortTitle: 'Recuperação',
    description: '',
    icon: Send,
  },
  {
    id: 'atendimentos',
    title: 'Atendimentos',
    shortTitle: 'Atendimentos',
    description: '',
    icon: MessageSquare,
  },
  {
    id: 'venda',
    title: 'DASH Venda',
    shortTitle: 'Venda',
    description: '',
    icon: Trophy,
  },
  {
    id: 'suporte',
    title: 'DASH Suporte',
    shortTitle: 'Suporte',
    description: '',
    icon: MessageCircle,
  },
];

const attendantTabs = managerTabs.filter((tab) => ['venda', 'suporte'].includes(tab.id));

const toDateInputValue = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getDateRangeForLastDays = (daysCount) => {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - Math.max(0, Number(daysCount) - 1));
  return {
    start: toDateInputValue(start),
    end: toDateInputValue(end),
  };
};

const getCurrentMonthDateRange = () => {
  const now = new Date();
  return {
    start: toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)),
    end: toDateInputValue(now),
  };
};

const dashboardDatePresets = [
  { id: 'today', label: 'Hoje', getRange: () => getDateRangeForLastDays(1) },
  { id: '7days', label: '7 dias', getRange: () => getDateRangeForLastDays(7) },
  { id: '30days', label: '30 dias', getRange: () => getDateRangeForLastDays(30) },
  { id: 'month', label: 'Este Mês', getRange: getCurrentMonthDateRange },
];

const normalizeText = (value = '') =>
  String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const formatInteger = (value) => String(Math.max(0, Math.round(Number(value) || 0)));

const formatCurrency = (value) =>
  new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value) || 0);

const formatPercent = (value) => `${(Number(value) || 0).toFixed(1).replace('.', ',')}%`;
const formatRate = (value) => formatPercent((Number(value) || 0) * 100);

const formatDurationSeconds = (seconds) => {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

const scoreEmoji = (score) => {
  const value = Number(score) || 0;
  if (value >= 75) return Smile;
  return Frown;
};

const resolveIsAttendantOnly = (user) => {
  if (!user) return false;
  if (isAdminLikeUser(user)) return false;
  const roleText = normalizeText([
    user.role,
    user.role_name,
    user.roleName,
    user.department,
    user.department_key,
    user.departmentKey,
  ].join(' '));
  const elevatedTerms = ['supervisor', 'coordenador', 'gerente', 'gestor', 'diretor', 'dono', 'administrador', 'admin'];
  if (elevatedTerms.some((term) => roleText.includes(term))) return false;
  return roleText.includes('atendente') || roleText.includes('attendance') || roleText.includes('suporte') || roleText.includes('venda');
};

const buildDashboardQuery = ({ start, end }) => {
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  return `/dashboard/saastv?${params.toString()}`;
};

const fetchDashboardData = async ({ start, end }) => {
  try {
    return await requestLocalApiJson(buildDashboardQuery({ start, end }), { method: 'GET' }, 'Falha ao carregar dashboard.');
  } catch (error) {
    console.error('[dashboard] failed to load SaaSTV dashboard:', error);
    return { ...DEFAULT_DASHBOARD_DATA, success: false, error: error?.message || 'Falha ao carregar dashboard.' };
  }
};

function DashboardBrowserTabs({ activeTab, tabs, onChange }) {
  return (
    <div className="dashboard-tabs-shell">
      <div className="dashboard-tabs-track" role="tablist" aria-label="Dashboards cadastradas">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn('dashboard-browser-tab group', isActive && 'dashboard-browser-tab-active')}
              onClick={() => onChange(tab.id)}
            >
              <span className={cn('dashboard-browser-tab-icon', isActive && 'dashboard-browser-tab-icon-active')}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 text-left leading-tight">
                <span className={cn('block truncate text-sm font-bold', isActive ? 'text-white' : 'text-foreground')}>
                  {tab.shortTitle}
                </span>
                {tab.description ? (
                  <span className={cn('mt-0.5 block truncate text-xs', isActive ? 'text-white/80' : 'text-muted-foreground')}>
                    {tab.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DashboardStatCard({ title, value, subtitle, icon: Icon }) {
  return (
    <div className="group min-w-0 overflow-hidden rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)] transition-shadow hover:shadow-[0_12px_30px_rgba(15,23,42,0.07)]">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/10">
        <Icon className="h-5 w-5" />
      </div>
      <p className="truncate text-sm font-bold text-foreground" title={title}>{title}</p>
      <div className="mt-2 min-w-0 break-words text-2xl font-black leading-tight text-foreground sm:text-3xl" title={String(value ?? '')}>
        {value}
      </div>
      <p className="mt-2 min-h-8 break-words text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function CompactFilterSelect({ label, value, displayValue, icon: Icon, children, onChange, className }) {
  return (
    <label
      className={cn(
        'group relative flex min-w-[190px] cursor-pointer items-center gap-3 overflow-hidden rounded-xl border border-border/80 bg-background px-3 py-2.5 shadow-[0_2px_10px_rgba(15,23,42,0.03)] transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 hover:border-primary/30',
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      <span className="min-w-0 flex-1 pr-6">
        <span className="block text-[11px] font-semibold text-muted-foreground">{label}</span>
        <span className="mt-0.5 block truncate text-sm font-bold text-foreground">{displayValue || value}</span>
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={onChange}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none border-0 bg-transparent opacity-0 outline-none"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-hover:text-primary" />
    </label>
  );
}

function DateFilter({ startDate, endDate, onStartDateChange, onEndDateChange }) {
  return (
    <div className="flex flex-wrap items-center gap-3 xl:justify-end">
      <label className="inline-flex h-11 items-center gap-3 rounded-xl border border-border bg-card px-3.5 text-sm text-muted-foreground shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
        <span className="font-medium">Data início</span>
        <input type="date" value={startDate} onChange={(event) => onStartDateChange(event.target.value)} className="w-32 border-0 bg-transparent p-0 font-semibold text-foreground outline-none" />
      </label>
      <label className="inline-flex h-11 items-center gap-3 rounded-xl border border-border bg-card px-3.5 text-sm text-muted-foreground shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
        <span className="font-medium">Data fim</span>
        <input type="date" value={endDate} onChange={(event) => onEndDateChange(event.target.value)} className="w-32 border-0 bg-transparent p-0 font-semibold text-foreground outline-none" />
      </label>
    </div>
  );
}

function DashboardFilters({ startDate, endDate, onDateRangeChange }) {
  const activePreset = dashboardDatePresets.find((preset) => {
    const range = preset.getRange();
    return range.start === startDate && range.end === endDate;
  })?.id || 'custom';
  const activePresetLabel = activePreset === 'custom' ? 'Personalizado' : dashboardDatePresets.find((preset) => preset.id === activePreset)?.label || 'Período';

  return (
    <section className="rounded-2xl border border-border/80 bg-card/95 p-4 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="flex flex-wrap items-end gap-3">
        <CompactFilterSelect
          label="Período"
          value={activePreset}
          displayValue={activePresetLabel}
          icon={Calendar}
          onChange={(event) => {
            const preset = dashboardDatePresets.find((item) => item.id === event.target.value);
            if (preset) onDateRangeChange(preset.getRange());
          }}
        >
          {activePreset === 'custom' ? <option value="custom">Personalizado</option> : null}
          {dashboardDatePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </CompactFilterSelect>
        <DateFilter
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={(nextStart) => onDateRangeChange({ start: nextStart, end: endDate })}
          onEndDateChange={(nextEnd) => onDateRangeChange({ start: startDate, end: nextEnd })}
        />
      </div>
    </section>
  );
}

function StageIconBox({ icon: Icon, tone = 'light' }) {
  return (
    <div className={cn('mr-6 flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl', tone === 'dark' ? 'bg-white/12 text-white' : 'bg-[#eed6d7] text-[#8b6a6c]')}>
      <Icon className="h-6 w-6" />
    </div>
  );
}

function FunnelCard({ title, description, stages, insight }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-[0_4px_16px_rgba(15,23,42,0.04)] lg:p-4.5">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#efe5e5] bg-white p-3">
        <div className="relative hidden overflow-visible rounded-2xl lg:flex">
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            const isFirst = index === 0;
            const isSecond = index === 1;
            const isLast = index === stages.length - 1;
            return (
              <div key={stage.label} className={cn('relative min-w-0', !isFirst && '-ml-5')} style={{ zIndex: index + 1, flex: '1 1 0' }}>
                <div
                  className={cn('flex min-h-[112px] items-center px-7 py-5', isFirst || isSecond ? 'text-white' : 'text-[#111827]')}
                  style={{
                    background: isFirst
                      ? 'linear-gradient(135deg, #c50015 0%, #db061e 50%, #b30014 100%)'
                      : isSecond
                        ? 'linear-gradient(90deg, #ef6b78 0%, #e34a59 100%)'
                        : isLast
                          ? 'linear-gradient(90deg, #f3e2e3 0%, #efdddd 100%)'
                          : 'linear-gradient(90deg, #f2dfe1 0%, #efd6d9 100%)',
                    clipPath: isFirst
                      ? 'polygon(0 0, 90% 0, 96.5% 50%, 90% 100%, 0 100%)'
                      : isLast
                        ? 'polygon(10% 0, 100% 0, 100% 100%, 10% 100%, 0 50%)'
                        : 'polygon(7% 0, 90% 0, 96.5% 50%, 90% 100%, 7% 100%, 0 50%)',
                    borderRadius: isFirst ? '16px 0 0 16px' : isLast ? '0 16px 16px 0' : undefined,
                  }}
                >
                  <StageIconBox icon={Icon} tone={stage.tone || (isFirst || isSecond ? 'dark' : 'light')} />
                  <div>
                    <div className="text-[13px] font-bold">{index + 1}. {stage.label}</div>
                    <div className="mt-1 text-[48px] font-bold leading-none tracking-[-0.06em]">{stage.value}</div>
                    <div className={cn('mt-2 text-[13px] font-semibold', isFirst || isSecond ? 'text-white/95' : 'text-muted-foreground')}>
                      {stage.helper}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-3 lg:hidden">
          {stages.map((stage, index) => (
            <div key={stage.label} className={cn('rounded-xl p-4', index >= 2 ? 'bg-primary/10 text-foreground' : 'bg-primary text-white')}>
              <div className="text-sm font-bold">{index + 1}. {stage.label}</div>
              <div className="mt-1 text-4xl font-bold">{stage.value}</div>
              <div className={cn('mt-1 text-sm', index >= 2 ? 'text-muted-foreground' : 'text-white/85')}>{stage.helper}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-primary/10 bg-primary/5 px-4 py-3 text-sm font-medium text-foreground">
        Insight do período: {insight}
      </div>
    </section>
  );
}

function HorizontalBarsCard({ title, description, items, valueFormatter = formatInteger }) {
  const max = Math.max(1, ...items.map((item) => Number(item.value || 0)));
  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-5">
        <h3 className="text-base font-black tracking-[-0.02em] text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="grid grid-cols-[minmax(88px,150px)_minmax(0,1fr)_64px] items-center gap-3 text-xs">
            <span className="truncate font-bold text-foreground" title={item.label}>{item.label}</span>
            <div className="h-3 rounded-full bg-primary/10">
              <div className="h-3 rounded-full bg-primary/60" style={{ width: Number(item.value) > 0 ? `${Math.max(5, (Number(item.value) / max) * 100)}%` : '0%' }} />
            </div>
            <span className="text-right font-black text-foreground tabular-nums">{valueFormatter(item.value)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BaseMovementPieCard({ items }) {
  const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const data = total > 0 ? items : [{ label: 'Sem movimento', value: 1 }];

  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-5">
        <h3 className="text-base font-black tracking-[-0.02em] text-foreground">Movimento da base no período</h3>
        <p className="mt-1 text-sm text-muted-foreground">Renovações, contratações e cancelamentos filtrados por data.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
        <div className="h-[260px] min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="label" innerRadius={62} outerRadius={98} paddingAngle={2}>
                {data.map((entry, index) => (
                  <Cell key={entry.label} fill={MOVEMENT_COLORS[index % MOVEMENT_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value, name) => [formatInteger(total > 0 ? value : 0), name]} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-3 self-center">
          {items.map((item, index) => {
            const value = Number(item.value || 0);
            const percentage = total > 0 ? (value / total) * 100 : 0;
            return (
              <div key={item.label} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: MOVEMENT_COLORS[index % MOVEMENT_COLORS.length] }} />
                  <span className="truncate text-sm font-bold text-foreground">{item.label}</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-black text-foreground">{formatInteger(value)}</div>
                  <div className="text-xs text-muted-foreground">{formatPercent(percentage)}</div>
                </div>
              </div>
            );
          })}
          {total === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              Sem movimento no período selecionado.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AttendanceAudiencePieCard({ items }) {
  const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const data = total > 0 ? items : [{ label: 'Sem conversas', value: 1 }];

  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-5">
        <h3 className="text-base font-black tracking-[-0.02em] text-foreground">Volume de atendimento de clientes e leads</h3>
        <p className="mt-1 text-sm text-muted-foreground">Divisao das conversas filtradas por data.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
        <div className="h-[260px] min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="label" innerRadius={62} outerRadius={98} paddingAngle={2}>
                {data.map((entry, index) => (
                  <Cell key={entry.label} fill={MOVEMENT_COLORS[index % MOVEMENT_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value, name) => [formatInteger(total > 0 ? value : 0), name]} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-3 self-center">
          {items.map((item, index) => {
            const value = Number(item.value || 0);
            const percentage = total > 0 ? (value / total) * 100 : 0;
            return (
              <div key={item.label} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: MOVEMENT_COLORS[index % MOVEMENT_COLORS.length] }} />
                  <span className="truncate text-sm font-bold text-foreground">{item.label}</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-black text-foreground">{formatInteger(value)}</div>
                  <div className="text-xs text-muted-foreground">{formatPercent(percentage)}</div>
                </div>
              </div>
            );
          })}
          {total === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              Sem conversas no periodo selecionado.
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function HourTimelineCard({ items = [] }) {
  const hours = items.length ? items : Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const max = Math.max(1, ...hours.map((item) => Number(item.count || 0)));
  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-5">
        <h3 className="text-base font-black tracking-[-0.02em] text-foreground">Horário de anúncio caindo cliente</h3>
        <p className="mt-1 text-sm text-muted-foreground">Linha do tempo por hora dos contatos identificados por anúncio.</p>
      </div>
      <div className="flex h-[210px] items-end gap-1.5 rounded-xl bg-muted/20 px-3 pb-8 pt-4">
        {hours.map((item) => (
          <div key={item.hour} className="relative flex min-w-0 flex-1 justify-center">
            <div className="w-full max-w-4 rounded-t-lg bg-primary/55" style={{ height: Number(item.count) > 0 ? `${Math.max(8, (Number(item.count) / max) * 150)}px` : '2px' }} />
            {item.hour % 3 === 0 ? <span className="absolute top-[158px] text-[10px] text-muted-foreground">{String(item.hour).padStart(2, '0')}h</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function BestWorstCard({ bestLabel, bestValue, worstLabel, worstValue, title = 'Melhor e pior resultado' }) {
  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-5">
        <h3 className="text-base font-black tracking-[-0.02em] text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">Comparativo automático com base nos dados disponíveis.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-primary/10 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-primary"><TrendingUp className="h-4 w-4" /> Melhor</div>
          <div className="mt-3 truncate text-lg font-black text-foreground" title={bestLabel}>{bestLabel || 'Sem dados'}</div>
          <div className="mt-1 text-sm text-muted-foreground">{bestValue || '0 resultados'}</div>
        </div>
        <div className="rounded-2xl border border-border/80 bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-muted-foreground"><TrendingDown className="h-4 w-4" /> Pior</div>
          <div className="mt-3 truncate text-lg font-black text-foreground" title={worstLabel}>{worstLabel || 'Sem dados'}</div>
          <div className="mt-1 text-sm text-muted-foreground">{worstValue || '0 resultados'}</div>
        </div>
      </div>
    </section>
  );
}

function resolveCurrentAgent(user, agents = []) {
  const candidates = [user?.email, user?.username, user?.full_name, user?.name, user?.id]
    .map(normalizeText)
    .filter(Boolean);
  return agents.find((agent) => candidates.includes(normalizeText(agent.email)) || candidates.includes(normalizeText(agent.name)) || candidates.includes(normalizeText(agent.key))) || null;
}

function ScoreCard({ agent, ranking = [] }) {
  const score = Number(agent?.score || 0);
  const Emoji = scoreEmoji(score);
  const position = ranking.findIndex((row) => row.key === agent?.key) + 1;
  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5 shadow-[0_8px_24px_rgba(15,23,42,0.045)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-black tracking-[-0.02em] text-foreground">Minha pontuação atual</h3>
          <p className="mt-1 text-sm text-muted-foreground">Média entre finalização, velocidade e ranking interno.</p>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Emoji className="h-6 w-6" /></div>
      </div>
      <div className="text-5xl font-black tracking-[-0.06em] text-foreground">{formatInteger(score)}%</div>
      <div className="mt-3 h-3 rounded-full bg-primary/10">
        <div className="h-3 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {position > 0 ? `${position}º no ranking entre ${ranking.length} suporte(s).` : 'Sem ranking suficiente no período.'}
      </p>
    </section>
  );
}

function ClientesDashboard({ data }) {
  const customers = data.customers || DEFAULT_DASHBOARD_DATA.customers;
  const topCards = [
    { title: 'Ativos', value: formatInteger(customers.active), subtitle: 'Clientes ativos na base', icon: Users },
    { title: 'Inadimplentes até 5 dias', value: formatInteger(customers.delinquent), subtitle: 'Sem pagar até 5 dias', icon: Clock3 },
    { title: 'Cancelados acima de 6 dias', value: formatInteger(customers.cancelled), subtitle: 'Vencidos há mais de 6 dias', icon: TrendingDown },
    { title: 'LTV', value: `${formatInteger(customers.ltvDays)} dias`, subtitle: 'Tempo médio de base', icon: Repeat2 },
  ];
  const movementCards = [
    { title: 'Clientes que renovaram', value: formatInteger(customers.renewed), subtitle: 'Movimento no período filtrado', icon: HeartHandshake },
    { title: 'Clientes que contrataram', value: formatInteger(customers.contracted), subtitle: 'Novas contratações no período', icon: UserCheck },
    { title: 'Clientes que cancelaram', value: formatInteger(customers.cancelledInRange), subtitle: 'Cancelamentos no período', icon: TrendingDown },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {topCards.map((card) => <DashboardStatCard key={card.title} {...card} />)}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {movementCards.map((card) => <DashboardStatCard key={card.title} {...card} />)}
      </div>
      <BaseMovementPieCard
        items={[
          { label: 'Renovaram', value: customers.renewed },
          { label: 'Contrataram', value: customers.contracted },
          { label: 'Cancelaram', value: customers.cancelledInRange },
        ]}
      />
    </>
  );
}

function AnunciosDashboard({ data }) {
  const ads = data.ads || DEFAULT_DASHBOARD_DATA.ads;
  const stages = [
    { label: 'Clientes do anúncio', value: formatInteger(ads.adCustomers), helper: 'Contatos identificados', icon: Megaphone, tone: 'dark' },
    { label: 'Geraram teste', value: formatInteger(ads.testsGenerated), helper: `${formatRate(ads.adCustomers ? ads.testsGenerated / ads.adCustomers : 0)} dos leads`, icon: Target, tone: 'dark' },
    { label: 'Contrataram', value: formatInteger(ads.contracted), helper: `${formatRate(ads.testsGenerated ? ads.contracted / ads.testsGenerated : 0)} dos testes`, icon: UserCheck, tone: 'light' },
  ];

  return (
    <>
      <FunnelCard
        title="Funil de aquisição"
        description="Clientes vindos do anúncio até contratação."
        stages={stages}
        insight={`${formatInteger(ads.adCustomers)} clientes vieram de anúncio, ${formatInteger(ads.testsGenerated)} geraram teste e ${formatInteger(ads.contracted)} contrataram.`}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.7fr)]">
        <HourTimelineCard items={ads.byHour} />
        <BestWorstCard
          title="Melhor anúncio / pior anúncio"
          bestLabel={ads.bestAd?.name}
          bestValue={`${formatInteger(ads.bestAd?.leads)} leads`}
          worstLabel={ads.worstAd?.name}
          worstValue={`${formatInteger(ads.worstAd?.leads)} leads`}
        />
      </div>
    </>
  );
}

function RecuperacaoDashboard({ data }) {
  const followup = data.followup || DEFAULT_DASHBOARD_DATA.followup;
  const stages = [
    { label: 'Disparos +5', value: formatInteger(followup.sent), helper: 'Enviados no período', icon: Send, tone: 'dark' },
    { label: 'Respostas', value: formatInteger(followup.responses), helper: `${formatRate(followup.responseRate)} de resposta`, icon: MessageSquare, tone: 'dark' },
    { label: 'Agendamentos', value: formatInteger(followup.appointments), helper: 'Gerados pelos disparos', icon: CalendarDays, tone: 'light' },
    { label: 'Recuperados', value: formatInteger(followup.recovered), helper: 'Clientes recuperados', icon: HeartHandshake, tone: 'light' },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <DashboardStatCard title="Disparos +5 pra cima" value={formatInteger(followup.sent)} subtitle="Rotinas acima de D+5" icon={Send} />
        <DashboardStatCard title="Agendamentos gerados" value={formatInteger(followup.appointments)} subtitle="Agendamentos atribuídos" icon={CalendarDays} />
        <DashboardStatCard title="Clientes recuperados" value={formatInteger(followup.recovered)} subtitle="Voltaram após disparo" icon={HeartHandshake} />
        <DashboardStatCard title="CRC" value={formatCurrency(followup.crc)} subtitle="Custo por recuperação" icon={PiggyBank} />
        <DashboardStatCard title="Melhor template" value={followup.bestTemplate?.name || '—'} subtitle="Maior recuperação" icon={Award} />
        <DashboardStatCard title="Taxa de resposta" value={formatRate(followup.responseRate)} subtitle="Respostas / disparos" icon={MessageCircle} />
      </div>
      <FunnelCard
        title="Funil de recuperação"
        description="Dos disparos +5 até o cliente recuperado."
        stages={stages}
        insight={`${formatInteger(followup.sent)} disparos geraram ${formatInteger(followup.responses)} respostas e ${formatInteger(followup.recovered)} recuperados.`}
      />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <BestWorstCard
          title="Melhor template / pior template"
          bestLabel={followup.bestTemplate?.name}
          bestValue={`${formatInteger(followup.bestTemplate?.recovered)} recuperados`}
          worstLabel={followup.worstTemplate?.name}
          worstValue={`${formatInteger(followup.worstTemplate?.recovered)} recuperados`}
        />
        <HorizontalBarsCard
          title="Templates por taxa de resposta"
          description="Ranking dos templates de recuperação com dados disponíveis."
          items={(followup.templates || []).length ? followup.templates.map((template) => ({ label: template.name, value: (template.responseRate || 0) * 100 })) : [{ label: 'Sem template', value: 0 }]}
          valueFormatter={formatPercent}
        />
      </div>
    </>
  );
}

function AtendimentosDashboard({ data }) {
  const attendance = data.attendance || DEFAULT_DASHBOARD_DATA.attendance;
  const slices = Array.isArray(attendance.slices) && attendance.slices.length
    ? attendance.slices
    : [
        { label: 'Clientes', value: attendance.customerConversations },
        { label: 'Leads', value: attendance.leadConversations },
      ];

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStatCard
          title="Quantidade de conversas"
          value={formatInteger(attendance.totalConversations)}
          subtitle="Conversas no periodo filtrado"
          icon={MessageSquare}
        />
        <DashboardStatCard
          title="Conversas de clientes"
          value={formatInteger(attendance.customerConversations)}
          subtitle="Contatos vinculados a clientes da base"
          icon={Users}
        />
        <DashboardStatCard
          title="Conversas de leads"
          value={formatInteger(attendance.leadConversations)}
          subtitle="Contatos ainda classificados como leads"
          icon={Target}
        />
      </div>
      <AttendanceAudiencePieCard items={slices} />
    </>
  );
}

function IndividualDashboard({ data, user, mode }) {
  const agents = data.individual?.agents || [];
  const ranking = mode === 'venda' ? data.individual?.salesRanking || [] : data.individual?.supportRanking || [];
  const currentAgent = resolveCurrentAgent(user, agents) || {
    key: 'current-user',
    name: user?.full_name || user?.name || 'Meu usuário',
    salesStarted: 0,
    salesFinished: 0,
    supportStarted: 0,
    supportFinished: 0,
    salesGoal: 0,
    salesMonth: 0,
    salesNeeded: 0,
    tmlSeconds: 0,
    tmrSeconds: 0,
    score: 0,
  };
  const isSales = mode === 'venda';
  const cards = isSales
    ? [
        { title: 'Meus atendimentos iniciados', value: formatInteger(currentAgent.salesStarted), subtitle: 'Atendimentos de venda no período', icon: MessageCircle },
        { title: 'Meus atendimentos finalizados', value: formatInteger(currentAgent.salesFinished), subtitle: 'Finalizações de venda no período', icon: UserCheck },
        { title: 'Meta do mês', value: formatInteger(currentAgent.salesGoal), subtitle: 'Meta mensal cadastrada', icon: Target },
        { title: 'Total de vendas do mês', value: formatInteger(currentAgent.salesMonth), subtitle: 'Vendas finalizadas no mês', icon: Trophy },
        { title: 'Projeção necessária', value: formatInteger(currentAgent.salesNeeded), subtitle: 'Vendas restantes para bater meta', icon: TrendingUp },
        { title: 'Meu TML no mês', value: formatDurationSeconds(currentAgent.tmlSeconds), subtitle: 'Tempo médio de lead', icon: Clock3 },
        { title: 'Meu TMR do mês', value: formatDurationSeconds(currentAgent.tmrSeconds), subtitle: 'Tempo médio por resposta', icon: TimerIcon },
      ]
    : [
        { title: 'Meus suportes iniciados', value: formatInteger(currentAgent.supportStarted), subtitle: 'Suportes abertos no período', icon: MessageCircle },
        { title: 'Meus suportes finalizados', value: formatInteger(currentAgent.supportFinished), subtitle: 'Suportes encerrados no período', icon: UserCheck },
        { title: 'Meu TML no mês', value: formatDurationSeconds(currentAgent.tmlSeconds), subtitle: 'Tempo médio de atendimento', icon: Clock3 },
        { title: 'Meu TMR do mês', value: formatDurationSeconds(currentAgent.tmrSeconds), subtitle: 'Tempo médio por mensagem', icon: MessageSquare },
      ];

  return (
    <>
      <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', isSales ? 'xl:grid-cols-4 2xl:grid-cols-7' : 'xl:grid-cols-4')}>
        {cards.map((card) => <DashboardStatCard key={card.title} {...card} />)}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(360px,0.6fr)_minmax(0,1.4fr)]">
        <ScoreCard agent={currentAgent} ranking={ranking} />
        <HorizontalBarsCard
          title={isSales ? 'Ranking de venda' : 'Ranking de suporte'}
          description="Comparativo entre usuários com base nos dados disponíveis."
          items={(ranking || []).length ? ranking.map((agent) => ({ label: agent.name, value: isSales ? agent.salesMonth : agent.score })) : [{ label: currentAgent.name, value: currentAgent.score }]}
          valueFormatter={isSales ? formatInteger : formatPercent}
        />
      </div>
    </>
  );
}

function TimerIcon(props) {
  return <Clock3 {...props} />;
}

export default function Dashboard() {
  const { effectiveUser } = useAuth();
  const isAttendantOnly = resolveIsAttendantOnly(effectiveUser);
  const availableTabs = isAttendantOnly ? attendantTabs : managerTabs;
  const [activeDashboard, setActiveDashboard] = useState(() => availableTabs[0]?.id || 'clientes');
  const [{ start, end }, setDateRange] = useState(() => getDateRangeForLastDays(30));

  useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === activeDashboard)) {
      setActiveDashboard(availableTabs[0]?.id || 'clientes');
    }
  }, [activeDashboard, availableTabs]);

  const dashboardQuery = useQuery({
    queryKey: ['saastv-dashboard', start, end],
    queryFn: () => fetchDashboardData({ start, end }),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  const data = dashboardQuery.data || DEFAULT_DASHBOARD_DATA;

  return (
    <PageShell className="gap-5 lg:gap-6">
      <section className="rounded-2xl border border-border/80 bg-card/90 p-4 shadow-[0_10px_34px_rgba(15,23,42,0.06)] lg:p-5">
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-[28px] font-bold tracking-[-0.02em] text-foreground">Dashboard</h1>
          </div>
          {dashboardQuery.isFetching ? (
            <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-bold text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando
            </span>
          ) : null}
        </div>

        <DashboardBrowserTabs activeTab={activeDashboard} tabs={availableTabs} onChange={setActiveDashboard} />
      </section>

      <DashboardFilters
        startDate={start}
        endDate={end}
        onDateRangeChange={(nextRange) => setDateRange((currentRange) => ({ ...currentRange, ...nextRange }))}
      />

      {activeDashboard === 'clientes' ? <ClientesDashboard data={data} /> : null}
      {activeDashboard === 'anuncios' ? <AnunciosDashboard data={data} /> : null}
      {activeDashboard === 'recuperacao' ? <RecuperacaoDashboard data={data} /> : null}
      {activeDashboard === 'atendimentos' ? <AtendimentosDashboard data={data} /> : null}
      {activeDashboard === 'venda' ? <IndividualDashboard data={data} user={effectiveUser} mode="venda" /> : null}
      {activeDashboard === 'suporte' ? <IndividualDashboard data={data} user={effectiveUser} mode="suporte" /> : null}

      {dashboardQuery.data?.error ? (
        <section className="rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm font-medium text-destructive">
          {dashboardQuery.data.error}
        </section>
      ) : null}
    </PageShell>
  );
}
