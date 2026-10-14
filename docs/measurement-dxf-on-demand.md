# Medição: arquivos de planta sob demanda

## Fronteiras de dados

| Área | Leitura e alteração |
| --- | --- |
| Abertura da Medição | `load_measurement_workspace`, com todas as coleções, histórico, quantidades, fórmulas, escalas, pontos e referências. Zero chamadas Storage. |
| Detalhe numérico | Usa a base completa já carregada. Não resolve arquivos. |
| Visualizador | Resolve exclusivamente o ID e caminho privado imutável da planta ativa, confirmado no catálogo da obra. Sem RPC de gravação, revisão ou auditoria. |
| Importação | Continua exigindo Blob completo e upload imutável. Cadastro confirmado conserva o caminho e evita reenvio. |
| Edição, exclusão e Desfazer | Continuam passando pelos deltas, revisões, confirmações e validações existentes. Ausência de Blob nunca significa ausência de marcações. |
| Produção e backup de incorporação | Continuam exigindo arquivo completo. Hidratação explícita do codec fica disponível para exportações completas. |
| Cache | IndexedDB v2, mesmos stores e escopo de usuário/obra. Metadados novos preservam Blobs existentes apenas pelo mesmo ID e caminho. Falha de quota não invalida leitura confirmada. |
| Servidor e permissões | Nenhuma migração, política, função de negócio ou papel foi alterado. |

## Contratos de leitura

- `TakeoffPlan` exige Blob real; `RemoteTakeoffPlan` exige caminho confirmado e não tem arquivo; `TakeoffCatalogPlan` admite ambos explicitamente.
- O codec valida coleções completas e todos os caminhos, inclusive históricos, antes de adotar a base ou iniciar uma hidratação explicitamente solicitada.
- O visualizador ignora respostas de seleção, obra ou repositório anteriores. Fechar ou cancelar impede adoção da resposta pendente.
- Downloads da mesma identidade são compartilhados e reutilizados. Cache em memória limitado a 32 arquivos e 128 MiB; um arquivo individual maior continua íntegro. O cache local conserva arquivos já confirmados.
- Consulta da base e da revisão tem prazo de 30 segundos; recuperação local tem 5 segundos; arquivo grande tem prazo próprio de 15 minutos. Escritas continuam aguardando confirmação.
- Erro de consulta conserva a última base confirmada, mostra a causa e oferece repetição. “Sem internet” usa o estado offline do navegador; conexão do socket sozinha não comprova atualização.
- Revisão de leitura anterior à gravação confirmada é rejeitada. Recibo comprovado após perda de resposta confirma a operação sem duplicá-la.

## Validação

Testes automatizados exercitam abertura sem Storage, seleção única, navegação do gestor, troca de seleção/obra/conta, falha e repetição, caminhos inválidos, cálculos, marcações, exclusão, Desfazer, importação, recibos, prazos e preservação de cache. Testes PostgreSQL usam PGlite isolado, sem registros reais.

A comparação operacional deve usar a mesma obra e rota, cache HTTP frio/quente sem apagar rascunhos, desktop e celular simulado, bloqueando gravações de negócio. Resultado em navegador simulado não comprova desempenho em aparelho físico. Push ao GitHub e build local, por si só, não comprovam publicação no Lovable.

## Limite preservado

O JSON completo de histórico continua carregado. Sua redução exige outro contrato de leitura que conserve auditoria, revisão e validação fiscal. Esta entrega remove o download antecipado das plantas, sem truncar esse JSON.
