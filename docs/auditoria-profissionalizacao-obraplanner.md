# Auditoria de profissionalização do ObraPlanner

Auditoria realizada sobre a aplicação autenticada, o projeto real `CPA OBRA`, o código-fonte e o comportamento responsivo em desktop e celular.

## Diagnóstico executivo

O ObraPlanner possui boa profundidade funcional e cobre planejamento, produção, Diário de Obra, medição, aditivo, custos, materiais e almoxarifado. O principal risco de produto não era falta de funções, mas a apresentação simultânea de navegação, configuração, operação e análise com a mesma prioridade visual.

A reorganização segue três experiências:

1. **Gestor:** Rotina semanal, alertas, desvios e decisões.
2. **Planejamento:** Cronograma, EAP, medição, aditivo e custos.
3. **Campo:** programação do dia e Diário de Obra.

## Matriz de achados

| Módulo | Problema observado | Impacto | Severidade | Recomendação aplicada | Esforço |
|---|---|---|---|---|---|
| Global | Dez módulos apresentados como cartões coloridos equivalentes | Aumentava o tempo para localizar a função correta | Alta | Navegação monocromática agrupada por contexto de trabalho | Médio |
| Global | Módulos não possuíam URLs próprias | Impedia favoritos, retorno e compartilhamento de contexto | Alta | Rotas `/obras/:projectId/:modulo` com compatibilidade ao estado anterior | Médio |
| Global | Fontes de 9–10 px em áreas operacionais | Baixa legibilidade e acessibilidade | Alta | Piso visual de 12 px para classes auxiliares antigas | Baixo |
| Global | Metadados e idioma ainda mencionavam Lovable/inglês | Reduzia a percepção institucional | Crítica | Identidade ObraPlanner/Bueno Engenharia e `pt-BR` | Baixo |
| Rotina | Calendário, configuração, checklist, papéis e reunião na mesma tela | Objetivo operacional ficava indefinido | Crítica | Agenda semanal principal e configuração em área secundária | Alto |
| Rotina | Tabela semanal de 1.560 px no celular | Operação de campo inviável | Crítica | Calendário de sete colunas no desktop e agenda vertical no celular | Alto |
| Rotina | Edição de equipe, previsto e realizado duplicava o Cronograma | Criava duas fontes aparentes de planejamento | Alta | Rotina consultiva, alimentada pelo Cronograma e Diários | Médio |
| Diário | Dias futuros sem registro apareciam como “Sem produção” | Informação gerencial incorreta | Crítica | Estados separados: `Não preenchido`, `Pendente`, `Preenchido` e `Sem produção` explícito | Médio |
| Diário | Histórico de dezenas de dias aparecia antes do formulário diário | Atrasava o trabalho de campo | Alta | `Registro do dia` como abertura e histórico em aba secundária | Médio |
| Produção | Administração da EAP e operação diária pareciam uma única tarefa | Aumentava risco de edição indevida em campo | Alta | Nomenclatura e abas separando planejamento e Diário | Médio |
| Custos | Margem de 100% aparecia com milhares de insumos sem cotação | Poderia induzir decisão financeira errada | Crítica | Lucro e margem ficam indisponíveis até cobertura suficiente | Médio |
| Dashboard | Cinco KPIs, custos completos e gráficos competiam na primeira dobra | Alertas prioritários ficavam abaixo da rolagem | Alta | Quatro KPIs, alertas e custos recolhidos por padrão | Médio |
| Cronograma | Mão de obra e previsão financeira empurravam o Gantt para baixo | A principal ferramenta não aparecia de imediato | Alta | Análises recolhidas em painel secundário | Baixo |
| Aditivo | Importação, integração, exportações e histórico no mesmo nível | Barra de ações extensa e difícil de escanear | Média | Ação principal, menus de exportação e menu `Mais ações` | Baixo |
| Materiais | Duas camadas de abas não comunicavam a sequência do processo | Usuário precisava conhecer a estrutura interna | Média | Fluxo nomeado: insumos, comparação/cotação, pedidos, estoque e histórico | Baixo |
| Almoxarifado | Onze indicadores e ação de limpeza no cabeçalho | Excesso de sinais e risco de ação destrutiva | Crítica | Quatro KPIs principais e limpeza dentro de `Administração` | Baixo |
| Usuários | Funções sem descrição de acesso | Escolha de perfil ambígua | Alta | Matriz de permissões e descrição de cada função | Médio |
| Acessibilidade | Poucos nomes acessíveis em ações de ícone | Dificuldade para teclado e leitor de tela | Alta | Labels, foco visível e texto para ações importantes | Contínuo |
| Performance | Pacote inicial e bibliotecas de exportação grandes | Carregamento inicial mais lento | Média | Módulos pesados carregados sob demanda e fonte corrigida | Médio |

## Arquitetura de navegação

- **Visão geral:** Dashboard, Rotina semanal.
- **Planejamento e campo:** Cronograma, Produção, Diário de Obra.
- **Contrato e financeiro:** Medição, Aditivo, Cronograma do aditivo, Custos.
- **Suprimentos:** Materiais e compras, Almoxarifado.
- **Administração:** Obras e Usuários.

## Padrão visual institucional

- Uma ação principal por página; ações secundárias agrupadas.
- Cores fortes reservadas a estados de sucesso, atenção, atraso, erro ou bloqueio.
- Ícones isolados somente quando universais e com nome acessível.
- Texto operacional de 14 px; texto auxiliar nunca abaixo de 12 px.
- Alvos de toque com pelo menos 44 px nas jornadas de campo.
- Tabelas largas preservam colunas no desktop e usam cartões ou rolagem controlada no celular.
- Configuração e administração permanecem fora do fluxo operacional principal.

## Backlog priorizado

### Crítico

- Validar os novos estados do Diário com dados históricos.
- Confirmar a cobertura de custos antes de liberar lucro e margem.
- Garantir que ações de `field_user` fiquem limitadas ao Diário de Obra.
- Revisar todas as ações destrutivas para confirmação e posição administrativa.

### Alta prioridade

- Concluir labels acessíveis e foco de teclado nos módulos antigos.
- Levar o padrão de cabeçalho para Medição, Aditivo, Materiais e Almoxarifado.
- Criar testes de navegação por rota e por perfil.
- Revisar tabelas largas em 390 px e 768 px.

### Melhoria

- Padronizar estados vazios e mensagens de orientação.
- Consolidar filtros recorrentes em uma barra única.
- Substituir ações de edição repetidas por menus contextuais.
- Corrigir textos antigos ainda sem acentuação.

### Evolução futura

- Atalhos configuráveis por perfil.
- Central de notificações e alertas gerenciais.
- Telemetria de jornadas para medir tempo de preenchimento e abandono.
- Pesquisa global por obra, tarefa, medição, fornecedor ou documento.

## Critérios de aceite

- O gestor encontra a programação semanal sem abrir o Cronograma.
- O usuário de campo abre o Diário da data correta com um único comando.
- Ausência de diário nunca aparece como declaração de ausência de produção.
- Custos incompletos nunca aparecem como margem saudável.
- Todas as rotas principais são recarregáveis e compartilháveis.
- Cálculos financeiros, aditivos, medições, estoque e formatos de projeto permanecem inalterados.
