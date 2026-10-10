# Medição independente na nuvem

A tela operacional reutiliza o mesmo MeasurementWorkspace da prévia: boletim editável acima da planilha, painel inferior de quantitativos e exportações compartilhadas. A ativação é registrada por obra no banco; o armazenamento local serve apenas a rascunhos e recuperação.

## Dados e gravação

- Incorporação inicial exige exportação integral conferida e comparação de quantidade/valor. Os registros originais de Produção, orçamento, auditoria e plantas não são reescritos.
- Uma transação confirma detalhes, referências, plantas, períodos e histórico. Revisão esperada e recibo idempotente impedem sobrescrita concorrente e repetição após resposta perdida.
- O servidor valida contrato, geometria, referências, permissões e bloqueios fiscais. Novos serviços dependem de snapshot aprovado do aditivo. Snapshot fiscal é conferido contra o mesmo cálculo financeiro utilizado na interface.
- Arquivos permanecem no bucket privado existente; histórico e backup têm as mesmas permissões da obra. Exclusão de referência não remove arquivos originais.
- A recuperação local é separada por usuário e obra. Uma falha nunca gera confirmação de salvamento.

## Instalação

Aplicar as proteções de execução 20261009140000/141000 e a conciliação 20261010015000 antes da ativação. A última preserva as intenções novas de exclusão da versão atual do Lovable. A migração 20261010020000 cria a base independente sem ativar obras automaticamente.

Cada incorporação operacional conserva backup no servidor e fora dele e verifica contagens/checksums antes e depois da transação. Nenhum payload de obra ou backup privado pertence ao repositório.

## Validação

132 testes focados: tela e boletim, medição por período, histórico, concorrência, recuperação, cópia/referência, captura transacional, envio fiscal, integração das proteções e sincronização da obra. TypeScript, lint dos arquivos alterados e build aprovados. Testes de banco executados em PostgreSQL isolado com PGlite.

## Sequência dos períodos

A primeira medição conserva o intervalo explicitamente definido para a obra. Por definição do usuário, no Palácio Rio Madeira ela vai de 24/08/2026 a 29/09/2026. Cada nova medição começa no dia seguinte à última e inclui exatamente 30 dias corridos: 2ª de 30/09 a 29/10; 3ª de 30/10 a 28/11. A interface mostra o intervalo calculado para confirmação, sem campos manuais; o servidor rejeita datas e numeração fora da sequência.

A correção do período inicial é pontual, com cópia anterior verificável, revisão esperada e histórico antes/depois; preserva identificadores, quantitativos, contrato e plantas. Não reclassifica lançamentos antigos por data nem altera os cronogramas. Cobertura: measurementPeriodSequence, measurementWorkspace, MeasurementWorkspace e measurementCloud.database.

## Proteção do acumulado e identificação

A migração `20261010040000` acrescenta validações sem reescrever registros: o número de um período existente é imutável e alterações de quantidade em períodos anteriores a um snapshot fiscal eram bloqueadas no fluxo inicial; a migração `20261010120000` restringe esse bloqueio às medições aprovadas. A mesma validação roda no cliente e no servidor e abrange exclusões, referências, capturas e desfazer. Comentários sem mudança de total e lançamentos em períodos posteriores continuam permitidos. Versões enviadas ficam arquivadas; durante a análise, a planilha usa os quantitativos atuais. A aprovação congela um novo snapshot validado com as quantidades aceitas.

O número do boletim é somente leitura na base independente. A seleção usa o identificador estável do período, lembrado neste navegador por usuário e obra, separado dos dados operacionais. Ao recarregar, a seleção só é restaurada se o período existir na carga confirmada; o painel inferior permanece vazio até selecionar uma quantidade. Um período novo só vira a preferência após confirmação do salvamento. Falhas no armazenamento de preferências não bloqueiam os quantitativos.


## Envio, aprovação e exclusão recuperável (10/10/2026)

Por decisão expressa do usuário, criar outra medição ou registrar o envio para análise não bloqueia os quantitativos do período anterior. O botão **Enviar para fiscalização** arquiva a proposta e marca **Em análise fiscal**. Detalhes, plantas e boletim continuam editáveis durante a análise; a quantidade atual pode ser reduzida ao valor aceito pelo fiscal. O histórico conserva a versão enviada e cada correção.

O botão **Aprovado pela fiscalização** exige confirmação e perfil de revisão. Ele valida e congela os valores atuais e o boletim em uma única transação. Medições aprovadas não podem ser reabertas, excluídas ou alteradas, inclusive por referências, geometria, desfazer ou um cliente antigo. A edição de períodos anteriores não pode mudar seu acumulado aprovado. Criar a próxima medição continua disponível.

**Excluir medição** arquiva somente a última medição ainda não aprovada, com motivo e conteúdo anterior recuperável no **Histórico → Restaurar medição**. A primeira e períodos incorporados são preservados. Restauração mantém identificadores, confere sequência de 30 dias, saldo, referências, coordenadas e permissões; não substitui período novo nem grava acima do contrato. Arquivos de planta permanecem armazenados.

A migração `20261010120000` altera validadores e funções, sem UPDATE/DELETE nos dados das obras. As mesmas permissões de obra, revisão esperada, recibos idempotentes e rascunhos continuam vigentes. Instalação requer backup integral verificável e conciliação do hash da base antes/depois.

Validação desta alteração: 126 testes de Medição (incluindo PostgreSQL isolado), TypeScript, lint dos arquivos alterados e build. Na cópia local de 402 serviços: 221 enviados → 220 corrigidos → 220 aprovados; valores aprovados e boletim bloqueados após recarga; 2ª medição de 30/09 a 29/10 criada, excluída e recuperável sem alterar a 1ª.
