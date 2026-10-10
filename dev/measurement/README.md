# Prévia isolada da Medição

Execute `npm run dev -- --host 127.0.0.1 --port 5181 --strictPort` e abra
`http://127.0.0.1:5181/dev/measurement/index.html`.

O botão **Confirmar incorporação** inicializa somente a demonstração deste navegador.
O componente é a entrada real `Measurement`, selecionando seu novo domínio por
`independentWorkspace`; a interface definitiva não contém controles de simulação.
Esta página e seus fixtures não são entradas do build de produção.

## Cópia de uma planilha do Lovable

`?source=lovable` lê `local/medicao.xlsx`, baixada pelo botão Excel da Medição,
e `local/source.json` com `sha256`, `itemCount`, `sourceUrl` e `capturedAt`.
A pasta `local/` é privada e ignorada pelo Git. Não copie arquivos para `public/`.
O total de itens deve ser conferido na página original, sem busca/filtro de capítulo.

A prévia confere hash, cabeçalhos, hierarquia, quantidades e todos os totais por item
e geral antes de inicializar um banco isolado identificado pelo hash do arquivo.
Recarregar mantém as edições locais; um arquivo diferente cria outra cópia.
Não há conexão com a persistência da obra. A demonstração anterior continua em
seu próprio escopo, no endereço sem `source`.

Este adaptador é apenas para a 1ª medição em preparação, sem acumulado anterior.
Ele preserva os totais exportados como linhas editáveis do período, em A, com o
comentário “Dado preservado · 1ª medição”. Não inventa datas diárias, IDs do banco,
composições analíticas, plantas, geometria ou histórico: esses dados não constam
da planilha. Não é um backup completo nem um caminho de migração operacional.

Os dados de demonstração pertencem ao usuário `local-test`, em um banco IndexedDB
exclusivo. O parâmetro opcional `?test=<identificador>` cria um escopo separado para
validação. Não se conecta à obra real nem reutiliza o armazenamento de Produção.

Validação no navegador (Playwright CLI):

```
npx --yes --package @playwright/cli playwright-cli -s=measurement open http://127.0.0.1:5181/dev/measurement/index.html
npx --yes --package @playwright/cli playwright-cli -s=measurement run-code --filename=dev/measurement/checks/acceptance.js
npx --yes --package @playwright/cli playwright-cli -s=measurement run-code --filename=dev/measurement/checks/storage.js
npx --yes --package @playwright/cli playwright-cli -s=measurement run-code --filename=dev/measurement/checks/drafts.js
```

Os testes usam identificadores novos e preservam as outras prévias. Screenshots e
exportações são salvos em `output/playwright/`. A descrição do armazenamento e os
bloqueios de ativação estão no relatório em `docs/audits/2026-10-09-independent-measurement.md`.
