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
