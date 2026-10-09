# Levantamento na Produção

O acesso acontece em **Produção e rotina**, no detalhe do lançamento diário. Não existe uma aba independente de levantamento na navegação.

## Fluxo

1. Expanda a tarefa e o detalhe do dia. As linhas têm Loc., Comentário, Fórmula, A, B, C, D, Parcial e Subtotal. Loc. indica a hierarquia; uma nova linha começa zerada.
2. Selecione a célula que receberá a quantidade e abra a planta. Digitação manual continua disponível, sem setas numéricas para aumentar/diminuir valores.
3. Abra **Plantas** para cadastrar, escolher ou arquivar uma prancha. Os arquivos pertencem ao capítulo do prédio e são reutilizados por suas tarefas. O modal aplica seleção e visibilidade ao aceitar; cadastro e exclusão têm confirmação própria. Plantas com marcações não podem ser apagadas.
4. Escolha a ferramenta. Contagem registra pontos numerados sem uni-los. Comprimento linear, perímetro circular, retângulo, círculo e superfície vertical terminam no segundo ponto. Percurso, polígono e volume terminam por Concluir ou botão direito.
5. O resultado preenche diretamente a célula e a próxima linha fica pronta. Não há uma segunda tabela dentro da planta nem ação “Usar no detalhe”. Após o primeiro lançamento válido, o subtotal acompanha o Realizado do dia. Uma linha zerada não apaga o lançamento manual anterior.
6. As fórmulas e fatores neutros ficam identificados na subtabela. O limite da tarefa é validado; uma recusa preserva o traçado para correção ou cancelamento.

## Visualização e edição

- A roda controla zoom; segurar o botão central desloca. Duplo clique central enquadra. Zoom por janela usa dois cantos; Vista anterior retorna ao enquadramento anterior.
- Os valores e segmentos aparecem sobre a geometria com tamanho constante na tela. Visualizar/ocultar medidas altera os textos, preservando os pontos. Hachura alterna o preenchimento de superfícies.
- Mover ponto aceita clicar no vértice e na nova posição, ou arrastar. Escape cancela o movimento ainda não confirmado. Adicionar ponto acrescenta ao fim do percurso. Medidas de dois pontos não aceitam um terceiro vértice.
- Edição, exclusão, renomeação, recalibração e Desfazer passam pelas validações dos lançamentos vinculados. O histórico de Desfazer tem até 20 alterações por sessão.
- Capturas para máscaras abre uma janela compacta. Só habilita opções cuja geometria foi reconhecida no DXF. Cancelar descarta as preferências em edição; Desmarcar todas limpa a seleção sem desativar o modo.

## Dados, unidades e formatos

No sistema autenticado, arquivos e metadados usam `takeoff_plans` e o bucket privado `plan-takeoff`, com controle de revisão. A prévia local usa IndexedDB. A indicação de salvamento distingue navegador e nuvem.

Arquivos são compartilhados pelo capítulo. Marcações permanecem filtradas pela tarefa e pelo dia; vínculos explícitos continuam sujeitos às validações das referências da Produção. Os pontos também acompanham a célula do lançamento diário. Não se modifica orçamento, quantidade contratada ou Almoxarifado.

DXF começa em 1 metro por unidade e permite conferir/calibrar a conversão. PDF e imagem sem escala usam unidades do desenho, identificadas assim. Nenhuma ferramenta é bloqueada só pela unidade da célula ou ausência de calibração.

São preservados PDF multipágina, PNG/JPG, DXF 2D e o leitor DWF já existente. Não há leitor DWG. Capturas CAD só ficam disponíveis quando o leitor fornece entidades reconhecidas; PDF, imagem e folhas DWF sem entidades permitem marcação livre.

## Verificação de 08/10/2026

O teste real do Arquimedes e sua correspondência estão registrados em [Validação das interações](arquimedes-takeoff-validation.md). A implementação desta rodada foi verificada primeiro na prévia local, sem publicar no Lovable.
