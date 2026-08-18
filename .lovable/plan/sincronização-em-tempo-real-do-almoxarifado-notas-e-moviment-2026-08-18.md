# Sincronização em tempo real do Almoxarifado (notas e movimentações)

## Situação atual (verificada)

- O banco já está pronto: as 16 tabelas operacionais estão na publicação de tempo real e com identidade de réplica completa (eventos de inserção, alteração e exclusão são publicados).
- O app já abre um canal por obra em `src/pages/Index.tsx` e escuta `projects` + as tabelas normalizadas.
- As notas fiscais ficam dentro do JSON da obra (`projects.data_json`), então chegam pelo evento da tabela `projects`; movimentações vêm de `warehouse_movements` / `stock_movements`.

O que falha hoje, na prática, é a **aplicação** do evento, não a escuta:

1. Se existir qualquer diferença local não salva (o app está quase sempre com um rascunho aberto), o refresh em tempo real desvia para o fluxo de conflito e a tela **não** atualiza.
2. Não há retorno visual: mesmo quando atualiza, o usuário não sabe que veio de outro usuário.
3. Se o canal cair (rede instável, aba suspensa), não há nenhum plano B — a tela fica parada até um F5.
4. A própria gravação do usuário dispara evento e provoca uma recarga desnecessária da obra.

## O que será feito

1. **Aplicar a atualização em vez de bloquear**
   - Quando chega evento remoto e existe rascunho local, primeiro tentar persistir o rascunho e só depois recarregar a obra; o banner de conflito passa a ser exceção (apenas quando a gravação falha por versão).

2. **Ignorar os próprios eventos**
   - Marcar o instante e a versão da última gravação local e descartar eventos que correspondam a ela, evitando recarga em loop e piscadas na tela.

3. **Aviso discreto na interface**
   - Indicador de "Atualizado agora por outro usuário" no cabeçalho da obra e aviso curto ao aplicar mudanças remotas.

4. **Plano B quando o canal cai**
   - Acompanhar o estado da inscrição; se não estiver conectado, ativar checagem periódica de versão (a cada ~15s, só com a aba visível) e voltar a desligá-la quando o canal reconectar. Reinscrever ao voltar para a aba.

5. **Validação com duas sessões**
   - Teste automatizado com duas sessões autenticadas: a sessão A lança uma movimentação e uma nota fiscal, e a sessão B deve refletir as duas sem recarregar a página.

## Detalhes técnicos

- `src/pages/Index.tsx`: reescrever `refreshProjectFromRealtime` (salvar-então-recarregar), guardar `lastLocalSaveRef` para autofiltro, tratar `status` do `subscribe` para ligar/desligar o polling de reserva, e reinscrever em `visibilitychange`.
- Reaproveitar `persistProject`, `loadCloudProjectRecord` e `replaceProjectWithoutAutoSave` já existentes — sem mudanças de schema, RLS ou banco.
- Teste em `/tmp/browser/` com Playwright usando duas sessões de navegador.

Nada de migração de banco nesta etapa; o trabalho é todo no frontend de sincronização.
