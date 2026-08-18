# Backlog priorizado — Almoxarifado

## Objetivo

Eliminar caminhos duplicados, reduzir decisões do operador e garantir rastreabilidade de entradas, retiradas, exceções e inventários.

Escala de esforço: `P` até 1 dia, `M` de 2 a 5 dias, `G` acima de 5 dias. As estimativas servem apenas para ordenar o trabalho e devem ser refinadas antes da implementação.

## Crítico

| ID | Melhoria | Critério de aceite | Esforço |
|---|---|---|---:|
| ALM-001 | Abrir o Almoxarifado em Notas fiscais e reordenar as abas | Ordem aprovada disponível no desktop e celular; rota recarregável | P |
| ALM-002 | Renomear Requisições para Retiradas | Todos os títulos, botões, estados vazios e comprovantes usam a nova nomenclatura | P |
| ALM-003 | Remover Entrada e Retirada do cadastro manual de Movimentações | Entrada normal nasce somente em NF; saída normal nasce somente em Retiradas | M |
| ALM-004 | Remover Excluir movimento | Nenhum perfil apaga movimento; correção ocorre por estorno | P |
| ALM-005 | Substituir exclusão de material por Arquivar e ocultar | Material com saldo ou histórico nunca é apagado; contador permanece disponível | M |
| ALM-006 | Remover Usuário e Almoxarife manuais | Criador e alterador vêm exclusivamente da sessão autenticada | M |
| ALM-007 | Bloquear retirada maior que o saldo | Sistema impede confirmação e identifica item e saldo disponível | M |
| ALM-008 | Tornar entregas e recebimentos idempotentes | Clique repetido ou nova tentativa não cria movimento duplicado | M |
| ALM-009 | Vincular todo movimento à origem | Cada linha abre NF, retirada, inventário ou exceção correspondente | G |

## Alta prioridade

| ID | Melhoria | Critério de aceite | Esforço |
|---|---|---|---:|
| ALM-010 | Simplificar Retiradas para entrega direta | Fluxo possui Cancelar e Entregar; não cria rascunhos invisíveis | M |
| ALM-011 | Substituir seletor de EAP por pesquisa agrupada | Não há opções duplicadas; busca por código e descrição funciona por teclado | M |
| ALM-012 | Exibir saldo durante a seleção dos itens | Código, unidade e saldo aparecem antes de adicionar o material | M |
| ALM-013 | Criar resumo antes da entrega | Mostra saldo anterior, entregue e saldo posterior por item | M |
| ALM-014 | Simplificar assinaturas | Login identifica operador; confirmação do recebedor é preservada | M |
| ALM-015 | Agrupar movimentos pela operação de origem | Uma NF ou retirada aparece como cabeçalho expansível com seus itens | G |
| ALM-016 | Criar filtros no extrato | Período, tipo, material, usuário e origem combinam entre si | M |
| ALM-017 | Padronizar ações de NF | Olho, detalhes e cancelamento possuem nome, tooltip, permissão e retorno claro | M |
| ALM-018 | Priorizar saldo na tabela de Materiais | Descrição, unidade, saldo e última movimentação ficam na visualização principal | M |
| ALM-019 | Criar sessão de inventário auditável | Início, término, contador, divergências, aprovação e movimentos ficam vinculados | G |

## Melhoria

| ID | Melhoria | Critério de aceite | Esforço |
|---|---|---|---:|
| ALM-020 | Criar filtros de Materiais | Grupo, estoque zerado e abaixo do mínimo funcionam juntos | M |
| ALM-021 | Sinalizar saldo incoerente ou movimento sem origem | Alertas abrem o registro que precisa de revisão | M |
| ALM-022 | Transformar Inventário em contagem cega | Diferença é exibida somente após o registro da contagem | M |
| ALM-023 | Explicar colunas de Equipamentos | Todas as colunas e ações possuem cabeçalho ou rótulo acessível | P |
| ALM-024 | Retirar edição de pagamentos do Painel | Painel abre a nota/fatura; alteração ocorre no contexto correto | M |
| ALM-025 | Simplificar o Painel | Primeira dobra contém somente alertas acionáveis e indicadores essenciais | M |
| ALM-026 | Nomear cada exportação | Botão informa relatório; arquivo informa obra, período e data de geração | P |
| ALM-027 | Padronizar mensagens e estados vazios | Mensagens explicam a situação e oferecem uma próxima ação | M |

## Evolução futura

| ID | Melhoria | Resultado esperado | Esforço |
|---|---|---|---:|
| ALM-028 | Leitura de código de barras ou QR | Localização e entrega de material mais rápidas no celular | G |
| ALM-029 | Contagem cíclica por grupo | Materiais críticos contados em frequência configurável | G |
| ALM-030 | Retirada recorrente ou modelo | Entregas frequentes podem ser repetidas com revisão das quantidades | M |
| ALM-031 | Locais físicos e transferências | Transferência registra origem, destino e duas pontas do movimento | G |
| ALM-032 | Indicadores de operação | Tempo de recebimento, retiradas, perdas, divergências e ajustes por período | G |

## Ordem recomendada de execução

### Etapa 1 — Segurança e fonte única

`ALM-001` a `ALM-009`.

Resultado: somente Notas fiscais cria entradas, somente Retiradas cria saídas normais e nenhum histórico pode ser apagado.

### Etapa 2 — Operação do funcionário

`ALM-010` a `ALM-014` e `ALM-017`.

Resultado: recebimento e entrega podem ser concluídos no celular com poucos campos e retorno claro.

### Etapa 3 — Auditoria e inventário

`ALM-015`, `ALM-016` e `ALM-019`.

Resultado: movimentos possuem origem rastreável e as diferenças físicas são conciliadas em sessão auditável.

### Etapa 4 — Informação gerencial

`ALM-018` e `ALM-020` a `ALM-027`.

Resultado: consultas, alertas, painel e relatórios ficam mais claros sem competir com a operação.

## Critérios gerais de aceite

- Um funcionário novo recebe e entrega material seguindo apenas o manual.
- Existe uma única porta normal de entrada e uma única porta normal de saída.
- Toda operação registra usuário, data, origem e impacto.
- Nenhum movimento ou material com histórico é excluído definitivamente.
- Cancelar, fechar ou falhar não prende o usuário nem cria saldo.
- Entrada, saída, estorno e ajuste são idempotentes.
- A operação funciona sem rolagem horizontal em 390×844.
- Ações principais têm alvo mínimo de 44 px, foco visível e nome acessível.
- Totais, saldos e histórico permanecem consistentes após repetição dos testes.

