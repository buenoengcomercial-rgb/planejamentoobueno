# Prévia isolada da Medição

Execute `npm run dev -- --host 127.0.0.1 --port 5181 --strictPort` e abra
`http://127.0.0.1:5181/dev/measurement/index.html`.

O botão **Confirmar incorporação** inicializa somente a demonstração deste navegador.
O componente é a entrada real `Measurement`, selecionando seu novo domínio por
`independentWorkspace`; a interface definitiva não contém controles de simulação.
Esta página e seus fixtures não são entradas do build de produção.

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
