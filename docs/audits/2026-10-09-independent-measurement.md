# Medição independente — entrega local de 09/10/2026

## Escopo e decisão

O pedido de centralizar os lançamentos na Medição substitui a decisão anterior de
usar Produção como origem. Esta entrega implementa o domínio independente e sua
prévia isolada. **Não ativa a mudança na obra real, não migra o banco remoto e não
publica no Lovable.** A Produção continua disponível. A ativação é explícita:
`Measurement.independentWorkspace`; nesse modo não existe chamada ao setter de
Project, leitura contínua de tarefas ou salvamento operacional.

## Fronteiras

| Área | Leitura | Gravação |
|---|---|---|
| Inventário inicial | Cópia de Project, plantas completas, rascunhos | Backup e candidato isolados |
| Medição independente | Serviços/preços/períodos próprios | Seu agregado e histórico |
| Captura | Arquivo compartilhado no capítulo | Geometria, célula, total e auditoria na mesma transação |
| Cronogramas/Produção/Diário | Não são consultados após incorporação | Nenhuma escrita na base da Medição |
| Aditivo aprovado | Snapshot aprovado/versionado | Somente novos serviços, uma vez |
| Exportação | Mesmas linhas calculadas para a tela | Arquivo Excel/PDF |

Serviços conservam identificadores de origem, ordem contratual, hierarquia, unidade,
contratado, preços e BDI. Quantidade simples é uma linha de memória de cálculo;
não há segundo campo persistido concorrente. Acumulado inclui a medição selecionada.
O motor financeiro existente fornece BDI, truncamento, totais e tratamento de preços
importados. Snapshots fiscais importados permanecem congelados e guardam o original.

Detalhes reutilizam a subtabela A–D. Arquivos reutilizam o visualizador atual,
incluindo PDF/imagem/DXF/DWF e suas limitações existentes. A propriedade das marcas
é explícita: obra + medição + serviço; referências intencionais são a única exceção
de visualização. O visualizador recebe um repositório próprio e a captura local usa
uma única gravação do agregado, sem salvar primeiro a planta.

## Persistência local e recuperação

Banco `measurement-workspace-v1`, stores `workspaces`, `backups`, `pending`, `drafts`.
Chave: usuário + obra. O adaptador aceita exclusivamente `environment: isolated`.
Não há fallback silencioso de nuvem para navegador.

- `workspaces`: catálogo, períodos, linhas, plantas, marcas, auditoria e revisão.
- `backups`: Project original completo, arquivos Blob, rascunhos e manifesto SHA-256
  do conteúdo e de cada arquivo. Verificação antecede a incorporação transacional.
- `pending`: candidatos de gravação preservados antes do commit; conflitos não
  substituem a versão confirmada. Rascunhos arquivados continuam recuperáveis.
- `drafts`: digitação e traçados não concluídos, identificados por período/serviço/linha.
- Commit compara revisão no próprio `readwrite` do IndexedDB, conserva auditoria e
  confirma sucesso somente em `transaction.oncomplete`.
- Copiar produz valores e geometrias independentes. Referências propagam em um único
  candidato, validam todas as ocorrências e não atravessam bloqueios fiscais.
- Excluir uma referência mantém as outras; restauração valida edições posteriores.

## Conciliação do conjunto isolado

Antes da incorporação: 3 serviços, 3 períodos, 1 lançamento diário, 221 unidades em
21/09/2026, 1 arquivo, nenhuma marcação. Depois: 3 serviços, mesmos 3 períodos,
uma linha A=221, comentário `Dado preservado · 21/09/2026`; 221 unidades e
R$ 2.762,50 na primeira medição. Diferença de quantidade: zero. Nenhuma quantidade
é novamente somada da Produção. IDs e data de origem permanecem no detalhe.

O planejador não escolhe destinos ambíguos: bloqueia períodos sobrepostos,
divergências entre detalhe e log/snapshot, vínculos de geometria inconsistentes,
referências discordantes, itens contratuais sem correspondência e marcas sem origem.
Os originais permanecem no backup; resolver essas pendências exige conferência.
A incorporação é idempotente e uma base inicializada não pode ser substituída por
uma nova cópia do Project.

**Este é um resultado de dados isolados. A obra real ainda não foi conciliada.**

## Aditivos

Somente novos serviços do snapshot aprovado são aceitos. A chave aditivo+composição
impede duplicação entre revisões/repetições. O cálculo reutiliza `computeAdditiveRow`
e a versão financeira aprovada. A vigência não pode incluir períodos fiscais fechados.
O fluxo atual de aditivos também trata acréscimo/supressão de serviços existentes:
esses casos são sinalizados e **não** substituem preços/quantidades da base própria.
Essa alteração contratual requer uma decisão adicional, fora da exceção autorizada.

## Validação realizada

- Fluxo real: selecionar A → contar 3 pontos → concluir → A=3, parcial/total=3,
  valor R$ 37,50 → recarregar → mesmos três pontos.
- Digitação manual, primeira/segunda/terceira medições, acumulado, exclusão e
  restauração de preservado, histórico com conteúdo anterior/posterior.
- Marcações de outro serviço não aparecem. Traçado pendente impede fechar sem
  concluir/cancelar; rascunho recupera a coluna e os pontos após recarga.
- Banco real do navegador: incorporação repetida, duas instâncias concorrentes,
  revisão divergente, falha de armazenamento na captura, nova tentativa, isolamento
  por usuário/obra e rascunhos de períodos distintos.
- Excel e PDF gerados pelo botão da tela: linha de placas 3 × R$ 12,50 = R$ 37,50;
  total do cenário após edição preservada e quantidade manual = R$ 3.150,00.
- Testes de domínio: cópia 29 permanece 29 quando origem/referência viram 30;
  bloqueios por saldo/fiscal/perfil; recortar; restauração com conflito;
  aditivo idempotente; inventário de 1.200 registros; paridade financeira/exportação.
- Suíte geral: 960 aprovados, 1 ignorado e 1 timeout no Dashboard. O teste do
  Dashboard passou na repetição isolada. Nenhuma alteração foi feita nesse módulo.
- Verificações finais: TypeScript, lint dos arquivos alterados, build e conferência
  do diff aprovados. Os testes focados abrangem 17 casos do novo domínio, 3 da
  interface, 23 do levantamento e 4 do detalhe de quantitativos.

## Pendências obrigatórias para ativação operacional

1. Implementar e instalar o adaptador remoto próprio, tabelas/RLS e RPCs do domínio
   da Medição, com validação no servidor de saldo, papel, snapshots, referências,
   vínculo das marcas e revisão. A transação deve incluir auditoria e recibo idempotente.
   **O adaptador entregue aqui é local; não valida concorrência entre computadores.**
2. O armazenamento remoto de arquivos deve reutilizar os objetos do capítulo, mantendo
   marcas da Medição em domínio próprio e protegendo arquivos usados por qualquer módulo.
3. Executar `supabase/audits/measurement_workspace_preflight.sql` com acesso apropriado.
   A consulta pública de capacidades em 09/10/2026 retornou HTTP 404 / PGRST202 para
   `measurement_workspace_capabilities`: a capacidade não está exposta/confirmada.
   Isso **não comprova** a ausência ou presença das proteções legadas no servidor.
4. Inventariar a obra real com paginação/contagens e revisão de origem confirmadas;
   conferir Storage, rascunhos de dispositivos e snapshots. Gerar backup verificável
   externo ao navegador antes de qualquer migração operacional.
5. Resolver pendências da conciliação real e ensaiar a migração remota em cópia
   isolada, incluindo interrupção/retomada, perda de resposta, offline e dois computadores.
6. Somente depois de validar esses pontos, ativar o novo domínio na rota operacional.

Não foi criada uma migração SQL incompleta que pudesse ser aplicada automaticamente.
O preflight é somente leitura. Testes locais, inclusive permissões simuladas, não
substituem validação das políticas efetivamente instaladas.

## Correção da apresentação conforme a tela já aprovada

A prévia passou a reutilizar `MeasurementHeader`, `MeasurementFilters`,
`MeasurementTable`, `MeasurementGroupRow` e `MeasurementItemRow`. Os grupos de
colunas, cores, tipografia, capítulos e subcapítulos são os da Medição existente.
O detalhe A–D entra na linha expandida e mantém sua largura dentro da área visível.
O adaptador de apresentação lê somente a base independente; não consulta Produção
nem o Cronograma. Código e banco passam a integrar o inventário inicial quando
disponíveis; registros anteriores sem esses campos continuam legíveis.

Validação após a correção: 50 testes focados, TypeScript do projeto da aplicação,
lint e build aprovados. No navegador: captura de três pontos, valores, recarga,
edição/exclusão/restauração, períodos, filtros, expansão de capítulos e rolagem
restrita à tabela em 390 × 844. Nenhuma migração ou publicação no Lovable.

## Acesso restrito à quantidade da medição atual

Na base independente, contrato, preços, subtotais, acumulado e saldo são campos
de consulta; seus cliques não abrem o editor. O detalhe e a planta são acessados
somente na célula Quant. Medição, no grupo Medição atual. O título do detalhe
identifica o período selecionado. Os valores acumulados continuam calculados
pelo motor já existente, incluindo os períodos anteriores e o selecionado.

Teste de regressão e navegador: 7 na primeira medição, captura de 3 pontos na
segunda, acumulado 10, contrato 400 inalterado e marcas recuperadas após recarga.
O detalhe continua usando A–D, com geração de ID próprio ao confirmar a linha
nova (sem persistir o identificador temporário da interface). Fluxo completo
e 48 testes focados aprovados, além de TypeScript, lint, build e diff.
