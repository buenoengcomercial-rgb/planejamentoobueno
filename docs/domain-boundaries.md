# Fronteiras de domínio da obra

Esta página registra a propriedade das gravações durante a migração. Uma aba pode
consultar dados de outras áreas para cálculo e exibição. Uma fotografia parcial
recebida pela interface não autoriza a substituir as coleções dessas áreas.

| Aba | Entrada visual atual | Gravação responsável | Situação de isolamento |
| --- | --- | --- | --- |
| Painel | `Dashboard.tsx` | Somente leitura | Gráficos carregados sob demanda; evitar recálculo em evento de outra área. |
| Rotina | `ManagementRoutine.tsx` | Tarefas e apontamentos de produção | Usa projeção operacional de aditivos; preservar edição local ao atualizar outras coleções. |
| Cronograma | `GanttChart.tsx` | Planejamento em tarefas e capítulos EAP | Cálculo de dependências delimitado em `useCalculatedProject`; separar controles, grade e comandos em entregas seguintes. |
| Produção | `DailyProductionWorkspace.tsx`, `TaskList.tsx` | Tarefas e apontamentos, com comando atômico de captura | Preservar quantidade, histórico e data de conclusão. |
| Medição | `Measurement.tsx`, `measurement/MeasurementWorkspace.tsx` | Medição incorporada: revisão e eventos próprios; legada: coleção `measurements` | A planilha incorporada recebe só a projeção analítica necessária e não renderiza novamente por mudança exclusiva do Almoxarifado. A versão legada ainda depende da conciliação da obra. |
| Diário | `DailyReport.tsx` | Registro da data em `daily_reports` | Rascunho e confirmação próprios; vínculo de retirada do Almoxarifado permanece como exceção de compatibilidade. |
| Aditivos | `Additive.tsx`, `AdditiveSchedule.tsx` | `additives` e coleções orçamentárias vinculadas | Comandos normalizados; planejamento da prévia não substitui execução. |
| Custos | `RealCost.tsx` | `subcontracts` | Transação normalizada do domínio. |
| Materiais | `Materials.tsx` | Orçamento, comparativos, composições e preços | Ajuste físico de estoque usa comando do Almoxarifado. |
| Almoxarifado | `warehouse/Warehouse.tsx` | Movimentos, requisições, cautelas e estoque | RPC própria ainda espelha dados em `projects`; manter `updated_at` até migração de todos os consumidores. |

## Coordenação comum

- `Index.tsx` continua compondo a obra e conserva as referências compartilhadas
  com a conciliação. A seleção e carga inicial da obra, incluindo permissões,
  rascunho pendente e detecção da Medição independente, ficam em
  `domains/sync/projectBootstrap.ts`. O agendamento, retry e tratamento inicial do autosave geral
  estão em `domains/sync/useProjectAutoSave.ts`, sem depender da aba visível. O
  canal Realtime está em `domains/sync/projectRealtimeChannel.ts`; rota e sessão
  visual estão em `lib/appUiSession.ts`.
- A escolha das coleções atingidas e a mesclagem da resposta remota estão em
  `domains/sync/remoteProjectReconciliation.ts`. O estado e a última versão
  confirmada são conciliados separadamente: uma atualização de outra área não
  confirma uma edição local ainda pendente. A apresentação do aviso geral está
  em `domains/sync/ProjectHeaderSyncStatus.tsx`; na Medição independente, falhas
  de outras áreas são identificadas como tais.
- `lib/projectOperations.ts` impede que Medição e Almoxarifado substituam a coleção
  um do outro durante a conciliação. A publicação de uma requisição no Diário
  continua autorizada temporariamente para manter o fluxo existente.
- `domains/schedule/useCalculatedProject.ts` conserva a árvore calculada quando
  apenas dados externos ao Cronograma mudam. Mudanças nas tarefas ou no calendário
  continuam invalidando o cálculo.
- O horário exibido como confirmado não avança por uma leitura remota de outra
  área enquanto existem edições locais pendentes.

## Arquivos extensos e próximos recortes

Contagem da cópia de trabalho em 20/10/2026 (linhas físicas):

| Arquivo | Linhas | Recorte funcional seguinte |
| --- | ---: | --- |
| `lib/warehouse.ts` | 5.100 | Separar nota fiscal, requisição/devolução, inventário, cautela e projeções de estoque, mantendo a API pública. |
| `pages/Index.tsx` | 3.559 | Extrair bootstrap da obra e orquestração das consultas remotas. Sessão visual, canal Realtime, agendamento do autosave, mesclagem da resposta e indicador já saíram. |
| `components/GanttChart.tsx` | 3.087 | Separar estado de filtros, grade temporal, edição de barras, calendário e comandos. |
| `lib/projectSync.ts` | 2.009 | Separar hidratação, snapshots e comandos normalizados por domínio. |
| `components/TaskList.tsx` | 1.692 | Separar lista visual, edição de produção e lançamento de quantitativos. |
| `components/measurement/MeasurementWorkspace.tsx` | 1.315 | Separar estado de rascunhos, fila de revisão, visual da planilha e ações fiscais. |
| `components/RealCost.tsx` | 1.298 | Separar cadastro de subcontratos, cálculos e painéis. |
| `components/ManagementRoutine.tsx` | 652 | Separar projeção semanal, edição e apresentação. |

Esses recortes devem ser migrados um fluxo por entrega, com testes de regressão
da operação alterada. A contagem de linhas por si só não mede desempenho; os
testes atuais verificam que a Medição incorporada não renderiza novamente e o
Cronograma conserva a árvore calculada após uma mudança exclusiva do estoque.

## Validação ainda necessária

O caso relatado com Kennedy precisa da identificação da obra, horário e modo de
Medição usado. As simulações locais cobrem a Medição independente durante a
alteração remota do Almoxarifado, sem gravação geral indevida ou perda do campo
em edição, e o rebase do quantitativo legado após conflito de versão. A
reprodução no Lovable operacional deve usar dados reversíveis e conferir
o status exibido, a revisão da Medição e a confirmação após recarga.

A retirada do espelho do Almoxarifado de `projects.data_json` requer migração
separada, após mapear leitores publicados e políticas no banco. Remover apenas a
atribuição explícita de `updated_at` da RPC não seria suficiente por causa do
gatilho da tabela.
