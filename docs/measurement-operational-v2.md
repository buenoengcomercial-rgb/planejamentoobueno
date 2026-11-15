# Medição operacional v2

Decisão aprovada: retirar a auditoria do documento operacional e eliminar as fotografias históricas antigas. A interface deixa de oferecer restauração desses eventos. Lançamentos, fórmulas, acumulados, serviços, códigos, bancos, contrato e referências atuais a plantas permanecem íntegros. Diário e `projects.data_json` ficam fora da mudança.

## Implementação

- O documento de abertura/cache usa `schema: 2` e não contém `audit`. Os editores puros mantêm uma vista de compatibilidade com uma lista vazia; um evento transitório serve apenas para preparar o próximo comando. A confirmação volta à lista vazia.
- `measurementOperation` congela os registros afetados e os valores esperados na preparação. `commit_measurement_operation_v2` concilia campos, valida regras fiscais/geométricas/contratuais e grava estado e recibo na mesma transação.
- A RPC reutiliza os validadores existentes com uma vista transitória sem histórico. Essa vista não é exposta como estado confirmado. Nenhum registro de fotografia integral é acrescentado a `measurement_workspace_events`.
- `measurement_operational_receipts` guarda identificação, autor, revisão, ação e deltas por registro. As versões fiscais são deduplicadas por conteúdo em tabela privada; documento e recibos armazenados contêm referências. A leitura resolve apenas as versões necessárias aos cálculos atuais.
- Não existe leitura completa depois de um recibo consecutivo. Se faltar uma revisão, consulta-se uma janela de até 16 recibos; a base completa enxuta só é consultada quando há lacuna. Resposta incompleta/timeout mantém o comando; a tentativa seguinte consulta seu recibo antes de reenviar.
- Rascunhos e tentativas existentes não são limpos na conversão. Operações anteriores ao corte confirmadas continuam identificáveis pelos recibos compactados; as não confirmadas permanecem para revisão. O gatilho bloqueia gravações legadas na obra convertida, inclusive RPCs antigas.

## Fronteiras

| Recurso | Efeito |
| --- | --- |
| Medição | Estado operacional, recibos e metadados fiscais |
| Plantas | Preserva arquivos privados e seus caminhos; valida vínculos modificados |
| Diário, Produção, Cronograma e Almoxarifado | Nenhuma gravação |
| Permissões | Mesmos perfis de leitura/edição; conversão e exportação de backup só proprietário |
| Armazenamento local | Cache v2 sem auditoria; pendências em armazenamento separado |

## Implantação e conversão por obra

1. Publicar o cliente compatível antes de converter qualquer obra. Instalar a migração apenas disponibiliza funções/tabelas e não exclui dados. Há um guard compartilhado entre Supabase e Drizzle para não instalar duas vezes.
2. Em obra descartável de teste: validar duas sessões, campos distintos/iguais, recibo após resposta perdida, reabertura e cliente antigo. Restaurar os valores de teste e limpar a obra sintética ao terminar.
3. Conferir operações pendentes nos navegadores. Não escolher valores divergentes nem descartar tentativas para viabilizar a migração.
4. Consultar revisão e inventário. Chamar `prepare_measurement_operational_migration(project_id, expected_revision)`. O retorno informa checksum, bytes por coleção e eventos. O backup privado inclui documento completo, eventos e pedidos antigos; não participa das leituras da planilha.
5. Exportar com `export_measurement_operational_backup(project_id, checksum)` para um arquivo técnico protegido. Conferir checksum/revisão e guardar a exportação fora da carga operacional.
6. Chamar `convert_measurement_operational_workspace(project_id, expected_revision, checksum)` somente após a validação. A transação bloqueia a revisão, confere o backup, extrai versões fiscais/recibos, compara todas as coleções expandidas e só então apaga eventos antigos. Divergência aborta tudo. A revisão avança uma unidade para invalidar caches antigos.
7. Comparar IDs, períodos, linhas, fórmulas, quantidades, valores, acumulados, situação fiscal e arquivos antes/depois. No Palácio Rio Madeira, comparar separadamente 1ª/2ª/3ª medições, sem editar lançamentos.

Rollback técnico usa o backup privado/exportado, com nova conferência exclusiva de revisão e dos recibos posteriores. Não há botão de restauração histórica na planilha e não se deve substituir automaticamente uma base que já recebeu novas edições.

## Evidência local

Teste PostgreSQL isolado com 542 serviços e fotografias sintéticas de coleções: 16.846.756 bytes antes, 252.118 bytes após conversão (98,5% de redução). Uma alteração enviou 822 bytes; 20 gravações mantiveram o documento sem auditoria e com crescimento abaixo de 2 KB. Durações locais observadas de gravação: aproximadamente 41–50 ms. Estes números não são medições da rede/banco do Lovable.

Os testes também conferem backup/checksum, rollback, períodos e totais idênticos, concorrência por campo, idempotência, cliente antigo, restrições de acesso, geometria, aprovação fiscal e versões fiscais sem duplicação nos recibos.

Status de liberação: registrar aqui a revisão publicada, os resultados no Lovable e o corte/backup de cada obra após a execução. Testes locais não autorizam declarar a obra real convertida.

Inventário em leitura no Lovable em 15/11/2026, antes da conversão do Palácio Rio Madeira: revisão 690, base 659, 542 serviços, 552 registros na tabela de eventos. Base armazenada: 12.925.117 bytes; auditoria: 11.929.087; lançamentos: 153.200; períodos: 438.740; serviços: 368.690. Estes tamanhos são do documento-base, antes de aplicar os 31 eventos posteriores.
