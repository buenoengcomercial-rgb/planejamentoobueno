# Implementação integrada do Almoxarifado

## Fluxo entregue

`Notas fiscais → Materiais → Retiradas → Movimentações → Inventário → Equipamentos → Painel → Relatórios`

- `Notas fiscais` continua com validação humana antes da entrada e passa a exigir a decisão de vínculo com um insumo previsto ou a justificativa de material não previsto.
- `Materiais` funciona como catálogo canônico, admite vários insumos previstos no mesmo material físico, mostra os estados de vínculo e preserva itens arquivados para auditoria.
- `Retiradas` registra prédio/capítulo principal, equipe, recebedor, assinatura e de uma a três fotos. A busca mostra saldo e a confirmação congela o custo médio vigente.
- `Movimentações` é um extrato imutável e somente leitura, agrupado por operação de origem.
- `Inventário` usa sessões mensais com contagem cega, revisão, aprovação administrativa e aplicação idempotente dos ajustes.
- `Equipamentos` aceita até três fotos, sugestões por IA, revisão humana, código interno, etiqueta QR, arquivamento e fotos na devolução.
- `Relatórios` separa custo adquirido, custo consumido e valor atual do estoque.

## Regras de custo e rastreabilidade

- O método de avaliação é a média ponderada móvel.
- Cada retirada conserva o custo unitário vigente no momento da entrega.
- Compra e consumo são indicadores diferentes e não são somados entre si.
- Entrada, retirada e inventário têm identificador de origem e proteção contra repetição.
- O operador vem do login; recebedor e equipe continuam como informações operacionais distintas.
- Movimentos e materiais com histórico não são apagados definitivamente.

## Compatibilidade

- O estado continua persistido no JSON do projeto, sem migração obrigatória do banco.
- Requisições antigas continuam legíveis como registros legados.
- Movimentos sem origem explícita aparecem como `Registro legado`.
- Equipamentos antigos podem receber identificação e fotos posteriormente.
- Custos sem preço confiável aparecem como `Cálculo incompleto`.

## Validação técnica

- Testes de domínio cobrem média ponderada, retirada idempotente, vínculos, inventário e equipamentos.
- Testes da interface cobrem validação manual da nota, duplicidades, auditoria e visualização de documentos.
- A função Supabase `read-equipment` foi criada e registrada na configuração local. A tentativa de publicação em 17/08/2026 foi recusada porque o projeto `planejamentoobueno` estava com estado `INACTIVE`; após reativar o projeto Supabase, a função deverá ser publicada junto com a aplicação.
