# Liberação das operações do Almoxarifado

O código da interface e as funções do banco são implantados separadamente no Lovable Cloud. Um teste local que simula RPCs não comprova que a função existe no servidor.

Antes de publicar uma versão que altere retiradas, devoluções, complementos, correções, cancelamentos ou outras operações do Almoxarifado:

1. Aplicar as migrações SQL pendentes no banco **do mesmo projeto usado pela prévia**, em ordem cronológica. Para esta correção, aplicar `20260914120000_atomic_supplement_corrections.sql` antes de `20260916120000_operational_requisition_corrections_and_cancellations.sql`.
2. Solicitar a atualização do cache PostgREST com `select pg_notify('pgrst', 'reload schema');`.
3. Executar [check-warehouse-rpcs.sql](../scripts/check-warehouse-rpcs.sql) no SQL editor desse projeto. **Não publicar** enquanto `ready_to_publish` não for `true` ou `blocked_rpcs` não estiver vazio.
4. Conferir na prévia uma operação de cada fluxo alterado, com registros temporários e reversíveis, e conciliar saldo, requisição e auditoria depois do teste. Não usar registros reais da obra apenas para teste.

A consulta confere as nove RPCs chamadas pelo cliente, a permissão do papel `authenticated` e a ausência de execução pelo papel `anon`. O teste `warehouseAtomicMigration.test.ts` exige que o manifesto acompanhe as chamadas da interface. A consulta deve ser repetida em cada ambiente de publicação; ela não depende da tabela de histórico de migrações, que pode não registrar aplicações feitas pelo SQL editor.
