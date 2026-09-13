# Plano detalhado de evolução técnica, visual e operacional

## Objetivo

Evoluir a plataforma inteira sem alterar cálculos, regras contratuais, estoque ou dados existentes. O trabalho será feito por jornadas reais de **gestão**, **planejamento**, **campo**, **financeiro** e **suprimentos**, com validação em computador e celular.

## Estado confirmado que será preservado

- As páginas principais já possuem endereços próprios por obra e módulo.
- A navegação já está agrupada em Visão geral, Planejamento e campo, Contrato e financeiro e Suprimentos.
- Os perfis já limitam os módulos disponíveis para gestor, engenharia, almoxarife, campo e consulta.
- Produção e Diário já carregam separadamente; custos do Painel já ficam recolhidos por padrão.
- O Almoxarifado já possui navegação específica para celular e operações protegidas de confirmação.
- Salvamento em nuvem, atualização entre usuários e persistência local existentes serão mantidos.

# Melhorias ponto a ponto

## 1. Estrutura geral e navegação

### 1.1 Cabeçalho único por página
- Padronizar título, nome da obra, contexto atual, ação principal, ações secundárias e situação do salvamento.
- Remover títulos duplicados e comandos espalhados em posições diferentes.
- Manter somente uma ação principal visualmente dominante em cada página.
- **Resultado:** o usuário reconhece imediatamente onde está e o que pode fazer.

### 1.2 Continuidade entre páginas
- Manter filtros, aba selecionada, data e posição de trabalho ao navegar e voltar.
- Preservar os endereços atuais e permitir recarregar ou compartilhar uma página sem perder o contexto.
- Padronizar retorno da área de usuários e da página não encontrada para a última obra acessível.
- **Validação:** abrir, atualizar, voltar e avançar em cada módulo sem mudança inesperada de contexto.

### 1.3 Navegação por perfil
- Revisar a experiência de cada perfil, além de apenas esconder opções sem permissão.
- Gestor: visão geral, alertas e decisões.
- Engenharia: planejamento, medição, aditivo e acompanhamento.
- Campo: Diário da data atual com o menor número possível de etapas.
- Almoxarife: recebimento, retirada, consulta e inventário.
- Consulta: leitura clara, sem comandos de edição aparentes.
- **Validação:** testes de acesso direto pelo endereço e pelo menu para todos os perfis.

### 1.4 Pesquisa e atalhos contextuais
- Criar uma pesquisa global por obra, tarefa, documento, fornecedor e material.
- Adicionar atalhos apenas para ações frequentes do perfil atual.
- Evitar um painel genérico de atalhos iguais para todos.
- **Resultado:** menos navegação repetitiva sem aumentar a poluição da tela.

## 2. Sistema visual e consistência

### 2.1 Tipografia e legibilidade
- Eliminar textos efetivamente menores que 12 px nas áreas operacionais; usar 14 px como padrão de leitura.
- Rever especialmente Cronograma, Diário, Medição, Custos, Materiais e Almoxarifado.
- Ajustar truncamentos para oferecer nome completo por expansão ou dica acessível.
- **Validação:** nenhuma informação essencial depende de zoom em celular ou monitor comum.

### 2.2 Cores e hierarquia
- Reservar cores fortes para sucesso, atenção, atraso, erro, bloqueio e seleção.
- Remover cores decorativas que façam elementos comuns parecerem alertas.
- Usar os mesmos significados de cor em toda a plataforma.
- **Validação:** estado continua compreensível sem depender somente da cor.

### 2.3 Controles e ações
- Padronizar botões principais, menus de ações secundárias, filtros, seletores, diálogos e confirmações.
- Usar ícones isolados somente para ações universais e sempre com nome acessível.
- Garantir alvos de toque de pelo menos 44 px nas rotinas de campo e almoxarifado.
- **Resultado:** mesma ação se comporta e aparece da mesma maneira em qualquer módulo.

### 2.4 Mensagens e estados vazios
- Cada estado vazio explicará o que falta e oferecerá a próxima ação permitida.
- Erros informarão o que não foi salvo, o que foi preservado e como tentar novamente.
- Sucessos indicarão o registro criado e, quando útil, oferecerão acesso direto a ele.
- **Validação:** nenhuma mensagem termina em beco sem saída.

## 3. Dashboard e rotina do gestor

### 3.1 Dashboard orientado a decisão
- Manter quatro indicadores principais e priorizar alertas acionáveis.
- Cada alerta abrirá o item responsável já filtrado.
- Não mostrar lucro, margem ou saúde financeira como positivos quando a cobertura dos dados for insuficiente.
- Manter análises extensas recolhidas e disponíveis sob demanda.
- **Resultado:** a primeira tela responde “o que exige atenção agora?”.

### 3.2 Rotina semanal
- Manter a agenda como conteúdo principal e configuração como área secundária.
- Exibir no computador a semana comparável e no celular uma agenda vertical por dia.
- Diferenciar planejado, realizado, pendente, atraso e ausência de registro.
- Evitar edição paralela de dados cuja fonte oficial é Cronograma ou Diário.
- **Validação:** gestor encontra a programação e o desvio sem editar a EAP acidentalmente.

## 4. Cronograma e produção

### 4.1 Cronograma
- Deixar EAP e Gantt visíveis imediatamente; análises de mão de obra e previsão financeira permanecem secundárias.
- Consolidar zoom, período, filtros e visualização em uma barra única.
- Melhorar leitura do caminho crítico, dependências, feriados e data atual sem excesso de cores.
- Preservar todos os cálculos de dias úteis, duração, precedência e CPM.
- **Validação:** editar, arrastar e relacionar tarefas sem deslocamentos visuais ou alteração dos cálculos.

### 4.2 Produção
- Separar claramente administração do planejamento e apontamento operacional.
- Exibir primeiro atividades do período e equipe relevante; detalhes avançados ficam sob demanda.
- Impedir que telas de campo ofereçam ações administrativas fora do perfil.
- **Resultado:** produção diária deixa de parecer uma segunda edição completa do Cronograma.

## 5. Diário de Obra

### 5.1 Registro do dia como abertura
- Abrir diretamente na data operacional correta.
- Priorizar equipe, clima, atividades, ocorrências, equipamentos, fotos e conclusão.
- Mover histórico e consultas extensas para uma área secundária.

### 5.2 Estados confiáveis
- Manter distinção explícita entre Não preenchido, Pendente, Preenchido e Sem produção declarado.
- Nunca interpretar ausência de diário como ausência de produção.
- Exibir bloqueio de diário concluído antes de o usuário iniciar uma edição inválida.

### 5.3 Fotos e salvamento
- Mostrar envio, processamento, confirmação e falha de cada foto individualmente.
- Preservar rascunho local durante instabilidade e informar claramente a confirmação na nuvem.
- **Validação:** concluir, reabrir conforme permissão, usar offline temporariamente e testar conflito entre dois usuários.

## 6. Medição

- Organizar a página na sequência: período e contrato → itens medidos → validações → totais → aprovação/exportação.
- Fixar contexto do período e resumo enquanto o usuário percorre listas longas.
- Agrupar filtros em uma única barra e mostrar filtros ativos.
- Destacar inconsistências antes da confirmação, apontando exatamente o item afetado.
- Adaptar tabelas para cartões ou detalhes expansíveis no celular, sem perder código, unidade, quantidade e valor.
- **Validação:** conferir e fechar uma medição completa por teclado e em tela pequena sem ambiguidade de total.

## 7. Aditivo e cronograma do aditivo

- Manter uma ação principal por etapa: criar/importar, revisar, contratar e integrar.
- Agrupar exportações e comandos raros em menus secundários.
- Exibir claramente o que é prévia, o que está contratado e o que já alterou o planejamento oficial.
- No cronograma do aditivo, usar os mesmos padrões de datas, dependências, calendário e leitura do Cronograma principal.
- **Validação:** nenhuma prévia altera contrato ou cronograma salvo antes da confirmação correspondente.

## 8. Custos

- Apresentar primeiro cobertura dos dados, custo conhecido, pendências e desvios.
- Bloquear interpretações de lucro e margem quando faltarem preços confiáveis.
- Separar orçamento, cotação, compra, consumo e custo realizado, sem somá-los como se fossem o mesmo indicador.
- Permitir abrir diretamente os itens que formam cada total ou alerta.
- **Validação:** totais visuais reconciliam com as fontes e estados incompletos são identificados como incompletos.

## 9. Materiais e compras

- Transformar as duas camadas atuais de abas em uma sequência operacional clara: insumos → cotação → fornecedores → pedidos → recebimento → histórico.
- Manter grupos de compra como contexto de trabalho, não como uma navegação concorrente.
- Mostrar etapa atual, pendências e próxima ação de cada grupo.
- Padronizar busca, filtros e seleção de fornecedores e insumos.
- Diferenciar claramente material previsto, comprado, recebido, disponível e consumido.
- **Validação:** um usuário novo conclui uma cotação e gera um pedido sem precisar conhecer a estrutura interna da tela.

## 10. Almoxarifado

### 10.1 Ordem operacional
- Abrir na área operacional adequada ao perfil, priorizando Entrada para recebimento e Retiradas para entrega.
- Reordenar áreas por frequência: Entrada, Materiais, Retiradas, Movimentações, Inventário, Equipamentos; Painel e relatórios ficam como gestão.
- Reduzir a quantidade de opções simultâneas no computador e manter o seletor simples no celular.

### 10.2 Entrada por nota fiscal
- Tornar envio, leitura, conferência, vínculo e confirmação etapas visualmente distintas.
- Mostrar duplicidade, material não previsto e custo pendente antes do lançamento.
- Padronizar visualizar documento, revisar, cancelar e consultar movimento gerado.
- Garantir retorno claro quando uma página da nota não puder ser lida.

### 10.3 Materiais
- Priorizar descrição, unidade, saldo disponível e última movimentação.
- Adicionar filtros combináveis por grupo, saldo zerado, abaixo do mínimo e arquivados.
- Substituir exclusão operacional por arquivamento quando houver saldo ou histórico.
- Permitir abrir entradas, retiradas e ajustes que formam o saldo.

### 10.4 Retiradas e devoluções
- Conduzir uma entrega direta: destino/EAP → equipe e recebedor → itens → evidências → revisão → confirmação.
- Mostrar saldo durante a escolha e resumo de saldo anterior, entregue e posterior.
- Manter assinatura do recebedor e identidade do operador autenticado como informações diferentes.
- Tratar devolução, complemento e correção dentro da operação original.

### 10.5 Movimentações
- Permanecer somente leitura para operações normais.
- Agrupar linhas por nota, retirada, inventário ou exceção de origem.
- Oferecer filtros por período, tipo, material, usuário e origem.
- Sinalizar movimento legado ou sem origem, sem apagar o histórico.

### 10.6 Inventário
- Usar sessão com início, escopo, contador, contagem cega, divergências, revisão, aprovação e encerramento.
- Revelar a diferença somente após a contagem quando o modo cego estiver ativo.
- Vincular cada ajuste à sessão que o gerou e impedir aplicação repetida.

### 10.7 Equipamentos
- Explicar colunas e ações; priorizar código, descrição, situação e responsável.
- Manter fotos, etiqueta QR, cautela, devolução e arquivamento no histórico do equipamento.
- Separar cadastro de equipamento da entrega/devolução em campo.

### 10.8 Painel e relatórios
- Mostrar apenas alertas acionáveis e indicadores essenciais na primeira área.
- Cada indicador abrirá a lista filtrada que o originou.
- Nomear exportações com relatório, obra, período e data de geração.
- Manter administração, limpeza e manutenção fora do fluxo operacional comum.

## 11. Usuários e administração

- Levar a gestão de acessos para o mesmo padrão de navegação e cabeçalho do restante da plataforma.
- Exibir descrição prática de cada função antes da atribuição.
- Mostrar claramente quem pode editar, aprovar, excluir, gerenciar estoque e concluir Diário.
- Manter ações destrutivas restritas, confirmadas e registradas.
- **Validação:** matriz de cenários por perfil e teste de acesso direto a páginas restritas.

## 12. Celular, acessibilidade e desempenho

### 12.1 Celular
- Testar todas as jornadas em 390×844 e 768 px.
- Eliminar rolagem horizontal nas rotinas de campo; preservar rolagem controlada apenas em ferramentas técnicas como Gantt.
- Manter ações finais visíveis sem cobrir conteúdo e respeitar a área segura do aparelho.

### 12.2 Acessibilidade
- Garantir foco visível, ordem de teclado, nomes acessíveis e associação entre rótulo e campo.
- Adicionar alternativa textual para cores, gráficos, estados e ícones.
- Validar contraste nos temas claro e escuro.

### 12.3 Desempenho
- Preservar carregamento sob demanda e revisar pacotes pesados por módulo.
- Adiar gráficos, PDFs e exportadores até serem realmente abertos.
- Otimizar listas longas e evitar recálculos durante digitação, arraste ou rolagem.
- **Validação:** medir abertura inicial, troca de módulo e interação em aparelho intermediário.

## 13. Salvamento, sincronização e confiança

- Unificar a linguagem de Salvando, Salvo, Sem conexão, Conflito e Falha.
- Mostrar o escopo afetado quando apenas uma operação não foi confirmada.
- Preservar a primeira confirmação em conflitos e orientar a revisão da versão mais recente.
- Testar edição simultânea em tarefas, Diário, medição, notas, retiradas e inventário.
- Nunca indicar sucesso antes da confirmação correspondente na nuvem.

# Ordem recomendada de execução

## Etapa 1 — Segurança e confiança
1. Perfis e ações destrutivas.
2. Estados de salvamento e conflitos.
3. Diário, custos incompletos e operações do Almoxarifado.
4. Testes de regressão das regras existentes.

## Etapa 2 — Jornadas operacionais
1. Diário no celular.
2. Entrada e retirada no Almoxarifado.
3. Cronograma e Produção.
4. Medição e Aditivo.

## Etapa 3 — Organização e consistência
1. Cabeçalhos e barras de ação.
2. Materiais e compras.
3. Dashboard e Rotina semanal.
4. Usuários e páginas auxiliares.

## Etapa 4 — Qualidade final
1. Tipografia, acessibilidade e contraste.
2. Revisão em 390 px, 768 px e desktop.
3. Desempenho e carregamento sob demanda.
4. Testes completos por perfil e publicação gradual.

# Entregáveis e controle de risco

- Matriz por tela: problema, impacto, solução, prioridade, esforço e critério de aceite.
- Protótipo das jornadas críticas antes de alterar telas extensas.
- Implementação em lotes pequenos, cada um com testes e comparação visual.
- Nenhuma alteração em fórmulas, calendário, CPM, contratos, custos ou estoque sem uma especificação separada.
- Publicação gradual: primeiro Preview, depois validação dos perfis e somente então produção.
