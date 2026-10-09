# Correções de inicialização e proteção dos dados

## Escopo aprovado

Três frentes: integridade/Desfazer, abertura/recuperação e processamento da Rotina. Base `d4802cc`. Papéis, RLS, quantidades, calendários, períodos de medição e dados reais preservados.

| Área | Leitura e gravação | Fronteira e regressão |
| --- | --- | --- |
| Histórico | Resumos por entidade, páginas de 25; detalhes ao expandir | Leitura fora do Project editável. Auditorias novas confirmadas sem baixar antigas |
| Sessão/empresa/obra | Consultas existentes, prazo de leitura e repetição | Falha técnica separada de vínculo ausente; identidade/rota antiga não restaura acesso |
| Produção/Desfazer | Diferenças por registro/campo; intenção inversa nova | Produção deve estar carregada; demais vínculos verificados no servidor antes da escrita |
| Servidor | RPC invocadora, triggers, FK e índices | Deleção/auditoria atômicas; nenhuma política existente alterada |
| Diário | Gravação específica e rascunho por usuário/obra/revisão | Memória/exportação quando IDB falha; confirmação antiga não limpa revisão nova |
| Rotina | Cálculo completo em Worker; reutilização limitada à chamada | Sem truncar históricos/quantidades; cancelamento de resposta antiga e erro recuperável |

## 1. Integridade e Desfazer

- Desfazer continua baseado em deltas e valores esperados; não restaura a obra inteira. A reversão de uma criação gera intenção de exclusão da tarefa/capítulo/apontamento correspondente. Edições posteriores no mesmo registro bloqueiam reversão; outros campos/domínios permanecem intactos.
- Exclusão exige EAP/apontamentos confirmados. Dados não carregados de outras áreas são conferidos pela RPC `check_production_deletions`; não são tratados como vazios. Uma falha dessa conferência ocorre antes do PATCH do projeto.
- Exclusões da Produção passam exclusivamente pela transação com auditoria. Ausência da RPC não autoriza fallback por DELETE separado. Uma alteração mista precisa ser confirmada por domínio antes da exclusão.
- O servidor verifica produção, referências do documento e das tabelas normalizadas, intenção nova, fotografia do apontamento e vínculo da mesma obra. A FK dos apontamentos foi validada, pois a conferência global encontrou zero órfãos. Apontamentos não podem ser transferidos entre tarefas/obras.
- Escritas concorrentes de referências compartilham o bloqueio do projeto. Referências novas a tarefa excluída são rejeitadas; referências de aditivos pendentes continuam válidas antes da normalização da tarefa. Dados legados não são reescritos.
- A função existente de conclusão do Diário está ligada ao trigger novamente: Proprietário/Engenheiro concluem; somente Proprietário reabre; a exceção auditada de legenda do Proprietário permanece.

## 2. Abertura e recuperação

- Rotas operacionais não exigem `auditLogs` integral. Históricos/resumos e before/after são consultados sob demanda; não entram no snapshot editável. Rascunhos antigos preservam a união das auditorias sem baixar a coleção completa. Antes de salvar, IDs já confirmados são reconhecidos por uma consulta de identificadores; o conteúdo histórico não é reescrito e uma intenção antiga não autoriza nova exclusão.
- Autenticação e consulta da empresa propagam erros. Apenas uma consulta válida sem vínculo leva a “Acesso pendente”. Prazo de leitura de 30 segundos, ação de repetir e descarte de respostas antigas recuperam inicialização interrompida. Escritas continuam aguardando a confirmação real.
- A abertura/troca de obra deixa de executar a manutenção fiscal automática, que exigia todas as coleções e podia cancelar documentos durante a inicialização. Conferência e estornos explícitos de documentos arquivados permanecem no Almoxarifado.
- Falha de IndexedDB não impede uma tentativa de salvar o Diário na nuvem. A interface informa quando a cópia está somente na aba, permite baixar o rascunho e protege saída com edição pendente. Rascunho novo não é apagado pela confirmação de revisão anterior. Falha na limpeza local depois da confirmação não vira falso erro de gravação da nuvem.
- Salvamento parcial continua pendente até todos os registros/domínios necessários confirmarem; a resposta do documento principal não confirma o conjunto inteiro.

## 3. Processamento da Rotina e diagnóstico

O cálculo completo já otimizado pelo Lovable foi preservado e transferido para um Worker da rota. Navegadores sem suporte ou que não carreguem o Worker usam o mesmo cálculo completo localmente. Ele é encerrado em mudança de parâmetros/obra e ao confirmar. Falha/prazo gera mensagem e repetição, sem resultados antigos nem spinner sem fim. O indicador de salvamento carrega revisão/assinatura das fontes e data de build para comparar versões.

Ensaio em Node com dados fictícios: 500 tarefas, 60 dias, apontamentos diários e por medição, 2 aquecimentos, 7 amostras alternadas. Comparação com a função anterior a `a549728`:

| Medida | Anterior | Atual |
| --- | ---: | ---: |
| Mediana do cálculo | 1663,01 ms | 398,59 ms |
| Redução | — | 76,03% |

Saídas idênticas nas quatro comparações de semana/calendário/conclusão. Esse ensaio não mede abertura, rede, cache, interface ou aparelho físico. A matriz de abertura deve ser repetida na versão publicada, com as mesmas rotas da obra auditada e os mesmos perfis/cache.

## Validação e aplicação

- `npx vitest run --testTimeout=20000 --maxWorkers=2`: **955 aprovados, 1 ignorado, zero falhas**.
- `npm run test:server`: **10 testes**, Postgres isolado PGlite, incluindo RLS, chamadas diretas, rollback da versão/deleção, auditoria, vínculos, concorrência de versões e conclusão/reabertura. O motor isolado não reproduz múltiplas conexões de produção; o controle de bloqueio foi inspecionado no SQL.
- Mais 20 testes focados de Rotina/Worker/calendário passaram após a validação da recuperação local em navegador incompatível.
- TypeScript, lint sem erros, build e diff-check aprovados. Avisos existentes de Fast Refresh e tamanho de chunks permanecem.
- `node scripts/benchmark-weekly-routine.mjs`: geração reproduzível do ensaio; somente dados fictícios.
- As migrações `20261010010000`, `20261010011000` e `20261010012000` foram aplicadas ao Cloud em transação; podem ser reaplicadas sem regravar dados. Catálogo confirma trigger do Diário, proteções da Produção, FK validada e RPC invocadora com intenção auditada.
- Na obra Palácio Rio Madeira, antes/depois: **402 tarefas, 46 apontamentos, 40 Diários, 670 auditorias**; zero órfãos globais; mesma versão `2026-10-09T23:28:08.441337+00:00`. A assinatura de todas as políticas permaneceu `50b1c1377ed78209ab1a65626c646ec9`.
- Evidências locais em `output/correcoes-inicializacao-2026-10-09/`: relatório dos testes, leitura antes/depois e screenshot da conferência.

Nenhum teste criou, editou ou excluiu registros reais. A interface publicada ainda requer publicação no Lovable e nova medição comparável. Não foi usado chat/crédito do Lovable para implementar essas alterações.
