# Lançamentos antigos no detalhe de quantitativos

Mudança solicitada: retirar o painel textual “Histórico preservado” e apresentar a quantidade diária antiga como linha editável, com “Dado preservado · DD/MM/AAAA” no comentário e a quantidade na coluna A.

## Fronteira de alteração

- A apresentação de um lançamento diário sem detalhe significativo usa uma projeção sem escrita ao abrir a tela. A fórmula Padrão considera somente A; B, C e D ficam zerados.
- O primeiro comando explícito de edição, exclusão, captura, recorte ou vínculo materializa o detalhe no lançamento original. A exclusão do detalhe zera sua quantidade, sem excluir a identidade do lançamento.
- O identificador, a data, as observações e a mão de obra permanecem no registro diário original. Não se cria outro lançamento de período para representar o mesmo valor.
- Detalhes existentes, fontes da planta, fórmulas e referências são mantidos. Registros por período continuam seguindo o fluxo anterior.
- Medições aprovadas ou em fiscalização e perfis de consulta continuam bloqueando edição. Validação de saldo, alterações compartilhadas, salvamento transacional das capturas e auditoria passam pelas operações existentes.
- A auditoria registra o conteúdo anterior completo; remover o painel de apresentação não remove o histórico recuperável.
- Novos quantitativos por período continuam independentes dos lançamentos diários antigos. Os totais somam cada registro uma vez.
- Não há migração do banco, publicação no Lovable nem alteração de arquivos operacionais neste ajuste.

## Validação

Regressões em `preservedProductionQuantity.test.ts`, `DailyLogsPanel.test.tsx`, `ProductionMeasurementPanel.test.tsx`, `TaskList.test.tsx` e `executionProtection.database.test.ts` cobrem projeção, edição sem escrita durante digitação, exclusão, recarga, limite, permissões, bloqueio fiscal, cópia, referência, captura e persistência PostgreSQL isolada. A prévia `.codex-temp/preserved/production.html` usa dados fictícios e armazenamento separado.
