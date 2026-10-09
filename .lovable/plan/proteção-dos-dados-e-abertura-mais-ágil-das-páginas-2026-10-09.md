# Proteção dos dados e abertura mais ágil das páginas

## Objetivo e forma de entrega

Trabalhar **segurança e velocidade juntas**, em entregas pequenas: cada rodada terá uma correção de risco, uma melhoria de desempenho justificada por medição e testes antes de avançar. Começar por Cronograma, Produção, Rotina e Diário; ampliar a proteção às demais abas.

Este plano não recupera automaticamente registros antigos e não atribui uma causa definitiva à perda histórica. Nenhum código ou dado foi alterado nesta análise. Não publicar em produção automaticamente.

## 1. O que foi confirmado agora

Código inspecionado: `25d9d88eba4eddfbb6e42fe57f65fbc9549d957a`.

| Achado atual | Evidência | Consequência possível |
| --- | --- | --- |
| Desfazer guarda e restaura o projeto inteiro | `Index.tsx`, `makeViewSetter`, linhas 2337–2339; `handleUndo`, 2833–2838 | Reverter uma alteração do Cronograma pode restaurar valores antigos de outras abas. |
| Exclusão de capítulo/tarefa retira objetos da árvore; ausência pode virar exclusão na gravação | `TaskList.tsx`, `deletePhase`, 321–328; `deleteTask`, 636–658; `projectSync.ts`, `changedRows`, 977–984 e `syncProductionAtomically`, 1009–1033 | Apontamentos vinculados podem entrar no conjunto de exclusões. A exclusão de tarefa já registra auditoria, mas isso não impede apagar o registro operacional. |
| Falha no Diário pode substituir a edição tentada pela versão confirmada | `Index.tsx`, `saveDailyReportDirectly`, 2270–2285 | O texto tentado pode desaparecer da tela; não é prova de perda de conteúdo anteriormente confirmado. |
| Algumas gravações ainda seguem caminho misto | `cloudProjects.ts`, `upsertCloudProject`, 213–246; `projectSync.ts`, 1014–1038 e 1112–1124 | As transações existentes não cobrem toda combinação de alterações, volume ou indisponibilidade de função. Há tratamento de falha parcial; não significa perda inevitável. |
| A rotina semanal monta listas de atividades; ainda não foi medido seu custo | `ManagementRoutine.tsx`, listas nas linhas 539–607; listas e transformações em `TaskList.tsx` | É candidata à redução de elementos exibidos, não um gargalo comprovado. |
| Voltar à aba já agrupa eventos em 200 ms e impede consultas simultâneas | `Index.tsx`, 1672–1682 e 2091–2133 | Não repetir a recomendação antiga de criar essa proteção. Medir se restam consultas consecutivas dispensáveis. |

Os sinais recentes mostram uma consulta de versão com resposta 200 e avisos de compatibilidade do roteador. Eles **não medem o tempo de abertura nem demonstram a causa da lentidão**. A disponibilidade e os detalhes das funções/permissões do banco deverão ser verificados antes de qualquer alteração que dependa deles.

### Melhorias que já existem e serão preservadas

- Páginas e áreas carregadas sob demanda (`App.tsx` e `DailyProductionWorkspace.tsx`).
- PDF/Excel isolados das jornadas comuns, conforme a documentação e as fronteiras de carregamento existentes.
- Pré-carregamento ocioso, com restrições de conexão e economia de dados (`idlePreload.ts`).
- Dados carregados por área, com tarefas e apontamentos mantidos juntos quando necessário (`projectDataScope.ts`).
- Canal em tempo real estável por obra, reconexão e consulta periódica apenas quando desconectado (`Index.tsx`, 1967–2133).
- Transações de Produção e domínios de Medição, Aditivos, Materiais e Custos nos caminhos elegíveis (`cloudProjects.ts`, 218–221).
- Registro de formulário pendente em Materiais, Estoque e Requisições; a cobertura das demais telas precisa ser conferida.

Não repetir a correção de abrir/fechar capítulos sem salvar. Não prometer aceleração apenas por dividir um arquivo grande em arquivos menores.

## 2. Rodada 1 — conter os riscos críticos e medir a abertura

### Segurança: Desfazer restrito à operação original

1. Substituir a fotografia integral por alterações identificadas por registro e campo, incluindo os efeitos derivados da mesma operação.
2. Ao desfazer, comparar o estado atual com o resultado da operação original. Preservar alterações posteriores, inclusive de outro usuário; se o mesmo campo divergir, pedir resolução em vez de sobrescrever.
3. Registrar a reversão sem remover o histórico original. Enquanto uma operação não tiver reversão segura, bloquear seu Desfazer antigo em vez de restaurar o projeto inteiro.

**Aceite:** alterar Cronograma, depois Produção/Medição/Almoxarifado e desfazer somente a primeira operação; os IDs, datas, quantidades e valores das demais alterações permanecem idênticos.

### Segurança: impedir exclusão operacional involuntária

1. Conferir tarefa, subtarefas e capítulo completo antes de excluir, procurando produção e vínculos com Medição, Diário, levantamentos e custos.
2. Na primeira entrega, bloquear exclusão física quando existirem fatos operacionais ou vínculos protegidos. Não apagar apontamentos para permitir a exclusão.
3. Exigir intenção explícita para exclusões permitidas, com IDs, versão esperada e auditoria. Uma coleção incompleta ou um item ausente da tela não autoriza apagar histórico.
4. Aplicar a proteção nos caminhos de interface e gravação, incluindo o caminho de compatibilidade. Se surgir necessidade de arquivamento, definir seu efeito nos totais e vínculos antes de introduzi-lo.

**Aceite:** reprogramar, mover capítulo, receber atualização remota e carregar dados parcialmente não reduz a contagem de apontamentos; tentativa de excluir item com produção é recusada sem alterar seus registros.

### Velocidade: linha de base verificável

- Medir abertura direta, primeira troca de aba e retorno à mesma aba: Cronograma, Produção, Rotina, Diário, Materiais, Medição, Custos e Almoxarifado.
- Separar tempo de sessão, consultas, transferência de arquivos, cálculos e exibição da tela utilizável.
- Comparar conjuntos fictícios pequenos e grandes, com primeira visita e visita com cache; repetir em computador e celular.
- Registrar mediana, percentil 95, número de consultas, volume transferido e travamentos perceptíveis. A análise de pacotes deve usar os resultados do processo automático, não tratar números antigos da documentação como medição atual.

**Entrega:** tabela antes/depois e escolha do primeiro gargalo com evidência. Nenhum teste de escrita ou exclusão na obra real.

## 3. Rodada 2 — recuperar edições tentadas e otimizar o gargalo medido

### Segurança: rascunho recuperável do Diário e formulários

- Guardar a edição tentada do Diário em rascunho durável por obra/data/usuário, separado da versão confirmada, antes de substituir qualquer estado após erro.
- Oferecer Reenviar, Comparar e Descartar; atualização remota não deve apagar o rascunho. Reenvio respeita a conciliação existente e não duplica fotos.
- Limpar somente a revisão de rascunho realmente confirmada, preservando edições mais novas na fila.
- Conferir também o indicador: o `finally` de `saveDailyReportDirectly` não deve transformar falha em confirmação; preservar o tratamento de erro já exibido pelo indicador.
- Mapear formulários ainda sem proteção, sobretudo Medição e Custos; ampliar os avisos de saída e a recuperação temporária sem transformar digitação em lançamento oficial.

**Aceite:** interromper uma gravação, navegar e reabrir; o conteúdo tentado continua recuperável e o conteúdo confirmado permanece íntegro. Testar em dados fictícios e com duas sessões de teste.

### Velocidade: mudar apenas o que a medição justificar

| Se o custo dominante for… | Menor intervenção proposta | Proteção obrigatória |
| --- | --- | --- |
| Muitas linhas montadas na tela | Virtualizar a lista de Produção/EAP ou limitar a exibição da Rotina; testar altura variável, foco e navegação | Desmontar uma linha não pode descartar edição nem apontamento. Busca e totais continuam abrangendo todos os registros. |
| Cálculos repetidos | Reutilizar resultados pelas dependências corretas e isolar atualização de linhas | Não reutilizar valores desatualizados de RUP, progresso ou calendário. |
| Leitura de histórico volumoso | Carregar detalhes sob demanda ou paginar onde os cálculos não exigem o conjunto completo | “Não carregado” nunca equivale a “vazio”. Não cortar os apontamentos necessários ao cálculo. |
| Consultas consecutivas ao retornar | Compartilhar a consulta em andamento e estabelecer intervalo mínimo medido | Não esconder edição remota nem atrasar a recuperação de conexão indevidamente. |
| Espera de arquivos da próxima tela | Ajustar a política ociosa existente com base nas jornadas medidas | Manter economia de dados, permissões e motores de documentos fora da pré-carga. |

**Meta inicial proposta:** reduzir em pelo menos 25% o percentil 95 da jornada escolhida, sob as mesmas condições. É uma meta a validar, não uma promessa; não aceitar regressão de integridade para atingi-la.

## 4. Rodada 3 — fechar lacunas entre abas

- Enumerar as operações que escapam das transações existentes: alterações em vários domínios, limites de volume e ausência de função.
- Coordenar versão e confirmação das filas existentes; não juntar todos os módulos em uma fila global sem demonstrar necessidade.
- Para operação que precisa ser indivisível, confirmar todos os seus registros e a versão na mesma transação; não dividir arbitrariamente a operação para caber no limite.
- Distinguir confirmação completa de confirmação parcial e manter a cópia pendente até leitura de verificação. Falha não pode autorizar exclusões inferidas.
- Verificar as revisões recuperáveis disponíveis no servidor antes de ampliar histórico. Toda migração necessária será descrita e validada previamente, sem backfill destrutivo, mudanças de permissões ou conversão automática dos registros antigos.

**Aceite:** falha de rede, conflito entre duas sessões e volume acima do limite resultam em confirmação integral ou pendência recuperável, nunca sucesso aparente com histórico silenciosamente removido.

## 5. Regras que nenhuma otimização pode alterar

- Datas, quantidades e IDs já registrados; data exata em que a execução atinge 100%.
- Produção por período sem inventar data de execução quando `log_date` é nulo.
- Bloqueio de aumento acima do contrato e histórico auditável de correções/cancelamentos.
- CPM, precedências, RUP/manual, jornada, dias úteis e feriados da obra.
- Operações atômicas/idempotentes do Almoxarifado, arquivos e marcações de plantas.
- Permissões atuais e separação entre empresas/obras.

## 6. Validação e evidência da melhoria

Para cada rodada, entregar:

1. Problema, alteração feita e limites da correção.
2. Comparação dos registros por ID, data, quantidade e vínculos — contagem sozinha não basta.
3. Testes de falha, concorrência, retorno à aba e troca de módulo em obra fictícia.
4. Tempo de abertura e quantidade de consultas antes/depois, em condições equivalentes.
5. Resultado do Preview e dos testes; publicação em produção somente após autorização.

### Detalhes técnicos principais

Áreas de intervenção: `Index.tsx` para reversão, coordenação e Diário; `TaskList.tsx` e `projectSync.ts` para intenção de exclusão e integridade; `cloudProjects.ts` para elegibilidade das confirmações; `projectDataScope.ts` para carregamento seguro; listas de Produção/Rotina e Gantt somente quando a medição indicar benefício.

Reutilizar e ampliar testes de sincronização, hidratação parcial, domínio atômico, Diário, navegação e fronteiras de carregamento. Antes de alterar funções do banco, verificar definição real, disponibilidade, permissões e compatibilidade da versão carregada. As evidências atuais são de código e sinais recentes; não comprovam a causa da perda histórica nem um ganho de desempenho ainda não medido.