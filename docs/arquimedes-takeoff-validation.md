# Arquimedes — validação real de 08/10/2026

Referência: Arquimedes 2026.a, janela “Quantitativos sobre DXF-DWG”; manual fornecido pelo usuário, seção 5.7. As funções foram acionadas na interface do aplicativo, com ícones próprios usados na implementação web.

## Estado preservado

O fechamento da janela nativa transfere as capturas para o orçamento. Uma contagem inicial de teste acrescentou 3 à quantidade original. A linha foi removida com autorização do usuário e o original foi reaberto, restaurado e salvo com **29 unidades**, preservando as três linhas anteriores.

Os testes seguintes ocorreram na cópia `TESTE-ARQUIMEDES-2026-10-08`, dentro de `.codex-temp`. Apagar ponto e Apagar medida foram autorizados exclusivamente para as geometrias criadas nessa cópia.

## Funções exercitadas no aplicativo

| Função | Comportamento observado | Correspondência na Produção |
| --- | --- | --- |
| Contagem | Pontos numerados independentes | Mantido, sem linhas ligando pontos |
| Comprimento linear | Segundo ponto conclui | Implementado; mantém ferramenta ativa para a próxima linha |
| Comprimento poligonal | Soma segmentos; direito conclui | Mantido; valores dos segmentos e total agora na geometria |
| Perímetro circular | Centro e raio; segundo ponto conclui | Implementado o encerramento automático |
| Superfície retangular | Dois cantos opostos; área com hachura | Encerramento automático, valor central e hachura |
| Superfície poligonal | Direito fecha; área central e lados identificados | Mantido; rótulos e hachura adicionados |
| Superfície circular | Centro e raio; área central | Encerramento automático e valor central |
| Superfície vertical | Comprimento × altura | Preservada altura constante; dois pontos concluem |
| Volume poligonal | Área × altura; direito conclui | Preservado; valor central e hachura |
| Adicionar ponto | Acrescenta no final do percurso | Ajustado para acrescentar no final |
| Mover ponto | Clique no ponto e depois no destino | Adicionado, preservando também o arraste |
| Apagar ponto | Remove ponto e recalcula | Exercitado na cópia; web valida o lançamento vinculado |
| Apagar medida | Remove a geometria completa | Exercitado na cópia; web preserva saldo e Desfazer |
| Enquadrar/reduzir/anterior | Ajustam a vista; redução de 2× | Zoom de 2×, histórico de vista e enquadramento |
| Zoom por janela | Dois cantos da região | Adicionado |
| Cor de fundo | Menu branco/cinza/preto | Preservado |
| Mostrar/ocultar medidas | Alterna textos; geometria continua visível | Adicionado |
| Capturas para máscaras | Ativação, rastreamento, tipos; tirar todas e cancelar | Janela compacta, rascunho até confirmar, opções limitadas à geometria reconhecida |
| Gestão de desenhos | Janela com pavimentos, visibilidade e indicação de exclusão | Mantido o modal e o compartilhamento de arquivos por capítulo |
| Gestão de máscaras/layers | Catálogo de arquivos, lista de layers e prévia | Seleção de arquivos por pavimento e layers mantidos; não se anuncia composição de várias máscaras |

O deslocamento nativo por arraste não teve confirmação visual inequívoca; o gesto central no web foi validado diretamente. As caixas de impressão, seleção de pranchas e formatos foram abertas e canceladas: são configurações de saída, não calibração da medição.

Não foram validados integralmente nem adicionados nesta rodada: exportação/impressão em formatos CAD, transformação/composição de várias máscaras sobrepostas, altura diferente em cada extremo da superfície vertical e os comandos nativos ainda não identificados. A transformação nativa apresentou erro de entrada numérica e foi cancelada. Este registro não afirma uma cópia integral de todos os comandos do programa.

## Evidência no navegador

Prévia isolada com DXF de geometria conhecida, via Playwright:

- 3 pontos → célula A = 3 → parcial/subtotal/Realizado = 3; recarga manteve os três pontos.
- Comprimento de 5 m, percurso 3 + 4 = 7 m, retângulo e polígono de 12 m², círculo de raio 2 com perímetro 12,5664 m e área 12,5664 m², superfície vertical de 15 m² e volume de 36 m³.
- Movimento por dois cliques recalculou a célula e o Realizado. Soma das nove linhas de teste = 115,1328.
- A segunda tarefa reutilizou o mesmo arquivo, mostrou zero pontos da origem e recebeu seu próprio lançamento de 1 unidade. A origem permaneceu em 115,1328.
- Exclusão de ponto, exclusão de medida e restauração por Desfazer; zoom, janela de capturas e layers conferidos na interface.

Regressão: testes focados em visualizador, Produção, limites, referências, armazenamento e atualização atômica. TypeScript, lint dos arquivos alterados, build e conferência do diff. O build mantém o aviso existente de chunks grandes. Capturas estão em `output/playwright/`; evidências nativas em `output/arquimedes/`, fora do commit.

## Fronteira da mudança

| Área | Impacto |
| --- | --- |
| Visualizador | Interações de desenho, rótulos, hachura e janela de capturas |
| Produção | Usa os callbacks existentes de quantidade, validação, referência e histórico |
| Plantas na nuvem | Mesmo salvamento específico e controle de revisão; sem alteração de esquema ou RPC |
| Quantidade contratada, orçamento, Almoxarifado | Nenhuma escrita |
| Permissões | Consulta pode navegar; edição continua limitada às permissões existentes |

Entrega desta rodada em branch de desenvolvimento e prévia local; sem publicação no Lovable.

## Correção de capturas e esclarecimento de exclusão

A verificação posterior ao relato do usuário identificou três problemas: a captura não percorria entidades dentro de blocos INSERT, Perpendicular/Paralelo dependiam indevidamente do rastreamento e não havia guia de alinhamento adquirida. O leitor de captura agora percorre blocos aninhados, respeitando base, posição, rotação, escala e layers dos pais. Arcos e segmentos curvos de polilinhas usam sua geometria real, sem capturar na corda ou fora do arco. Elipses resultantes de escala não uniforme não são anunciadas como círculos.

Perpendicular e Paralelo usam o ponto anterior do traçado, independentemente da ativação do rastreamento. Extensão funciona sem ponto anterior. Rastreamento apresenta guias horizontais/verticais a partir do ponto anterior ou de uma captura adquirida, com tolerância em pixels de tela. As configurações idênticas recebidas após uma atualização da barra não apagam a captura adquirida.

No navegador local, o Drawing1.dxf cadastrado foi aberto pela célula B de uma tarefa de teste: a aproximação à parede produziu a captura Perpendicular e a projeção exata sobre a linha, com guia. Um segundo movimento produziu Rastreamento vertical. Ambos os traçados foram cancelados sem conclusão ou alteração do Realizado. Evidências: `output/captura-perpendicular-dxf.png` e `output/capturas-dxf-corrigidas.png` (fora do commit).

O DXF real `codex.dxf` (17,9 MB) foi analisado pelo parser instalado: 35.470 entidades, 116 blocos, 41.838 segmentos, 225.192 âncoras e 19.059 curvas extraídas. Isso verifica a extração em um arquivo representativo, sem afirmar cobertura de todas as entidades CAD. Os testes específicos também cobrem as onze opções de captura, limites de arcos, curvas de polilinhas, blocos, layers ocultos e coordenadas realmente enviadas pelo clique no visualizador.

A exclusão de planta que possui marcações permanece bloqueada para preservar os quantitativos. Gestão de desenhos passa a informar esse motivo diretamente, além do estado desabilitado do botão. O teste existente verifica exclusão de arquivo sem marcações e bloqueio de arquivo com marcações; nenhum arquivo original do usuário foi apagado.

Validação desta correção: 96 testes em 12 arquivos, TypeScript da aplicação, lint dos arquivos alterados, build e diff. Sem mudança de esquema, salvamento da Produção, limites ou permissões. Integração destinada à prévia conectada do Lovable, conforme solicitação posterior do usuário; publicação do site não é acionada.
