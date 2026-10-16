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

As migrações preservam as RPCs antigas e as políticas das tabelas operacionais.
Medição e Almoxarifado conferem autorização antes dos recibos e delegam a
validação final às transações existentes. Seus recibos ficam privados. O escritor
dos demais domínios usa SECURITY INVOKER e recibos com RLS por usuário/obra.
Uma falha desfaz também recibo, auditoria e revisão.

## Segunda entrega

- Produção, metadados, Medição legada, Aditivo, Materiais e Custos enviam os
  registros/campos esperados. Operações que integram vários domínios continuam
  na mesma transação, com rollback integral.
- Captura de Produção combina marcação e quantitativo com validações fiscais,
  vínculo e limite existentes; repetição retorna os registros atuais.
- Medição independente guarda bases e tentativas duráveis. Entradas, catálogo,
  capturas, exclusão vinculada e ciclo fiscal comparam os registros envolvidos.
  Confirmar um período depende dos quantitativos daquele período.
- Retirada, complemento e correção usam a operação v2 e as validações originais
  de saldo. A fila por usuário/obra conserva identificador e conteúdo após falha
  de rede; a tela permite conferir e baixar a tentativa.
- Formulários do Almoxarifado guardam a base da edição. Estoque mínimo não
  remonta durante digitação; cada linha de contagem conserva sua própria base.
- Notificação remota não abre descarte global; colisões de gravação ficam no
  painel de operações. Rascunhos legados sem base conservam a recuperação
  explícita para evitar assumir valores anteriores inexistentes.
- Nome de membro atualiza perfil e identificação de auditoria atomicamente,
  com comparação do nome anterior e mesma autoridade owner/admin.
- Renomeação da obra compara o nome visto ao iniciar a edição, conserva a
  tentativa em caso de rejeição e não bloqueia por revisão de outro campo.

Regressões novas incluem retiradas disputando saldo, recibos repetidos após
edição posterior, captura independente, exclusão versus edição de marcação,
fechamento fiscal concorrente, lote duplicado, rollback entre domínios,
preservação de digitação e bases separadas de contagem.

## Pendências que impedem o aceite integral

- Executar a suíte completa sobre o diff final estável e revisar as migrações.
- Publicar servidor, obter `verify` no commit final da PR, ativar o cliente.
- Validar duas sessões reais, conferir recarga e restaurar os dados temporários.
  Ainda não há evidência de aceite operacional da versão nova.

## Evidências de liberação — 16/10/2026

- `verify:regression` final local: exit 0; 199 arquivos, 1444 testes aprovados,
  1 previamente ignorado; 15 testes adicionais do servidor; TypeScript e build
  aprovados. Lint dos arquivos tocados sem erros, com um aviso preexistente de
  dependência de hook em TeamManagement.
- As seis migrações passaram por ensaio transacional com ROLLBACK no banco
  operacional e foram aplicadas em uma única transação antes do cliente novo.
- As seis versões constam em `supabase_migrations.schema_migrations`; o MD5
  de `statements[1]` de cada versão coincide com o arquivo local revisado.
- Publicação do cliente e testes com duas contas ainda pendentes neste registro.

## Sequência de publicação

1. Revisar migrações e executar regressões, typecheck, lint dos arquivos alterados
   e build. Não mesclar esta entrega enquanto as pendências críticas acima
   permanecerem; o cliente novo requer as RPCs v2 instaladas.
2. Confirmar backend operacional `apydrmoggxiftayycnua`. O vínculo local do CLI
   estava apontando para outro projeto e não deve ser usado para publicar.
3. Instalar em ordem as migrações `20261016120000` (merge/entradas),
   `20261016121000` (Almoxarifado por registro), `20261016122000` (domínios e
   captura de Produção), `20261016123000` (retiradas), `20261016124000`
   (comandos da Medição) e `20261016125000` (nome administrativo), em transação
   no backend correto; registrar as versões e hashes aplicados.
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
