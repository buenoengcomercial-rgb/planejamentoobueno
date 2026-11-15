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

A restauração dos valores sintéticos revelou uma regressão adicional: o segundo estágio de um lote de digitação era recusado como conteúdo diferente antes de qualquer envio. Teste reproduziu a falha; o lote agora aceita novas células/valores antes do primeiro envio, mantendo as expectativas originais por registro. Depois do primeiro envio, conteúdo e ID continuam imutáveis. Os 176 testes focados de repositório, interface e edição passaram.

A finalização do backup real retornou `57014` especificamente na agregação dos checksums de 174 MB. A cópia por páginas havia terminado. Os hashes e tamanhos passam a ser calculados por registro durante a cópia e mantidos por gatilho privado. Backups anteriores recebem esses metadados por páginas; conversão sem checksums completos é bloqueada. O manifesto final continua conferido, assim como a igualdade entre cada registro preservado e sua origem. Não houve conversão nem exclusão na obra real.

## Resultado da homologação e preparação — 15/11/2026

PRs #150 a #153 integradas; revisão publicada `084af4a7fbaffd2b54c0c7d0c5a09cce84a51e49`. Lovable confirmou “Your website is up to date”. Migrações SQL até `20261115210000` instaladas. CI final: 248 arquivos, 1.778 testes aprovados, 1 skip preexistente, 15 testes de servidor, TypeScript, build e ESLint dos arquivos alterados aprovados.

Na versão publicada, duas células consecutivas foram confirmadas pela mesma operação: um POST de 1.710 caracteres, duas entradas, HTTP 200 em 581 ms. Após reabertura, os valores 11 e 12 continuaram confirmados, sem rascunho fantasma. A restauração para zero também foi confirmada e apareceu nas duas sessões. Esse tempo é uma amostra, não garantia de latência: durante concorrência, chamadas anteriores levaram cerca de 6 segundos. Os testes de campos distintos, disputa no mesmo campo, resposta perdida, reabertura e cliente antigo foram executados na obra sintética; nenhum lançamento real foi usado nesses testes.

Backup do Palácio Rio Madeira concluído e exportado: corte 690, checksum do documento `f61e5d45c30a3a2e0b25734cd87c4de3`. Conferidos 21 CSVs, seus SHA-256, os MD5 por registro, chaves únicas, contagens e manifestos. Documento materializado: 12.964.132 bytes; 552 eventos: 174.581.101 bytes; 261 recibos: 1.477.160 bytes. Manifestos: eventos `3884cd0c774ed67717618b390f1dd9d7`; recibos `4405449c2fdc1b0d24eb0697adb6bf58`. A exportação técnica fica fora do repositório e do carregamento da planilha.

Simulação integral na obra real, dentro de transação encerrada com **ROLLBACK**: 52,158 s; documento operacional de 1.002.530 bytes (redução de 92,27%), 542 serviços e ausência de `audit`. A comparação estrutural de todos os dados operacionais retornou igualdade; períodos e lançamentos das medições 1, 2, 3 e 4 também foram idênticos individualmente. Depois do rollback, nova consulta confirmou revisão 690, schema 1, 552 eventos e `converted=false`. Não houve conversão permanente da obra real nesta conferência.

Estado antes da confirmação final: cliente e banco preparados; testes publicados e backup aprovados; conversão permanente da obra real aguardava confirmação final de exclusão histórica. A proposta local 0 contra 11 no item 3.1.6 permaneceu fora da migração e dos testes: não escolher ou limpar automaticamente. A transação de conversão exige novamente revisão e checksum exatos; avanço da obra invalida este corte e exige novo backup.

Limpeza da homologação concluída: valores sintéticos restaurados para zero e conferidos nas duas sessões; abas temporárias fechadas; obra sintética `68be62d2-5473-4d3e-a6ed-35f01a20e801` e dependências removidas em transação restrita a esse ID/nome, com verificação do proprietário. Consulta posterior retornou zero obras para esse ID. Nenhuma obra operacional foi excluída.

## Conversão efetivada — Palácio Rio Madeira, 15/11/2026

Após confirmação explícita do proprietário, nova leitura confirmou revisão 690, schema 1 e backup com o checksum já exportado. A conversão protegida foi efetivada com `COMMIT`: revisão 691, schema 2, 542 serviços e ausência de `audit`. A transação durou 49,681 segundos, incluindo conferência integral do histórico/backup; esse é o tempo da migração única, não de uma gravação de célula.

A transação comparou todas as coleções operacionais e cada período antes de confirmar. Depois do commit, consulta independente verificou `converted=true`, zero eventos históricos operacionais, cinco versões fiscais deduplicadas, backup preservado (552 eventos e 261 recibos) e zero recibos técnicos ausentes entre os eventos removidos.

O documento operacional confirmado foi exportado novamente e comparado fora do banco com o backup verificado. Todas as propriedades operacionais, inclusive códigos, bancos, preços, fórmulas, referências e quantidades, permaneceram estruturalmente iguais. Documento: 12.964.132 → 1.002.530 bytes (−92,27%); MD5 operacional `ab8002017107dcccc33c256f6147d5bf`.

| Medição | Conjuntos de lançamentos por serviço | Linhas | Período e lançamentos iguais |
| --- | ---: | ---: | --- |
| 1ª | 173 | 265 | Sim |
| 2ª | 38 | 38 | Sim |
| 3ª | 69 | 82 | Sim |
| 4ª | 16 | 16 | Sim |

A tela aberta da 3ª medição continuou mostrando 542 itens. Os dois rascunhos locais então visíveis (6.9.1 e 6.9.6) e o aviso fiscal foram preservados: não houve recarga forçada nem escolha entre valor local/nuvem. O indicador “Aguardando envio” desses rascunhos não representa falha da conversão já confirmada. A conferência não afirma que essas propostas locais foram gravadas.

Evidências técnicas mantidas fora do repositório: backup `palacio-690`, resultado da conversão e exportação `palacio-691/operational.csv`, relatório independente `conversion-verification.json` e captura da tela. O backup não participa das consultas comuns da planilha.
