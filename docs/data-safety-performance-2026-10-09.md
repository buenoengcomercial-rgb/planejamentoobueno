# Proteção dos dados e desempenho — primeira entrega

## Alterações
- Desfazer aplica diferenças por campo/registro e bloqueia conflitos com edições posteriores; mantém auditoria existente e registra a reversão. Almoxarifado e Diário utilizam correções específicas, não reversão genérica.
- Exclusões de tarefas com apontamentos, progresso ou vínculos são bloqueadas. A gravação exige intenção auditada nova e bloqueia exclusões se as coleções necessárias à verificação ainda não foram carregadas. Remover capítulo não autoriza apagar produção.
- Diário mantém rascunho separado por usuário/obra/data antes da gravação, preservando campos e referências de anexos; permite comparar, reenviar ou descartar com confirmação. Somente a revisão confirmada pode ser limpa.
- Formulários de custos e correções de medição registram preenchimentos pendentes para a proteção de navegação existente.
- Rotina calcula o calendário de cada tarefa uma vez por chamada, reutilizando-o entre os dias. Não existe cache persistente que possa esconder alterações de calendário ou quantidade.

## Medição controlada
Mesmo script, ambiente e obra fictícia: 500 tarefas, 60 dias úteis de duração, 2.500 cartões de atividade, calendário de Cuiabá; 15 amostras após 2 aquecimentos.

| Cálculo buildWeeklyRoutine | Antes | Depois |
|---|---:|---:|
| Mediana | 989,07 ms | 290,17 ms |
| P95 | 1.136,27 ms | 343,34 ms |

Redução de 70,7% na mediana do cálculo. **Não representa redução equivalente na abertura completa da página.**

## Prévia e limites
- Produção e Rotina abriram autenticadas, sem erros JavaScript observados; nenhum formulário real foi enviado.
- Uma navegação completa até o título de Produção levou 11,74 s no servidor de desenvolvimento. Amostra única, sem comparativo anterior válido; não serve como prova de ganho na abertura.
- Testes cobrem registros fictícios, sincronização seletiva, transações existentes, conflitos de Desfazer e revisão de rascunho.
- Sem gravações no banco, migrações, exclusões de arquivos ou publicação.
- Integridade definitiva de exclusões precisa de verificação no servidor para proteger também outros clientes. Nesta entrega o cliente bloqueia situações incompletas.
- Gravações de múltiplos domínios ainda podem ter confirmação parcial, com proteção e tratamento existentes; esta entrega não adiciona transações de banco.