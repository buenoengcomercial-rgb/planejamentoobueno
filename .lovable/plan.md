# Limpeza definitiva do Almoxarifado (preservando Equipamentos)

## O que encontrei nos dados atuais

Consultei as duas obras do banco:

| Obra | Materiais | Movimentações | Notas fiscais | Retiradas | Cautelas | Inventários | Equipamentos |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPA OBRA (obra aberta agora) | 0 | 0 | 0 | 0 | 0 | 0 | 6 |
| Planilha Orçamentária – Palácio Rio Madeira | 79 | 79 | 15 | 0 | 0 | 0 | 2 |

Ou seja: a obra que você está vendo (CPA OBRA) já está limpa — só tem os 6 equipamentos. Os dados de teste que restaram estão na obra **Palácio Rio Madeira** (79 materiais, 79 movimentações e 15 notas fiscais).

## O que vou fazer

1. Executar a limpeza dos dados de teste do Almoxarifado na obra **Palácio Rio Madeira**:
   - apagar materiais, movimentações, notas fiscais, vínculos de insumo, retiradas, cautelas, inventários e movimentos de estoque;
   - **preservar integralmente os 2 equipamentos** (nome, código interno, patrimônio, fotos e identificação);
   - equipamentos que estiverem "em uso" por cautelas apagadas voltam para "Disponível"; itens em manutenção ou arquivados mantêm o estado.
2. Registrar a limpeza na auditoria da obra, com autor e resumo do que foi removido.
3. Conferir depois da execução que os contadores ficaram em zero e que os equipamentos continuam intactos.
4. Confirmar que a obra CPA OBRA segue limpa e com os 6 equipamentos preservados.

Se você quiser que a CPA OBRA também passe pela limpeza (mesmo já estando vazia), ou que eu inclua as duas obras, me avise no comentário da aprovação.

## Detalhes técnicos

- A limpeza é uma operação de dados, feita diretamente no backend (Lovable Cloud) para esta obra: `DELETE` nas tabelas normalizadas `warehouse_movements`, `warehouse_requisitions`, `warehouse_custody`, `stock_movements` e remoção das coleções `items`, `fiscalNotes`, `materialLinks`, `inventorySessions`, `locations` de `projects.data_json->warehouse`, mantendo a chave `equipments` e normalizando o status dos equipamentos liberados.
- Nada de schema muda: sem migrações, sem alteração de tabelas, políticas ou telas.
- Nenhum código de aplicação é alterado — o botão "Administração › Limpar almoxarifado" continua funcionando como está para futuras limpezas.
- As fotos de equipamentos no Storage não são tocadas. Os arquivos de notas fiscais no Storage ficam órfãos após a limpeza; posso removê-los em uma etapa extra se você pedir.
