import React, { lazy, Suspense } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter as Router, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import ThemeProvider from '@/components/theme-provider';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import AppLayout from '@/components/layout/AppLayout';
import CheckoutRenewalWorkerBridge from '@/components/layout/CheckoutRenewalWorkerBridge';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import PageNotFound from '@/lib/PageNotFound';
import { buildLoginUrl } from '@/lib/local-auth';
import { canAccessPathname, getFirstAllowedNavigationPath } from '@/lib/navigation-permissions';
import { queryClientInstance } from '@/lib/query-client';
import Checkout from '@/pages/Checkout';
import Login from '@/pages/Login';

const Attendance = lazy(() => import('@/pages/Attendance'));
const Chatbot = lazy(() => import('@/pages/Chatbot'));
const ChatbotFlowEditor = lazy(() => import('@/pages/ChatbotFlowEditor'));
const CustomerBase = lazy(() => import('@/pages/CustomerBase'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const EnvioEmMassa = lazy(() => import('@/pages/EnvioEmMassa'));
const Hsms = lazy(() => import('@/pages/Hsms'));
const Labels = lazy(() => import('@/pages/Labels'));
const QuickReplies = lazy(() => import('@/pages/QuickReplies'));
const QueuesServices = lazy(() => import('@/pages/QueuesServices'));
const Rotinas = lazy(() => import('@/pages/Rotinas'));
const Settings = lazy(() => import('@/pages/Settings'));
const Tickets = lazy(() => import('@/pages/Tickets'));

const LoadingScreen = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" />
  </div>
);

const ProtectedShell = () => {
  const { effectiveUser, isLoadingAuth, isLoadingPublicSettings, authChecked, authError, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoadingPublicSettings || isLoadingAuth || !authChecked) {
    return <LoadingScreen />;
  }

  if (authError?.type === 'user_not_registered') {
    return <UserNotRegisteredError />;
  }

  if (!isAuthenticated) {
    const redirectTo = `${location.pathname}${location.search}${location.hash}` || '/';
    return <Navigate to={buildLoginUrl(redirectTo)} replace />;
  }

  if (!canAccessPathname(effectiveUser, location.pathname)) {
    const fallbackPath = getFirstAllowedNavigationPath(effectiveUser);
    return <Navigate to={fallbackPath === location.pathname ? '/login' : fallbackPath} replace />;
  }

  return <AppLayout />;
};

const AppRoutes = () => {
  const { isAuthenticated, isLoadingAuth, authChecked } = useAuth();

  return (
    <>
      <CheckoutRenewalWorkerBridge enabled={isAuthenticated} />
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/checkout" element={<Checkout />} />
          <Route
            path="/login"
            element={isLoadingAuth && !authChecked ? <LoadingScreen /> : isAuthenticated ? <Navigate to="/" replace /> : <Login />}
          />
          <Route element={<ProtectedShell />}>
            <Route path="/" element={<Attendance />} />
            <Route path="/customers" element={<CustomerBase />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/envio" element={<EnvioEmMassa />} />
            <Route path="/queues-services" element={<QueuesServices />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/labels" element={<Labels />} />
            <Route path="/chatbot" element={<Chatbot />} />
            <Route path="/chatbotv" element={<Navigate to="/chatbot" replace />} />
            <Route path="/chatbot/editar/:flowRef" element={<ChatbotFlowEditor />} />
            <Route path="/rotinas" element={<Rotinas />} />
            <Route path="/quick-replies" element={<QuickReplies />} />
            <Route path="/hsms" element={<Hsms />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<PageNotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <ThemeProvider>
          <Router>
            <AppRoutes />
          </Router>
          <Toaster position="top-right" />
        </ThemeProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
