# Proteção de Produção e Medição — 09/10/2026

## Escopo e situação

Implementação em branch isolada `codex/protect-production-measurement-current`.
Nenhuma publicação no Lovable, migração remota, restauração ou alteração dos dados da obra foi executada.
As proteções de servidor somente passam a valer no ambiente real após instalação e verificação das duas novas migrações.

## Fronteiras protegidas

| Risco reproduzido | Proteção implementada | Evidência |
| --- | --- | --- |
| Cronograma muda período e oculta quantidade | Remoção da sincronização Gantt → Medição; escrita de planejamento restrita no cliente e RPC | Testes de operações, datas e PostgreSQL |
| Desfazer restaura a obra inteira | Patch inverso por identificador sobre estado atual; conflito posterior bloqueia; histórico permanece | `projectOperations.test.ts` |
| Edição baseada em cópia antiga | Merge de três versões no cliente e comparação de versão no servidor | Testes de operações e concorrência SQL |
| Envio fiscal 30 → 29 | Itens, resumo dos Diários, status, histórico e auditoria em uma atualização/transação; congelamento fiscal no servidor | Hook de Medição e PostgreSQL |
| Carga de 1.000/1.200 aceita | Paginação de 500 com contagem exata, identificadores únicos, revisão antes/depois e conferência de vínculos | `projectSync.verifiedPages.test.ts` e hidratação |
| Exclusão inferida | Auditoria explícita por registro, vínculo de tarefa/período imutável, caminho genérico bloqueado | Cliente e triggers/RPCs SQL |
| Planta e célula gravadas separadamente | RPC conjunta com saldo, períodos, geometria, referências, auditoria e versão da planta | PostgreSQL real em memória; componente de captura |
| Resposta de captura perdida | Rascunho IndexedDB com arquivo, estado anterior, geometria e pedido idempotente; recibo no servidor | Testes de IndexedDB e repetição SQL |
| Rascunho expira ou é substituído | Sem expiração automática; divergência pede revisão antes de confirmar | `DailyLogsPanel.test.tsx` |

Produção é a origem do quantitativo. A Medição consulta a produção por período; lançamentos diários antigos continuam sendo consultados pelo intervalo. O número e as datas são definidos na Medição. Alterações de quantidade contratada e orçamento não fazem parte desta entrega.

Referências compartilhadas validam todas as tarefas e gravam juntas. Histórico de execução é acrescentado; a tabela de recuperação captura integralmente o conteúdo anterior e posterior com o usuário real, sem permitir edição pelo cliente. Registros acima do contrato já existentes podem ser reduzidos para correção; não são truncados automaticamente.

## Verificação isolada

- Migrações executadas em PostgreSQL PGlite, com tabelas de teste, RLS de Produção/Medição e políticas existentes: saldo, permissões, três períodos, concorrência, referências, envio fiscal, exclusão recuperável, geometria, rollback e resposta perdida.
- Testes de interface usam os componentes reais; a prévia de navegador tem obra, arquivos e chaves de armazenamento exclusivos, sem acesso aos dados operacionais.
- Uma asserção antiga sobre texto SQL foi ajustada para normalizar CRLF do Windows. O teste de Cronograma agora exige preservação do nome da obra e alteração somente da data prevista.
- Comandos de verificação: `npx vitest run --maxWorkers=2 --testTimeout=15000`, `npx tsc -p tsconfig.app.json --noEmit`, lint dos arquivos alterados, `npm run build`, `git diff --check`. O timeout de 15 segundos evita o timeout de 5 segundos do teste de carregamento tardio dos gráficos sob concorrência de build; nenhum timeout de produto foi alterado.
- Suíte completa: **140 arquivos aprovados; 929 testes aprovados e 1 ignorado**. Os 12 testes PostgreSQL passaram. TypeScript, lint dos arquivos alterados, build e diff aprovados; o build mantém o aviso de bundles acima de 500 kB.
- No navegador, a contagem de **3 pontos** preencheu A, parcial, subtotal e total da 1ª medição. A 2ª recebeu **4** e a 3ª **5**. Alterar e desfazer os dois planejamentos preservou datas e quantidades. A recarga preservou os três totais e as marcações; zoom, deslocamento pelo botão central e enquadramento foram conferidos.
- Capturas locais: `output/protection-three-periods.png` e `output/protection-restored-points.png`. Prévia isolada: `http://127.0.0.1:5181/.codex-temp/protection/production.html`.
- A inspeção revelou rolagem automática ao focar o SVG entre pressionar e soltar o mouse. O foco agora preserva a rolagem, evitando deslocar a coordenada clicada; incluída regressão específica e repetida a contagem visual.
- O teste visual utiliza o catálogo local isolado; não simula uma confirmação de nuvem. O comportamento transacional e as falhas de rede/resposta são cobertos pelos testes PostgreSQL e clientes simulados. Não foram usados dois computadores físicos nem dados da obra real.

## Instalação posterior segura

1. Fazer backup integral consistente do banco, arquivos privados das plantas e inventário de objetos. Registrar contagens, identificadores, hashes e versão; testar a restauração em ambiente separado. Uma cópia apenas no navegador não é backup da nuvem.
2. Executar `supabase/audits/execution_protection_preflight.sql` na cópia restaurada. Conciliar registros órfãos e períodos inconsistentes sem exclusão inferida. Não renumerar nem trocar identificadores antigos.
3. Aplicar `20261009140000_protect_execution_history.sql` e `20261009141000_atomic_capture_and_scope.sql` na cópia, validar permissões reais e conferir funções, triggers ativos, FK e RLS. Preservar a listagem anterior para comparação.
4. Repetir os cenários com os dados reais restaurados, dois clientes e falhas de conexão. Comparar registros, arquivos e snapshots antes/depois. Somente então instalar cliente e servidor no ambiente real numa janela coordenada.

Não há recuperação automática de dados já perdidos nesta implementação. A conciliação integral do banco real, a instalação remota e a certificação da restauração do backup permanecem pendentes; nenhuma garantia absoluta de ausência de perda é feita.

## Limites deliberados

Uma transação crítica com mais de 500 alterações ou mistura de domínios sem RPC conjunta falha e conserva o rascunho; não usa salvamento genérico como alternativa. Uma marcação antiga sem tarefa/lançamento válido exige conferência do histórico antes de alteração. Operações sem as novas RPCs instaladas falham com mensagem, preservando a cópia anterior.
