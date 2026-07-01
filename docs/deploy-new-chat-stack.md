# Deploy da nova stack de chat

A VPS hospeda simultaneamente a produção `/root/SaasTV` e a homologação `/root/MaisTV`. Por isso, o deploy antigo que reutilizava `/root/SaasTV`, portas `505x` e units `maistv-*` foi retirado.

Use exclusivamente [o runbook blue-green da MaisTV](maistv-next-blue-green-deploy.md). Ele define:

- units `maistv-next-*`;
- portas isoladas `5350–5356`, PostgreSQL `55432` e Redis `56379`;
- frontend `homolog-test.hakione.tech`;
- API `api-homolog-test.hakione.tech`;
- snapshot SQLite consistente, migration, backfill e smoke tests;
- cutover apenas dos webhooks oficiais com rollback por Nginx.

Não copie arquivos de `infra/systemd` sobre units `maistv-*` existentes e não publique o build de homologação em `/var/www/maistv/dist`.
