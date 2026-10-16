# Colaboração simultânea — implementação em andamento

## Contrato aprovado

Alterações independentes devem coexistir. Em colisão do mesmo campo, prevalece o
primeiro valor confirmado, com aviso e preservação da tentativa posterior.
Exclusão confirmada não pode ressuscitar por edição antiga. Respostas repetidas
não podem duplicar operações. Permissões, quantitativos, histórico e saldo
continuam sendo validados no servidor.

## Matriz da primeira entrega

| Área | Alteração preparada | Proteção / evidência local |
| --- | --- | --- |
| Diário | Impedir ressurreição de anexos e colisão de IDs | Testes de merge e persistência do rascunho |
| Medição | RPC v2 de entradas com comparação de campos e recibo idempotente | PostgreSQL/PGlite, recibo reconciliado e perda de resposta |
| Almoxarifado | RPCs v2 recebem registros alterados, preservam validação atômica original | Saldo, rollback, exclusão, permissões e repetição |
| Metadados / coleções | Rebase de campos independentes preserva origem de planejamento | Testes de registros, metadados e Index |
| Plantas | Atualização condicional por revisão envia campos alterados | Casos de campo independente e colisão |
| Equipe | Papel e situação com comparação do valor anterior | Testes de atualização condicional |
| Dashboard | Testar explicitamente liberação ociosa dos gráficos reais | Suíte completa, sem substituir gráficos por mocks |

As duas migrações são aditivas: não removem RPCs antigas nem alteram políticas
RLS. Funções novas de Medição e Almoxarifado verificam autorização antes dos
recibos e delegam a validação final às transações existentes. O helper e a tabela
de recibos ficam privados. Uma falha desfaz também recibo, auditoria e revisão.

## Pendências que impedem o aceite integral

- Migrar Produção, demais domínios normalizados e metadados para o contrato
  completo de operação no servidor; atualmente ainda usam CAS/rebase no cliente.
- Concluir recuperação durável por operação e retirar o conflito global dos
  caminhos ainda legados, preservando cada tentativa rejeitada.
- Atualizar tarefas remotas durante a digitação sem substituir a base esperada
  da edição em curso; a Medição ainda adia essa leitura durante edição.
- Completar conflitos de catálogo/ciclo/capturas na Medição e alterações
  administrativas que não são papel/situação de membros.
- Completar testes de duas retiradas reais concorrentes, anexos, troca de aba,
  desfazer, desconexão, reconexão e ordenação de eventos no novo fluxo completo.
- Revisão final das migrações, publicação do servidor, PR com `verify` aprovado,
  ativação dos clientes e validação com duas sessões no Lovable.

## Sequência de publicação

1. Revisar migrações e executar regressões, typecheck, lint dos arquivos alterados
   e build. Não mesclar esta entrega enquanto as pendências críticas acima
   permanecerem; o cliente novo requer as RPCs v2 instaladas.
2. Confirmar backend operacional `apydrmoggxiftayycnua`. O vínculo local do CLI
   estava apontando para outro projeto e não deve ser usado para publicar.
3. Instalar primeiro `20261016120000_concurrent_field_merge.sql`, depois
   `20261016121000_concurrent_warehouse_fields.sql`, em transação e pelo fluxo
   de migrações do backend correto; registrar as versões aplicadas.
4. Conferir assinatura, permissões e disponibilidade das RPCs novas; clientes
   antigos continuam usando as funções antigas durante a transição.
5. Após revisão e `verify`, mesclar PR e confirmar a mesma versão no Lovable e
   aplicativo publicado antes dos testes de aceitação.
6. Usar registros temporários reversíveis, verificar valores após recarga nas
   duas sessões e restaurar os dados. Registrar versão, cenário e resultado.

## Sessões observadas (16/10/2026)

O preview do projeto Lovable mostra `eng_kelper@outlook.com`; as abas do domínio
publicado mostram `obras_bueno@outlook.com` com perfil Almoxarife. Abas do mesmo
domínio/perfil compartilham autenticação. Isso fornece duas sessões distintas,
mas não comprova o comportamento do código novo, que ainda não foi publicado.
Não ampliar permissões para viabilizar testes de Medição.
