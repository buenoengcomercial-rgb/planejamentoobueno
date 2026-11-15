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
4. Consultar revisão e inventário. Para uma obra grande, chamar `begin_measurement_operational_backup(project_id, expected_revision)`, copiar as páginas de `copy_measurement_operational_backup_page(project_id, expected_revision, checksum, kind, after_key, max_bytes)` até retornar zero registros, para eventos e recibos, e concluir com `finish_measurement_operational_backup`. Cada chamada confere a revisão de corte; repetir uma página não duplica dados. A finalização e a conversão recusam páginas faltantes ou divergentes. `prepare_measurement_operational_migration` permanece compatível para bases pequenas. O backup privado inclui documento completo, eventos e pedidos antigos; não participa das leituras da planilha.
5. Exportar com `export_measurement_operational_backup(project_id, checksum)` para um arquivo técnico protegido. Backups novos mantêm eventos/recibos por registro em tabela privada, com manifesto, contagem e bytes; exportar também todas as páginas de `export_measurement_operational_backup_rows(project_id, checksum, kind, after_key, max_bytes)`, para `events` e `receipts`. Cada linha informa chave estável, JSON textual e MD5; a soma das páginas deve conferir com o manifesto antes da conversão. Um registro maior que o limite ocupa uma página sozinho. Conferir checksum/revisão e guardar a exportação fora da carga operacional. Não agregar os 174 MB de eventos em um único JSONB de backup.
6. Chamar `convert_measurement_operational_workspace(project_id, expected_revision, checksum)` somente após a validação. A transação bloqueia a revisão, confere o backup, extrai versões fiscais/recibos, compara todas as coleções expandidas e só então apaga eventos antigos. Divergência aborta tudo. A revisão avança uma unidade para invalidar caches antigos.
7. Comparar IDs, períodos, linhas, fórmulas, quantidades, valores, acumulados, situação fiscal e arquivos antes/depois. No Palácio Rio Madeira, comparar separadamente 1ª/2ª/3ª medições, sem editar lançamentos.

Rollback técnico usa o backup privado/exportado, com nova conferência exclusiva de revisão e dos recibos posteriores. Não há botão de restauração histórica na planilha e não se deve substituir automaticamente uma base que já recebeu novas edições.

## Evidência local

Teste PostgreSQL isolado com 542 serviços e fotografias sintéticas de coleções: 16.846.756 bytes antes, 252.118 bytes após conversão (98,5% de redução). Uma alteração enviou 822 bytes; 20 gravações mantiveram o documento sem auditoria e com crescimento abaixo de 2 KB. Durações locais observadas de gravação: aproximadamente 41–50 ms. Estes números não são medições da rede/banco do Lovable.

Os testes também conferem backup/checksum, rollback, períodos e totais idênticos, concorrência por campo, idempotência, cliente antigo, restrições de acesso, geometria, aprovação fiscal e versões fiscais sem duplicação nos recibos.

Status de liberação: registrar aqui a revisão publicada, os resultados no Lovable e o corte/backup de cada obra após a execução. Testes locais não autorizam declarar a obra real convertida.

Inventário em leitura no Lovable em 15/11/2026, antes da conversão do Palácio Rio Madeira: revisão 690, base 659, 542 serviços, 552 registros na tabela de eventos. Base armazenada: 12.925.117 bytes; auditoria: 11.929.087; lançamentos: 153.200; períodos: 438.740; serviços: 368.690. Estes tamanhos são do documento-base, antes de aplicar os 31 eventos posteriores.

Os campos before/after desses 552 eventos somam 174.407.821 bytes. Por isso a preparação do backup foi separada por registro e a exportação paginada. A conversão confere o manifesto e a igualdade dos registros históricos com o backup antes de remover qualquer evento.

Homologação em andamento: PR #150 (`520eb102`) publicada no Lovable; GitHub passou com 1.770 testes, 1 skip preexistente, TypeScript e build. Obra sintética `68be62d2-5473-4d3e-a6ed-35f01a20e801` convertida na revisão 2 → 3. Cliente novo gravou por `commit_measurement_operation_v2`, payload de 723 caracteres, sem chamada de recarga integral; cliente antigo foi recusado e preservou a proposta 9 contra 2 confirmado. Após atualizar o cliente e resolver esse rascunho, a nova edição revelou uma base antiga ainda retida em memória. O teste adicionado reproduziu revisão 2 em vez de 5; a correção libera somente a base da proposta resolvida. A validação concorrente deve ser repetida após publicar essa correção. Palácio Rio Madeira ainda não convertido.

PR #151 publicada: o painel do Lovable confirmou “Your website is up to date”. Duas sessões da obra sintética salvaram campos distintos (6 e 7), mantendo o terceiro valor (3); ambas convergiram. Em disputa simultânea no mesmo campo, a sessão vencedora confirmou 9; a outra preservou 8 como proposta e somente mudou para 9 após a escolha explícita. Um comando operacional usou 1.040 caracteres. A sessão A conciliou com recibos sem carga integral; a B fez uma leitura operacional para atualização remota.

Resposta perdida testada no navegador: a requisição retornou HTTP 200 no servidor, a resposta foi interrompida antes de chegar à aplicação, e o cliente recuperou a confirmação consultando `read_measurement_operation_receipts`. Houve apenas uma chamada de escrita. A interceptação foi removida ao concluir.

A preparação integral do backup real não concluiu (erro genérico do serviço); a consulta seguinte confirmou ausência de backup completo e revisão 690/schema 1 intactos. A materialização isolada retornou 12.964.132 bytes em 1,241 segundo. A preparação foi então dividida em chamadas com orçamento de bytes; não atribuir o erro a uma consulta específica sem evidência. A obra real continua aguardando backup exportado/conferido e conversão.
