# Migração do estado do Almoxarifado para fora de `projects`

Levantamento do código em 24/10/2026. A primeira entrega cria `warehouse_project_state` como projeção transitória, sem alterar os leitores e escritores operacionais. As etapas de troca de fonte continuam pendentes.

## Conclusão do inventário

`projects.data_json.warehouse` não é apenas um espelho descartável. Movimentos, requisições e cautelas têm tabelas próprias, mas os demais campos de `WarehouseState` ainda são lidos e gravados diretamente no JSON da obra. Retirar somente o `jsonb_set` da RPC faria cadastros, notas fiscais e inventários desaparecerem após a recarga.

| Dados | Fonte atual | Leitores e escritores que precisam migrar |
| --- | --- | --- |
| Movimentos, requisições e cautelas | `warehouse_movements`, `warehouse_requisitions`, `warehouse_custody`; listas vazias no `data_json` | `projectSync.ts` hidrata as três coleções; RPCs de operação e `warehouseScopedCommit.ts` confirmam alterações. |
| Locais, recebedores, itens, equipamentos, grupos, notas fiscais, vínculos de materiais, apresentações de fornecedor, inventários e método de avaliação | `projects.data_json.warehouse` | `commit_warehouse_fields` lê os campos do JSON; `commit_warehouse_scope` os regrava; `loadCloudProject`, `mergeProjectMetadata`, `stripNormalizedCollections`, telas do Almoxarifado e projeções de outros domínios os consomem. |
| Revisão do Almoxarifado | `projects.warehouse_version` e `projects.warehouse_updated_at` | RPCs, idempotência, `warehouseLedgerVersion`, monitoramento remoto e `useWarehouseOperationCoordinator`. |
| Versão geral da obra | `projects.updated_at` | Autosave e conciliação geral. A transação do estoque a avança porque faz `UPDATE projects`; o gatilho `projects_set_updated_at` também a altera. |

### Dependências que impedem a remoção direta

1. `supabase/migrations/20261020090000_allow_negative_requisition_stock.sql`: `commit_warehouse_scope` lê `data_json.warehouse` e o grava novamente; operações de requisição também atualizam a linha de `projects` para avançar a revisão do estoque.
2. `supabase/migrations/20261016121000_concurrent_warehouse_fields.sql`: a RPC V2 mescla alterações por campo contra `project.data_json.warehouse`, inclusive na repetição idempotente.
3. `supabase/migrations/20260912230000_version_atomic_warehouse_operations.sql`: um gatilho avança `warehouse_version` quando um cliente legado altera o JSON.
4. Triggers de `projects` validam permissões do operador, exclusões/alterações históricas e duplicidade de NF usando `data_json.warehouse` (`20260819225720_...`, `20260902120000_...`, `20260907100000_...`). A nova fonte precisa manter essas garantias no servidor.
5. `src/lib/projectSync.ts` preserva os campos não normalizados no payload geral e os mescla ao receber metadados. `src/lib/cloudProjects.ts` carrega a obra a partir desse payload. `src/lib/warehouse.ts` ainda migra `stockMovements` legados para a projeção do Almoxarifado.
6. `supabase/functions/storage-maintenance/index.ts` varre anexos dentro de `projects.data_json`; quando notas/equipamentos mudarem de fonte, a manutenção de anexos também deverá ler a nova tabela.
7. `projectUpdatedAt` faz parte das respostas das RPCs e atualiza a referência de versão na interface. A mudança de contrato exige adaptação conjunta do cliente, sem usar um timestamp antigo como confirmação de salvamento geral.

## Sequência proposta

1. **Criar a projeção separada do estado ainda guardado no JSON.** A migração `20261024203000_warehouse_project_state_shadow.sql` cria uma tabela por obra com os campos não normalizados e a revisão atual. Um gatilho a mantém sincronizada na mesma transação do escritor existente. A tabela ainda não é a fonte oficial; não recebe escrita direta dos clientes. Comandos próprios com as garantias atuais virão antes da troca de fonte.
2. **Conferir a cópia inicial.** A primeira migração já copia os campos de `data_json.warehouse` para a projeção e a mantém atualizada na mesma transação. Antes de escolher a nova fonte como leitura principal, comparar por obra contagens, versões e conteúdo dos registros na base operacional. Não descartar o JSON antigo nesta etapa.
3. **Atualizar leituras e gravações.** `projectSync`, carga inicial, hidratação seletiva, RPCs V1/V2, reconciliação, manutenção de anexos e clientes legados devem passar pela nova fonte. Requisições e operações críticas continuam atômicas com livro de movimentos, cautelas e auditoria.
4. **Separar a revisão.** Mover `warehouse_version` e `warehouse_updated_at` para a fonte do domínio e fazer o monitoramento observar essa revisão. Somente depois de eliminar todo `UPDATE projects` das transações exclusivas do estoque será possível deixar `projects.updated_at` estável nessas operações.
5. **Desligar o espelho.** Após validar clientes publicados e recuperação de rascunhos, parar a dupla escrita, conservar backup reversível e então remover os leitores e gatilhos legados do JSON em uma migração própria.

## Critérios antes de executar a migração

- Requisição, entrada fiscal, inventário, cautela e ajuste confirmam saldo, anexos e auditoria juntos; repetição com a mesma chave não duplica a operação.
- Operador de Almoxarifado mantém exatamente as permissões atuais; ações exclusivas do Proprietário e proteções de histórico continuam impostas pelo servidor.
- Uma operação exclusiva do estoque não altera `projects.updated_at`; uma gravação geral pendente em outra aba continua a confirmar ou apresentar conflito apenas quando houve mudança no mesmo dado.
- Carga inicial, troca de aba, recarga, clientes legados e restauração de rascunhos mantêm os dados antigos e novos visíveis.
- Testes locais de regressão e validação com dois usuários na versão publicada do Lovable usam lançamentos identificáveis e reversíveis, com conferência após recarga.

Não remover a atribuição explícita de `updated_at` isoladamente: o gatilho `projects_set_updated_at` avança esse campo em qualquer `UPDATE projects`.
