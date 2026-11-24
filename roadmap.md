# Proteção dos dados e desempenho

## Medição: registro único por lote
- [x] Eliminar a repetição de todas as edições ao preparar cada versão local do lote; seis alterações passaram de 27 para seis mutações no teste, com somente um evento consolidado e sua identidade.
- [x] Testar seis linhas, valores finais, exclusões, falhas e confirmação; 114 testes focados, 1.843 testes de regressão (um ignorado preexistente), 15 verificações de integridade e ESLint passaram.
- [x] Validar na Medição autenticada: seis comentários de linhas existentes enviados somente ao sair, em um único comando/registro; navegação e confirmação em 4,78 s. Releitura conferida, comentários originais restaurados em um segundo lote, total inalterado, nenhum erro de página. Sem migração, exclusão do histórico ou publicação; auditoria compacta e controles fiscais preservados.

## Medição: lote automático e saída protegida
- [x] Agrupar exclusões independentes com edições, preservando vínculos e validações; operações que alteram plantas mantêm o caminho transacional separado.
- [x] Consolidar alterações ainda não enviadas enquanto outra gravação aguarda resposta; saída força envio e espera confirmação, sem reescrever comandos já enviados.
- [x] Testar seis linhas, envio em andamento, falha e proteção da navegação; 119 testes focados, 99 testes de persistência, ESLint e regressão (1.841 testes, 15 verificações de integridade) passaram.
- [x] Validar fluxo autenticado com seis linhas temporárias sem quantidade na 3ª medição: criação, navegação, releitura, exclusão, navegação e restauração conferidas; total inalterado e nenhum erro de página. Saída: 9,2 s na criação e 5,7 s na exclusão (dois envios, incluindo lote já iniciado); sem promessa de confirmação em dois segundos ou publicação.

- [x] Estabilizar o contexto de autenticação contra divergência durante atualização de módulos; testes de sessão e regressão passaram, Medição autenticada abriu sem o erro e sem editar dados.

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