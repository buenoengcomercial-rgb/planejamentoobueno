# Levantamento em planta — teste local

Abra uma obra e selecione **Levantamento em planta**, abaixo de Produção e rotina.
A rota é `/obras/:id/levantamento` (`planTakeoff`).

## Uso

1. Importe PDF, PNG/JPG ou DXF 2D (até 100 MB por arquivo).
2. Informe nome e pavimento e selecione a página do PDF.
3. Calibre por dois pontos e uma distância em metros. Em DXF também é possível confirmar metro, centímetro ou milímetro como unidade original.
4. Selecione Contagem, Comprimento ou Área, marque os pontos e conclua o traçado.
5. Selecione uma linha para destacar sua geometria. No modo Selecionar, arraste vértices para corrigir. Excluir remove a marcação e sua linha; Desfazer recupera a última operação desta sessão.
6. Recalibrar mostra os valores anteriores e novos antes da confirmação. A escala é independente em cada página.

## Dados e compatibilidade

O banco IndexedDB `obraplanner-plan-takeoff` guarda arquivos e levantamentos com chave composta por organização, usuário e obra. A confirmação de salvamento ocorre ao concluir a transação. Falha de gravação preserva os dados anteriores e o traçado em andamento.

Não há tabelas/RPCs novos, alteração no objeto Project, integração com o autosave global ou gravação em Produção, Medição, Diário e Almoxarifado. O módulo não exige coleções operacionais remotas. Os perfis de campo e almoxarife continuam sem acesso; Visualizador não edita.

Dados locais não sincronizam entre dispositivos, não participam do backup geral da obra e são removidos ao limpar os dados do navegador. Use uma aba por vez para o mesmo usuário/obra. O histórico de desfazer é limitado a 20 operações e termina ao recarregar.

DXF usa `dxf-viewer` (MPL-2.0), com fonte Noto Sans distribuída sob OFL em `public/fonts`. Layouts/paper space, estilos e entidades especiais podem não reproduzir o CAD original. Pontos são manuais: não há snap nem reconhecimento automático. DWG/DWF, volumes, descontos e associação aos serviços ficam fora deste teste.

## Verificação

- Testes de cálculo: 7 pontos, percurso de 3 + 4 m, área de 3 × 4 m, escala quadrática e rejeição de calibração inválida.
- Testes de interface: escala obrigatória, contagem, desfazer, falha de armazenamento com nova tentativa, consulta sem edição e ausência de coleções remotas.
- Navegador: imagem, DXF com layer, PDF com duas páginas, 7 un / 7 m / 12 m², zoom, renomeação, reabertura, mover vértice, excluir e desfazer.
- O TypeScript global apresenta um erro anterior nesta cópia em `Index.tsx`, na atribuição de `Promise<DailyReportSaveResult>` à fila `Promise<void>` do Diário. Não foi alterado como parte deste módulo.

Entrega local, sem publicação ou alteração na nuvem.
