import React from 'react';

export default function UserNotRegisteredError() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-8 shadow-[0_2px_4px_rgba(0,0,0,0.05)]">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-[#FFF8E1] text-[#FFC107]">
          <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        <h1 className="text-3xl font-bold tracking-[-0.02em] text-foreground">Acesso restrito</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Seu usuário não está habilitado para acessar esta aplicação. Solicite a liberação ao administrador responsável.
        </p>

        <div className="mt-6 rounded-lg border border-border bg-secondary/50 p-4">
          <p className="text-sm font-semibold text-foreground">Verificações recomendadas</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Confirmar se o login foi feito com a conta correta.</li>
            <li>Validar se o cadastro do usuário existe na base da aplicação.</li>
            <li>Refazer o login após a liberação de acesso.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
