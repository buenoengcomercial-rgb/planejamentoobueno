# Corrigir tela em branco por data inválida

## Objetivo
Impedir que uma tarefa com data inicial ausente ou inválida derrube a tela durante a criação ou atualização da linha de base.

## Alterações
- Validar a data e a duração antes de calcular o término da linha de base em `calculations.ts`.
- Usar uma representação local segura (`AAAA-MM-DD`) em vez de chamar `toISOString()` sobre uma data potencialmente inválida.
- Preservar tarefas já existentes e não alterar regras de RUP, dependências ou calendário.
- Adicionar testes cobrindo data válida, data vazia/inválida e duração inválida para evitar regressão.

## Verificação
- Executar os testes focados do motor de cálculos.
- Confirmar no Preview que a página de Produção abre sem tela em branco.
- Conferir o diagnóstico final do build.
