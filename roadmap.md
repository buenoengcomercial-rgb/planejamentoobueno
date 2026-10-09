# Proteção dos dados e desempenho

- [x] Restringir Desfazer a campos/registros da operação, com conflito e auditoria.
- [x] Bloquear exclusões operacionais involuntárias na interface e gravação; impedir exclusão quando há áreas não conferidas.
- [x] Preservar e recuperar rascunhos rejeitados do Diário.
- [x] Conferir formulários de Medição/Custos e proteger navegação.
- [x] Medir abertura e otimizar cálculo repetido da Rotina sem alterar regras.
- [x] Conferir caminhos mistos, limites e confirmação de salvamentos; manter transações existentes e bloqueio prévio às exclusões.
- [x] Validar com testes fictícios e Preview autenticado; não publicar.

## Limites desta entrega
- Ganho medido no cálculo da Rotina, não no carregamento completo em produção.
- Testes de alterações e recuperação usam dados fictícios; Preview real inspecionado sem gravar dados.
- A verificação de vínculos bloqueia exclusões com coleções não carregadas; não há nova consulta de integridade no servidor.
- Gravações cross-domain continuam com risco de confirmação parcial já existente; nenhuma migração nesta entrega.