# Proteção dos dados e desempenho

- [x] Separar os botões PDF do dia e PDF da medição do aviso de salvamento; ambos acessíveis no Diário autenticado.
- [x] Exportar todos os diários preenchidos confirmados na nuvem no intervalo inclusivo da medição selecionada, sem incluir dias vazios; Medição Nº 1 verificada com 31 diários em PDF de 91 páginas.

- [x] Corrigir a referência de permissões do Diário; edição, foto e conclusão confirmadas após recarregar em obra temporária autenticada, removida ao final. Os 40 diários e 782 fotos existentes foram preservados.

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