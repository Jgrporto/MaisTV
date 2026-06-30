export const updateHistory = [
  {
    id: '2026-05-12-chatbot-flow-builder',
    version: 'v1.0.1',
    date: '2026-05-12',
    title: 'Editor visual de chatbot',
    summary:
      'A plataforma ganhou o modulo Chatbot com listagem de flows, importacao/exportacao JSON e editor visual baseado em React Flow.',
    items: [
      'Novo menu Chatbot com pesquisa, criacao em branco, importacao JSON, ativacao, exclusao e download do fluxograma.',
      'Editor em `/chatbot/editar/flow<codigo>` com componentes de mensagem, audio, etiqueta, finalizacao, URA, variaveis, redirecionamento e espera.',
      'Setas da URA agora guardam tipo de ligacao, descricao, limite de 10 opcoes e saidas unicas para invalido e tempo de espera.',
      'Variaveis padrao do cliente ficaram disponiveis para uso em respostas rapidas e no novo componente de variaveis.',
    ],
  },
  {
    id: '2026-05-09-platform-adjustments-chat-settings-sync',
    version: 'v1.0.0',
    date: '2026-05-09',
    title: 'Ajustes estruturais de chat, configurações e sincronização',
    summary:
      'A plataforma consolidou uma rodada ampla de melhorias operacionais no atendimento, nas permissões de configuração, no histórico de conversas e na estabilidade da sincronização com a base de clientes.',
    items: [
      'A lista de conversas foi refinada com novo filtro de Resolvidas, reposicionamento do ícone de serviço e persistência do estado de encerramento diário por 24 horas.',
      'O chat passou a aceitar `Esc` para voltar ao estado inicial, respostas rápidas com `/` em qualquer ponto do texto, botão de encerrar atendimento e identificação do agente para os demais operadores.',
      'Mensagens passaram a usar reconciliação mais estável com IDs únicos e arquivamento local por conversa, preservando histórico agrupado em janelas contínuas de 24 horas.',
      'A tela de Configurações ganhou feedback visual de salvamento, controle granular de visibilidade/edição por bloco e padronização textual em `pt-BR`.',
      'A sincronização de clientes foi desacoplada do atendimento com cache em memória no backend local, menos polling no frontend e redução do carregamento desnecessário durante a operação.',
    ],
  },
  {
    id: '2026-05-08-browser-sync-and-service-operations',
    version: 'v0.3.2',
    date: '2026-05-08',
    title: 'Sincronizacao browser-first e operacao por servicos consolidada',
    summary:
      'A operacao passou a depender de sincronizacao NewBr executada no navegador, com notificacoes globais, fallback de administrador sem login real e consolidacao das regras de visibilidade por servicos e etiquetas.',
    items: [
      'A sincronizacao manual do NewBr agora roda no frontend, usa o navegador atual para autenticar no painel e continua em segundo plano mesmo com troca de rota dentro da SPA.',
      'A sincronizacao automatica passou a seguir a mesma estrategia browser-first, reaproveitando as credenciais salvas localmente e disparando uma nova coleta quando `nextScheduledAt` vence com a aplicacao aberta.',
      'As notificacoes da sincronizacao foram centralizadas no shell global e agora aparecem no canto superior direito em qualquer tela, com aviso de inicio, sucesso e falha.',
      'Quando a aplicacao e acessada sem login real, o usuario administrador padrao passa a ser assumido automaticamente para liberar servicos, etiquetas e filtros operacionais.',
      'O atendimento e a tela de etiquetas consolidaram a visibilidade por servico baseada em etiquetas, incluindo exibicao de icones de fila na lista de conversas e persistencia compartilhada no backend local.',
    ],
  },
  {
    id: '2026-05-07-services-module-and-visibility-rules',
    version: 'v0.3.1',
    date: '2026-05-07',
    title: 'Modulo de servicos com filas, icones e visibilidade por etiqueta',
    summary:
      'A plataforma ganhou um cadastro persistido de servicos para organizar filas de atendimento, limitar a visibilidade por usuario e refletir essa estrutura nas telas de Configuracoes, Atendimento e Etiquetas.',
    items: [
      'Nova entidade `Service` no backend local com seeding inicial de Suporte, Onboarding e Vendas, incluindo usuarios, numeros, etiquetas e icones padrao.',
      'Tela `/settings` passou a exibir o bloco de Servicos logo abaixo de Funcoes, com listagem, visualizacao, edicao, historico local e seletor de 5 icones pre-definidos.',
      'Tela `/` substituiu o filtro estatico de departamentos por um filtro dinamico de servicos, mostrando apenas as filas atribuidas ao usuario autenticado.',
      'Conversas e tela `/labels` agora respeitam a visibilidade por servico com base nas etiquetas atribuidas, e clientes em multiplos servicos exibem os icones correspondentes na lista.',
    ],
  },
  {
    id: '2026-05-06-chat-polish-audio-replies-media-and-quick-replies',
    version: 'v0.3',
    date: '2026-05-06',
    title: 'Refino do chat: audio, respostas, anexos e respostas rapidas',
    summary:
      'O atendimento recebeu uma rodada ampla de refinamentos para ficar mais proximo do comportamento do WhatsApp Web, cobrindo audio, citacoes, anexos, foco de digitacao e integracao das respostas rapidas.',
    items: [
      'Fluxo de audio foi ampliado com gravacao por microfone, barra de captura no composer, preview antes do envio e player dedicado no historico com waveform, seek e velocidade.',
      'Player de audio no chat passou a respeitar melhor claro/escuro, evitar pausas indevidas e usar o avatar padrao do contato no preview da mensagem.',
      'Composer agora mantem foco de digitacao com mais consistencia, ganhou correcoes de z-index e resposta por duplo clique rapido na mensagem.',
      'Videos do historico passaram a aparecer apenas como thumb clicavel para abrir na tela cheia, e placeholders como `[audio]`, `[video]` e `[image]` deixaram de aparecer na conversa e na lista.',
      'Preview visual de mensagens respondidas foi enriquecido com bloco interno no estilo WhatsApp e passou a persistir melhor apos envio, reconciliacao e polling.',
      'Mensagens recebidas do cliente agora conseguem aproveitar melhor referencias de resposta quando a API devolve o id da mensagem citada.',
      'Respostas rapidas da tela de atendimento foram alinhadas com a mesma colecao usada na rota `/quick-replies`, deixando a gestao e o picker sincronizados.',
    ],
  },
  {
    id: '2026-05-06-chat-audio-recording-preview-player',
    version: 'v0.2.11',
    date: '2026-05-06',
    title: 'Audio no chat com gravacao, preview e player estilo WhatsApp Web',
    summary:
      'O atendimento passou a ter um fluxo mais completo para audio, com menu de anexos reorganizado, gravacao por microfone, preview antes do envio e player dedicado no historico.',
    items: [
      'Botao de anexo agora alterna de grampo para `+` e abre um menu com Documento, Fotos e videos, Audio e Contato.',
      'Clique unico no microfone inicia a gravacao, mostrando barra com indicador vermelho, tempo e waveform em tempo real.',
      'Ao parar a gravacao ou selecionar um arquivo de audio, o composer abre um preview com ouvir, cancelar e enviar antes da confirmacao.',
      'Mensagens de audio enviadas e recebidas agora usam player proprio com play/pause, seek na waveform e controle de velocidade compartilhado na sessao.',
    ],
  },
  {
    id: '2026-05-06-lightbox-fixed-stage-zoom',
    version: 'v0.2.10',
    date: '2026-05-06',
    title: 'Tela cheia de midia com palco fixo e zoom por scroll',
    summary:
      'A visualizacao ampliada de imagens e videos no chat foi refinada para manter uma area central fixa, deixando o zoom mais controlado e previsivel.',
    items: [
      'Imagens e videos agora abrem em um palco central com dimensoes fixas, sem crescer junto com o zoom.',
      'O scroll do mouse passou a atuar diretamente no zoom da midia, preservando a moldura visual da tela cheia.',
      'O visualizador ganhou proporcao mais proxima da referencia, com margens laterais visiveis e destaque maior para a midia.',
    ],
  },
  {
    id: '2026-05-06-chat-media-preview-and-lightbox',
    version: 'v0.2.9',
    date: '2026-05-06',
    title: 'Preview de midia, colar do clipboard e tela cheia no chat',
    summary:
      'O atendimento ganhou um fluxo mais completo para anexos, com preview antes do envio, suporte a colar imagem ou video e visualizacao ampliada das midias no historico.',
    items: [
      'Composer agora aceita multiplos anexos e abre um modal de preview com legenda, rotacao, enquadramento, texto, desenho e opcao HD para imagens.',
      'Colar imagem ou video com `Ctrl + V` no textarea passa a abrir automaticamente o preview de midia.',
      'Imagens, stickers e videos do historico agora podem ser abertos em tela cheia, com navegacao lateral, download e zoom por scroll.',
      'Arquivos e formatos ainda nao expostos pelo backend atual ficam bloqueados com aviso claro, evitando erro de envio no atendimento.',
    ],
  },
  {
    id: '2026-05-06-draft-priority-trigger-fix',
    version: 'v0.2.8',
    date: '2026-05-06',
    title: 'Rascunhos sobem no momento certo da lista',
    summary:
      'A priorizacao dos rascunhos foi corrigida para seguir o comportamento esperado do WhatsApp Web, sem antecipar a subida da conversa enquanto o usuario ainda esta digitando.',
    items: [
      'O rascunho continua sendo salvo durante a digitacao, mas so sobe para o topo ao sair da conversa com texto pendente.',
      'Se outra conversa receber mensagem mais nova, ela reassume a frente da lista e o rascunho perde a prioridade absoluta.',
      'O indicador visual de Rascunho continua persistido na lista ate o envio da mensagem ou a limpeza manual do texto.',
    ],
  },
  {
    id: '2026-05-06-chat-composer-emoji-actions',
    version: 'v0.2.7',
    date: '2026-05-06',
    title: 'Composer com emoji dedicado e atalhos reorganizados',
    summary:
      'O rodapé do chat foi refinado para separar melhor anexos, emojis e respostas rápidas, aproximando o fluxo de digitação do uso cotidiano no WhatsApp.',
    items: [
      'Botão de anexo permanece com o ícone de grampo no composer.',
      'Botão de emoji passou a usar o antigo ícone das respostas rápidas e ganhou picker simples para inserção no textarea.',
      'Botão de respostas rápidas voltou a usar o raio, mantendo o atalho por `/` no campo de mensagem.',
    ],
  },
  {
    id: '2026-05-06-whatsapp-web-attendance-flow',
    version: 'v0.2.6',
    date: '2026-05-06',
    title: 'Atendimento mais próximo do WhatsApp Web',
    summary:
      'A tela de atendimento ganhou tema claro/escuro, composer no estilo WhatsApp Web e nova lógica operacional para rascunhos, fixação e leitura.',
    items: [
      'Novo seletor de tema em Configurações com aplicação global do modo claro e escuro.',
      'Composer do chat redesenhado com visual mais próximo do WhatsApp Web e bolhas refinadas no atendimento.',
      'Menu de contexto da lista com fixar conversa, marcar como não lida e gerenciamento de etiquetas.',
      'Fixação e limpeza do status não lido passaram a responder de forma otimista e imediata na interface.',
      'Rascunhos agora aparecem na lista, sobem pela atividade mais recente e cedem posição quando outra conversa recebe mensagem nova.',
    ],
  },
  {
    id: '2026-05-05-labels-kanban-lightweight-flow',
    version: 'v0.2.5',
    date: '2026-05-05',
    title: 'Kanban de etiquetas mais leve e fluido',
    summary:
      'A tela de etiquetas e o kanban interno foram simplificados para reduzir peso visual, limitar a renderizacao por coluna e deixar a navegacao mais fluida.',
    items: [
      'Cards de lead ficaram mais compactos, com WhatsApp sempre visivel e acoes secundarias movidas para menu de contexto.',
      'Cada coluna do kanban passou a abrir 20 conversas por vez, com botao de carregamento incremental.',
      'Board, colunas e cards receberam memoizacao e filtros com callbacks estaveis para reduzir re-renders.',
    ],
  },
  {
    id: '2026-05-05-ptbr-accent-normalization',
    version: 'v0.2.4',
    date: '2026-05-05',
    title: 'Normalização de acentuação em PT-BR',
    summary:
      'Os textos recentes da interface e da documentação operacional passaram a seguir a grafia correta em português do Brasil.',
    items: [
      'Textos visíveis do shell, atendimento e telas novas foram revisados.',
      'A documentação operacional passou a exigir publicação com acentuação correta e codificação UTF-8.',
      'As próximas atualizações devem preservar a escrita natural em PT-BR na interface e nos arquivos de apoio.',
    ],
  },
  {
    id: '2026-05-05-lead-rule-trial-alignment',
    version: 'v0.2.3',
    date: '2026-05-05',
    title: 'Lead inclui números fora da base e trials',
    summary:
      'A etiqueta automática de lead passou a considerar tanto números sem correspondência na base quanto clientes marcados com `is_trial = Sim`.',
    items: [
      'Lead agora cobre contatos fora da base principal do NewBr.',
      'Clientes com `is_trial = Sim` também passam a cair em Lead, mesmo se estiverem na base.',
      'A etiqueta de lead continua tendo prioridade sobre as demais classificações automáticas.',
    ],
  },
  {
    id: '2026-05-05-lead-rule-newbr-alignment',
    version: 'v0.2.2',
    date: '2026-05-05',
    title: 'Lead alinhado à ausência na base NewBr',
    summary:
      'A etiqueta automática de lead passou a considerar qualquer número que não exista na base principal do NewBr.',
    items: [
      'A regra de lead não depende mais de `is_trial`.',
      'Toda conversa sem correspondência na base de clientes passa a ser classificada como lead.',
      'A descrição da etiqueta foi ajustada para refletir a regra operacional real.',
    ],
  },
  {
    id: '2026-05-05-label-store-snapshot-fix',
    version: 'v0.2.1',
    date: '2026-05-05',
    title: 'Correção do estado compartilhado de etiquetas',
    summary:
      'As telas de Atendimento e Etiquetas deixaram de entrar em branco por causa de um loop de renderização no catálogo de etiquetas.',
    items: [
      'Snapshot do store local de etiquetas passou a ser estável entre renders.',
      'Hook compartilhado de etiquetas deixou de recriar o estado interno a cada leitura.',
      'Atendimento e Etiquetas voltam a abrir normalmente com o mesmo catálogo local.',
    ],
  },
  {
    id: '2026-05-05-labels-kanban-operational-flow',
    version: 'v0.2.0',
    date: '2026-05-05',
    title: 'Etiquetas operacionais e visão kanban',
    summary:
      'O atendimento agora usa etiquetas derivadas da base de clientes, ganhou filtros por etiqueta e recebeu duas novas telas para organização operacional.',
    items: [
      'Nova tela de Etiquetas com visualização em cards e kanban, incluindo criação de etiquetas personalizadas.',
      'Tela de Atendimento passou a exibir etiqueta principal, filtro Todos/Não lidas e dropdown de etiquetas.',
      'Nova rota Visão Kanban agrupa as filas por serviço e mostra operadores visíveis em cada frente de atendimento.',
    ],
  },
  {
    id: '2026-05-05-attendance-query-cache-isolation',
    version: 'v0.1.5',
    date: '2026-05-05',
    title: 'Cache isolado entre dashboard e atendimento',
    summary:
      'A tela de atendimento deixou de reaproveitar imediatamente o cache visual do dashboard para evitar exibição de conversas mockadas durante a navegação entre rotas.',
    items: [
      'Dashboard e Atendimento agora usam query keys distintas para a consulta de conversas.',
      'A tela de atendimento passa a depender apenas da própria consulta e do fallback controlado de erro.',
      'Navegação de Dashboard para Atendimento deixa de antecipar dados visuais incorretos antes do carregamento real.',
    ],
  },
  {
    id: '2026-05-05-attendance-initial-loading',
    version: 'v0.1.4',
    date: '2026-05-05',
    title: 'Carregamento inicial sem mocks visíveis',
    summary:
      'A tela de atendimento agora prioriza o estado de carregamento na primeira abertura e não exibe conversas mockadas de cache antes da resposta real.',
    items: [
      'Lista de conversas mostra `Carregando conversas...` enquanto a primeira consulta ainda não terminou.',
      'Cache local de conversas passou a ser usado apenas como fallback em caso de erro de rede.',
      'Abertura inicial da tela deixa de antecipar conversas de teste antes da API responder.',
    ],
  },
  {
    id: '2026-05-05-attendance-scrollbar-trackless',
    version: 'v0.1.3',
    date: '2026-05-05',
    title: 'Scrollbar sem fundo no atendimento',
    summary:
      'O trilho acinzentado da scrollbar do atendimento foi removido para deixar apenas o thumb fino visível.',
    items: [
      'Track da scrollbar do atendimento agora é totalmente transparente.',
      'Scrollbar gutter local ajustado para não manter faixa visual desnecessária.',
      'Thumb fino preservado na lista de conversas, chat e painel lateral.',
    ],
  },
  {
    id: '2026-05-05-attendance-scrollbar-refine',
    version: 'v0.1.2',
    date: '2026-05-05',
    title: 'Scrollbar refinada no atendimento',
    summary:
      'A lista de conversas e as áreas roláveis do atendimento receberam uma scrollbar mais fina, moderna e sem trilho visível.',
    items: [
      'Scrollbars da lista de conversas, histórico de mensagens e painel lateral do contato agora usam track transparente.',
      'Thumb mais estreito com cantos totalmente arredondados para reduzir peso visual.',
      'Versão do shell atualizada automaticamente para refletir esta entrega no histórico.',
    ],
  },
  {
    id: '2026-05-05-sidebar-version-followup',
    version: 'v0.1.1',
    date: '2026-05-05',
    title: 'Refino do rodapé da sidebar',
    summary:
      'A divisão acima de Novidades foi removida e o selo de versão passou a seguir automaticamente a entrada mais recente do histórico.',
    items: [
      'Remoção da linha divisória acima do bloco de Novidades e Configurações.',
      'Label de build agora deriva da primeira entrada de `updateHistory`.',
      'Próximas atualizações devem refletir a versão diretamente no item mais recente do histórico.',
    ],
  },
  {
    id: '2026-05-05-shell-attendance-polish',
    version: 'v0.1',
    date: '2026-05-05',
    title: 'Ajustes iniciais de shell e atendimento',
    summary:
      'A navegação lateral foi reorganizada e a tela de atendimento recebeu refinamentos de proporção, scroll e reações.',
    items: [
      'Nova ordem da sidebar com Dashboard primeiro e Configurações fixada ao lado de Novidades no bloco final.',
      'Lista de conversas alargada para aproximar o layout do WhatsApp Web.',
      'Scrollbars globais redesenhadas e animação da pill de reações ajustada para nascer do ícone de ativação.',
    ],
  },
  {
    id: '2026-05-04-newbr-sync',
    version: 'v0.1',
    date: '2026-05-04',
    title: 'Base de clientes ligada ao NewBr',
    summary:
      'A tela de clientes deixou de usar dados sintéticos e passou a operar com sincronização persistida, importação via navegador e logs.',
    items: [
      'Sincronização browser-first usando o navegador atual para autenticar e coletar `/api/customers`.',
      'Persistência da base, do estado da sync e dos logs no backend local da VPS.',
      'Tabela atualizada com colunas reais de usuário, WhatsApp, revendedor, plano, conexões, vencimento e status.',
    ],
  },
  {
    id: '2026-05-04-whatsapp-brand',
    version: 'v0.1',
    date: '2026-05-04',
    title: 'Marca do shell atualizada',
    summary:
      'A assinatura visual do menu lateral deixou de usar a logo +TV e passou a exibir apenas WhatsApp.',
    items: [
      'Remoção do símbolo em cruz e do wordmark TV no topo da sidebar.',
      'Identificação textual única para o canal WhatsApp no shell.',
      'Publicação preparada para validação direta na VPS.',
    ],
  },
  {
    id: '2026-05-03-build-shell',
    version: 'v0.1',
    date: '2026-05-03',
    title: 'Barra global e histórico de atualizações',
    summary:
      'Adicionada navbar global com notificações e modal de histórico no shell da aplicação.',
    items: [
      'Nova AppTopbar abaixo do topo da página, integrada visualmente ao menu lateral.',
      'Histórico de alterações visível por modal no ícone de notificações.',
      'Exibição do build atual para validar publicação na VPS.',
    ],
  },
  {
    id: '2026-05-03-draft-flow',
    version: 'v0.1',
    date: '2026-05-03',
    title: 'Composer com envio consecutivo',
    summary:
      'O textarea agora limpa no envio imediato, sem apagar a próxima mensagem digitada quando a confirmação chega.',
    items: [
      'Limpeza otimista do campo ao enviar.',
      'Restauração do texto em caso de falha.',
      'Confirmação assíncrona não reseta mais o draft atual.',
    ],
  },
  {
    id: '2026-05-03-reaction-flow',
    version: 'v0.1',
    date: '2026-05-03',
    title: 'Reações no fluxo do chat',
    summary:
      'O badge da reação passou a ficar abaixo da bolha e a pill foi simplificada no estilo do WhatsApp Web.',
    items: [
      'Pill horizontal apenas com emojis e botão de mais.',
      'Badge de reação renderizado no fluxo normal da conversa.',
      'Preservação local da reação enquanto a API não devolve o payload completo.',
    ],
  },
  {
    id: '2026-05-02-context-menu',
    version: 'v0.1',
    date: '2026-05-02',
    title: 'Menu de contexto de mensagens',
    summary:
      'Criado menu contextual com atalhos para responder, reagir e consultar ações futuras.',
    items: [
      'Clique com botão direito abre menu dentro da área do chat.',
      'Atalhos para responder, reagir, encaminhar, info e excluir.',
      'Navegação por teclado com setas, Enter e Escape.',
    ],
  },
];

export const currentBuildLabel = updateHistory[0]?.version || 'v0.1';
