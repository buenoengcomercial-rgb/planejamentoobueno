# Levantamento em planta — teste local

Abra uma obra e selecione **Levantamento em planta**, abaixo de Produção e rotina, ou abra **Produção**, expanda uma tarefa e clique no ícone de detalhe ao lado do lançamento diário.
A rota independente é `/obras/:id/levantamento` (`planTakeoff`).

## Uso

1. Importe PDF, PNG/JPG ou DXF 2D (até 100 MB por arquivo).
2. Informe nome e pavimento e selecione a página do PDF.
3. Calibre por dois pontos e uma distância em metros. Em DXF também é possível confirmar metro, centímetro ou milímetro como unidade original.
4. Selecione Contagem, Comprimento ou Área, marque os pontos e conclua o traçado.
5. Selecione uma linha para destacar sua geometria. No modo Selecionar, arraste vértices para corrigir. Excluir remove a marcação e sua linha; Desfazer recupera a última operação desta sessão.
6. Recalibrar mostra os valores anteriores e novos antes da confirmação. A escala é independente em cada página.

## Detalhe do lançamento em Produção

No dia escolhido, o campo **Realizado** continua aceitando número direto. O botão **Detalhar quantitativo** abre uma subtabela com local, comentário, fator A, medida B e parcial A × B. Cada linha pode receber um resultado manual ou abrir a planta. Na planta, conclua um grupo de pontos executados e clique em **Usar no detalhe**; a quantidade e uma cópia das coordenadas entram na linha. O mesmo grupo não pode alimentar duas linhas da mesma tarefa.

O detalhe fica **pendente** até clicar em **Usar total no realizado do dia**. Essa ação passa pela validação normal da Produção e não permite exceder a quantidade da tarefa. Depois, os pontos do grupo aplicado aparecem verdes ao reabrir a planta. Se o detalhe mudar, precisa ser aplicado novamente.

## Dados e compatibilidade

O banco IndexedDB `obraplanner-plan-takeoff` guarda arquivos e levantamentos com chave composta por organização, usuário e obra. A confirmação de salvamento ocorre ao concluir a transação. Falha de gravação preserva os dados anteriores e o traçado em andamento.

O visualizador independente não exige coleções operacionais remotas. No fluxo novo da Produção, a subtabela e a cópia dos pontos passam a integrar o `dailyLog` da tarefa e seguem a persistência já existente da Produção; não há tabela/RPC nova nem gravação direta em Medição, Diário ou Almoxarifado. Os perfis de campo e almoxarife continuam sem acesso; Visualizador não edita.

Arquivos e geometrias editáveis da planta não sincronizam entre dispositivos, não participam do backup geral da obra e são removidos ao limpar os dados do navegador. As coordenadas copiadas para o lançamento acompanham o registro de Produção, mas sem o arquivo original não se reabre a planta em outro aparelho. Use uma aba por vez para o mesmo usuário/obra. O histórico de desfazer é limitado a 20 operações e termina ao recarregar.

DXF usa `dxf-viewer` (MPL-2.0), com fonte Noto Sans distribuída sob OFL em `public/fonts`. Layouts/paper space, estilos e entidades especiais podem não reproduzir o CAD original. Pontos são manuais: não há snap nem reconhecimento automático. DWG/DWF, volumes e descontos ficam fora deste teste.

## Verificação

- Testes de cálculo: 7 pontos, percurso de 3 + 4 m, área de 3 × 4 m, escala quadrática e rejeição de calibração inválida.
- Testes de interface: escala obrigatória, contagem, desfazer, falha de armazenamento com nova tentativa, consulta sem edição e ausência de coleções remotas.
- Navegador: imagem, DXF com layer, PDF com duas páginas, 7 un / 7 m / 12 m², zoom, renomeação, reabertura, mover vértice, excluir e desfazer.
- Integração com Produção: edição manual do detalhe, aplicação explícita ao dia, validação do saldo, vínculo dos pontos e rejeição da reutilização do mesmo grupo na tarefa.
- Teste da transação de Produção confirma que pontos e detalhe são enviados dentro do log diário, sem payload de outro domínio.

Entrega local, sem publicação ou alteração na nuvem.
