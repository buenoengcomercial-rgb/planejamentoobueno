# Retiradas com saldo negativo — decisão de 20/10/2026

## Contrato aprovado

- Novas retiradas, complementos e correções permitem saldo zero ou negativo em todas as obras. O aviso é informativo e não pede confirmação adicional.
- Quantidades da movimentação continuam positivas e finitas. Assinatura, destino, autorização, confirmação da nuvem, auditoria, isolamento por obra e limites de devolução permanecem obrigatórios.
- Enquanto a retirada original estiver em edição, a ação é **Salvar edição da retirada** e o formulário de complemento fica oculto. Atualizações da obra não apagam o rascunho.
- Cada submissão preserva sua identificação e seu conteúdo completo até a confirmação. Reenvio incerto repete o mesmo payload; recusa definitiva permite nova chave e conserva a tentativa recusada. Pendências de outra requisição não bloqueiam esta operação.
- Uma tentativa anterior incerta da mesma requisição é conferida com seu payload original antes de iniciar outra. Se confirmada, a nova edição permanece para revisão, com a base confirmada atualizada.
- Déficit existente não impede cadastros, entradas ou devoluções. Ajustes fora das requisições conservam a validação contra agravar saldo negativo.
- Avaliação mantém a quantidade assinada: entrada 10, retirada 15 e entrada 8 resultam em saldo 3. Custos ausentes permanecem incompletos; movimentos antigos não são recalculados pelo recebimento posterior.

## Fronteira de persistência e implantação

Requisição, movimentos e auditoria usam `commit_warehouse_requisition_v2` e suas funções internas. Nenhum autosave global é utilizado como alternativa. A migração `20261020090000_allow_negative_requisition_stock.sql` deve preceder a interface. É reaplicável sem alterar registros existentes.

A implantação pelo editor SQL do Lovable foi confirmada em 20/10/2026, na base da obra Palácio Rio Madeira. Antes da implantação, as quatro definições do servidor foram conferidas com as versões originais do repositório e preservadas em cópia local.

## Regressões

- `warehouseOperations.test.ts`: déficit, compensação posterior e assinatura obrigatória.
- `concurrentWarehouse.database.test.ts`: PostgreSQL real isolado, retirada concorrente sem duplicação, correção com estorno, complemento e correção/estorno, entrada parcial em déficit, devolução, permissões, rollback e quantidade não finita.
- `warehousePreparedAttempt.test.ts` e `warehouseOperationOutbox.test.ts`: replay exato, clique duplo, conteúdo alterado, recusa definitiva, pendências antigas e isolamento por requisição/conta.
- `WarehouseRequisitionsTab.test.tsx` e `WarehouseRequisitionsCloudCommit.test.tsx`: rascunho durante realtime, ações distintas, lista sem filtro de saldo e informação não bloqueante.
