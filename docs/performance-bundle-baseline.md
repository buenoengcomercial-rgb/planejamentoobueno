# Linha de base do carregamento

Medição de referência executada em 13/09/2026 com `vite build`, antes da otimização progressiva.

| Pacote | Minificado | Gzip |
| --- | ---: | ---: |
| Aplicação principal (`index`) | 1.119,51 kB | 336,54 kB |
| Dashboard | 427,23 kB | 115,55 kB |
| Almoxarifado | 363,16 kB | 98,36 kB |
| XLSX principal | 429,03 kB | 143,08 kB |
| XLSX com estilos | 627, liberado sob demanda | 322,92 kB |
| PDF (`jspdf`) | 458,39 kB | 135,97 kB |

## Regras da otimização

- Não alterar cálculos, persistência, transações, idempotência ou auditoria.
- PDF, Excel e leitura de arquivos devem ser carregados somente quando usados.
- Almoxarifado deve manter as mesmas operações atômicas e bloqueios de concorrência.
- Cada etapa deve registrar o resultado do build e preservar testes de regressão.

## Metas

- Primeiro corte: reduzir pelo menos 20% do pacote principal.
- Meta acumulada: reduzir pelo menos 30% do JavaScript inicial compactado.
- Pacotes grandes de PDF/XLSX são aceitos somente quando isolados e sob demanda.

## Resultado da primeira rodada

Medição após separar rotas, núcleo do Almoxarifado, subabas e gráficos:

| Pacote | Minificado | Gzip | Comportamento |
| --- | ---: | ---: | --- |
| Entrada comum (`index`) | 541,40 kB | 161,07 kB | Sempre carregado |
| Aplicação autenticada (`Index`) | 395,72 kB | 122,99 kB | Somente nas rotas da obra |
| Dashboard essencial | 14,00 kB | 4,56 kB | Carrega antes dos gráficos |
| Gráficos do Dashboard | 414,78 kB | 111,93 kB | Carregamento ocioso após a primeira pintura |
| Estrutura do Almoxarifado | 10,15 kB | 3,72 kB | Somente ao abrir o módulo |
| Núcleo operacional do estoque | 96,42 kB | 28,80 kB | Compartilhado pelas operações |
| Subabas do Almoxarifado | 8,58–87,35 kB | 3,04–21,70 kB | Somente a área selecionada |

Na abertura do Dashboard, o caminho crítico antes dos gráficos caiu de aproximadamente 452,09 kB gzip (`index` + Dashboard antigo) para 288,62 kB gzip (`index` + `Index` + Dashboard essencial), redução de **36,16%**. Os gráficos mantêm os mesmos dados e aparecem após o navegador liberar a primeira pintura.

No Almoxarifado, o antigo pacote único de 98,36 kB gzip foi substituído por uma estrutura de 3,72 kB e subabas independentes. PDF, `jspdf` e leitura fiscal permanecem fora da abertura comum e são solicitados apenas pela área ou ação correspondente.

## Resultado da etapa 3 — documentos sob demanda

A auditoria do grafo de importações confirmou que `jspdf`, `jspdf-autotable`, `pdfjs-dist`, `xlsx` e `xlsx-js-style` não são dependências da entrada comum. Os motores permanecem em pacotes próprios e são alcançados somente pelas ações de importar, exportar, imprimir ou gerar recibo.

Foi corrigida a última fronteira antecipada encontrada na jornada comum: a tela de Produção importava o `ImportSyntheticDialog` estaticamente mesmo fechado. Agora o diálogo é criado por `lazyWithReload` somente depois de **Atualizar planilha**. O manifesto de produção registra:

- `TaskList` com `ImportSyntheticDialog` apenas em `dynamicImports`;
- `ImportSyntheticDialog` como o consumidor isolado do `xlsx` usado na importação;
- o gerador `warehouse/pdf` como consumidor isolado de `jspdf` e `jspdf-autotable`;
- nenhuma dependência pesada de documentos nos imports da entrada `index.html`.

Os tamanhos dos motores não mudaram — o objetivo desta etapa é evitar o download antes do uso:

| Motor isolado | Minificado | Gzip | Momento de carregamento |
| --- | ---: | ---: | --- |
| XLSX de importação | 429,03 kB | 143,08 kB | Após abrir a importação |
| XLSX com estilos | 627,18 kB | 322,92 kB | Ao exportar relatório formatado |
| jsPDF | 390,27 kB | 128,72 kB | Ao gerar PDF/recibo |
| PDF utilitário | 458,39 kB | 135,97 kB | Ao processar documento correspondente |

Testes de arquitetura protegem as fronteiras da Produção, Diário, Medição e Almoxarifado contra a reintrodução de imports estáticos dos motores.

## Resultado da etapa 4 — núcleo autenticado mais leve

O `Index.tsx` deixou de carregar e calcular a projeção operacional dos aditivos em todas as páginas. A projeção, seus controles e a mesclagem segura com o projeto-base agora pertencem a adaptadores exclusivos do Cronograma e da Rotina. Dashboard, Produção, Diário, Medição, Custos, Materiais e Almoxarifado não baixam mais esse núcleo antes de precisar dele.

A leitura do calendário da obra também foi separada da interface de configuração: o núcleo leve mantém exatamente a mesma normalização e compatibilidade com obras legadas, enquanto diálogos, seletores e dados de feriados permanecem no pacote técnico que realmente os utiliza.

| Pacote | Antes | Depois | Redução |
| --- | ---: | ---: | ---: |
| Aplicação autenticada (`Index`), minificado | 395,87 kB | 284,09 kB | 28,24% |
| Aplicação autenticada (`Index`), gzip | 123,02 kB | 89,13 kB | 27,55% |
| Abertura do Dashboard antes dos gráficos, gzip | 288,69 kB | 254,90 kB | 11,70% nesta etapa |

Comparado à linha de base de 452,09 kB gzip para a abertura do Dashboard, o caminho essencial acumulado está em 254,90 kB gzip, redução total de aproximadamente **43,62%**. O pacote `additiveSchedule` ficou isolado em 7,38 kB gzip e é solicitado apenas nas jornadas que precisam da projeção.

Testes funcionais confirmam que alterações feitas sobre a projeção continuam sendo mescladas no projeto-base pelas mesmas regras, preservando tarefas contratuais, rascunho do aditivo, produção e dependências.

## Resultado da etapa 5 — importações estáticas e dinâmicas coerentes

A auditoria das fronteiras eliminou carregamentos que anulavam o benefício do `import()`:

- os oito geradores de relatório do Aditivo deixaram de ser importados pela tela e agora são carregados somente ao executar uma exportação;
- o pequeno adaptador de PDF do Almoxarifado também deixou de importar `jspdf` e `jspdf-autotable` estaticamente: primeiro abre-se a ação de recibo, cautela, inventário ou confirmação diária e só então os motores são baixados;
- dependências já presentes no núcleo compartilhado, como a identidade visual e o cliente da nuvem, deixaram de ser solicitadas novamente por importações dinâmicas sem efeito;
- o XLSX continua isolado em pacote próprio. A leitura síncrona usada pelo diálogo de importação só alcança esse pacote depois que o próprio diálogo, que é lazy, for aberto; as demais exportações continuam acionando-o explicitamente.

| Pacote | Antes | Depois | Resultado |
| --- | ---: | ---: | --- |
| Tela do Aditivo, minificado | 170,86 kB | 133,43 kB | -21,91% |
| Tela do Aditivo, gzip | 47,44 kB | 37,02 kB | -21,96% |
| Relatórios do Aditivo, gzip | incorporado à tela | 10,86 kB | somente após exportar |
| Adaptador PDF do Almoxarifado, gzip | 2,68 kB | 2,87 kB | motores continuam fora do adaptador |

O manifesto confirma `additiveReports` como `dynamicImport` da tela do Aditivo e `jspdf`/`jspdf-autotable` como `dynamicImports` do adaptador de PDF. O build não apresenta aviso de módulo simultaneamente estático e dinâmico. Permanece o aviso genérico para pacotes acima de 500 kB: o XLSX com estilos está isolado por decisão e o pacote externo principal será tratado na etapa 6.
