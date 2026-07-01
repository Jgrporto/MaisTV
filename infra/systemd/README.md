# Units da instalação paralela

Estas units são exclusivas da homologação blue-green em `/root/MaisTV` e usam o prefixo `maistv-next-*` para não colidir com a produção em `/root/SaasTV`.

Não renomeie para `maistv-*` e não substitua arquivos existentes em `/etc/systemd/system/maistv-*.service`. O worker de rotinas e os schedulers permanecem desativados durante a homologação. Consulte `docs/maistv-next-blue-green-deploy.md`.
