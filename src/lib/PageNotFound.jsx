import { useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';

export default function PageNotFound() {
  const location = useLocation();
  const pageName = location.pathname.substring(1);
  const { effectiveUser, isAuthenticated, authChecked } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-8 text-center shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-secondary text-foreground">
          <span className="text-2xl font-semibold">404</span>
        </div>

        <h1 className="text-3xl font-bold tracking-[-0.02em] text-foreground">Página não encontrada</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          A rota <span className="font-medium text-foreground">/{pageName}</span> não existe nesta aplicação.
        </p>

        {authChecked && isAuthenticated && effectiveUser?.role === 'admin' ? (
          <div className="mt-6 rounded-lg border border-[#FFF8E1] bg-[#FFF8E1] p-4 text-left">
            <p className="text-sm font-semibold text-foreground">Observação para administradores</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Essa rota pode indicar uma tela ainda não implementada ou uma navegação apontando para um caminho inexistente.
            </p>
          </div>
        ) : null}

        <button
          onClick={() => window.location.assign('/')}
          className="mt-8 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-[0_2px_4px_rgba(37,211,102,0.25)] transition-colors hover:bg-primary/90"
        >
          Voltar para o início
        </button>
      </div>
    </div>
  );
}
