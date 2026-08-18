# Profissionalização do Almoxarifado

Documentação operacional e backlog de melhorias do módulo `Estoque e Almoxarifado` do ObraPlanner.

Esta documentação começou com a inspeção autenticada da obra `CPA OBRA` em 17/08/2026. O fluxo integrado foi posteriormente implementado no código local; nenhum dado da obra publicada foi alterado por estes documentos.

## Documentos

1. [Manual operacional do funcionário](manual-operacional.md)
   - fluxograma do trabalho;
   - sequência das abas;
   - procedimentos de recebimento, consulta, retirada, exceções e inventário;
   - checklist diário.
2. [Matriz de auditoria dos botões](auditoria-botoes.md)
   - comandos existentes por aba;
   - risco ou dificuldade encontrada;
   - comportamento recomendado;
   - roteiro para validação funcional.
3. [Backlog priorizado de melhorias](backlog-melhorias.md)
   - itens críticos, de alta prioridade, melhorias e evoluções;
   - critérios de aceite e esforço estimado;
   - ordem recomendada de execução.
4. [Implementação integrada](implementacao-integrada.md)
   - regras entregues no domínio e na interface;
   - compatibilidade com registros antigos;
   - validações técnicas e etapa de publicação da função de IA.

## Decisões operacionais aprovadas

- O Almoxarifado deve abrir em `Notas fiscais`.
- A sequência principal será `Notas fiscais → Materiais → Retiradas → Movimentações → Inventário → Equipamentos`.
- A atual aba `Requisições` será transformada em `Retiradas`, com entrega direta e sem aprovação prévia.
- Entradas normais serão geradas por Notas fiscais.
- Saídas normais serão geradas por Retiradas.
- Movimentações será um extrato auditável somente leitura; exceções nascerão na operação de origem.
- Movimentos e materiais com histórico não poderão ser excluídos definitivamente.
- Usuário e operador serão identificados automaticamente pelo login.

## Referências de processo

- [Oracle Fusion Cloud SCM — Using Inventory Management](https://docs.oracle.com/cd/G31366_01/trans/G26527-01/using-inventory-management.pdf): separação entre recebimentos, solicitações de movimentação, transações concluídas e contagens.
- [Microsoft Dynamics 365 — Inventory journals](https://learn.microsoft.com/en-us/dynamics365/supply-chain/inventory/inventory-journals): separação entre recebimento, movimentação, transferência, ajuste e contagem física.
