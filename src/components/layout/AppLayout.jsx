import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import AppSidebar from './AppSidebar';
import SiteNotificationBridge from './SiteNotificationBridge';
import { cn } from '@/lib/utils';

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-background font-inter">
      <SiteNotificationBridge />
      <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <main className={cn(
        "min-h-screen transition-all duration-300",
        collapsed ? "ml-[68px]" : "ml-[240px]"
      )}>
        <div className="flex min-h-screen flex-col">
          <div className="flex-1 min-h-0">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
