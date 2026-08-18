# Sincronização multiusuário e arquivos sem perda de dados

## Objetivo

Garantir que todos os usuários da mesma obra recebam alterações sem F5, que edições concorrentes não sobrescrevam dados silenciosamente e que notas, fotos e anexos nunca sejam colocados no `localStorage` como base64.

## Diagnóstico confirmado

- A publicação de tempo real existe, mas atualmente não contém nenhuma tabela; por isso outros navegadores não recebem eventos.
- O aplicativo só compara `projects.updated_at` a cada 15 segundos, ao voltar para a aba ou recuperar o foco.
- Enquanto existe uma edição ou salvamento pendente, essa conferência é adiada; uma atualização remota pode permanecer invisível até o próximo ciclo.
- O rascunho grava o objeto completo da obra no `localStorage` sem tratar `QuotaExceededError`.
- Os fluxos de fotos do Diário e anexos do Almoxarifado ainda convertem o arquivo para `dataUrl` quando o upload falha. Esse fallback leva arquivos binários para o projeto e provoca exatamente o erro de cota exibido.
- O lançamento de nota já usa upload estrito, mas o arquivo é enviado antes da confirmação do registro. Uma falha posterior pode deixar um objeto órfão.
- Existem hoje 96 objetos no armazenamento (91 MB); 81 deles, somando 66 MB, não possuem referência encontrada nos dados atuais. Eles não serão apagados sem uma reconciliação segura.
- O salvamento usa trava otimista no registro da obra, porém a atualização do registro principal ocorre antes da persistência das coleções normalizadas. Uma falha posterior pode deixar uma confirmação parcial.
- A tela atual de conflito preserva e restaura especificamente o Almoxarifado; ela não resolve de forma completa alterações concorrentes nos demais módulos.

## Implementação

### 1. Eliminar arquivos binários dos rascunhos

- Remover os fallbacks para `dataUrl` dos uploads do Almoxarifado e do Diário de Obra.
- Em falha de upload, manter o arquivo apenas no estado transitório da tela, mostrar a causa real e permitir tentar novamente; nenhum registro será confirmado sem `storagePath`.
- Sanitizar todo rascunho antes de persistir, removendo qualquer `dataUrl` legado e recusando payloads binários.
- Trocar o rascunho pesado do projeto por armazenamento local assíncrono em IndexedDB, mantendo no `localStorage` somente preferências leves e um pequeno marcador de recuperação.
- Tratar indisponibilidade/cota do armazenamento local sem interromper a edição; o usuário verá um aviso claro e o salvamento na nuvem continuará sendo tentado.

### 2. Upload transacional e recuperável

- Criar um registro local de uploads pendentes com obra, arquivo, caminho e operação que ainda precisa ser confirmada.
- Reutilizar o mesmo caminho/id em novas tentativas para não duplicar arquivos.
- Só marcar o upload como concluído depois que o registro da nota, foto ou equipamento for relido e confirmado na nuvem.
- Se a persistência falhar, preservar a referência para nova tentativa; se o usuário cancelar, remover o objeto provisório.
- Criar uma rotina conservadora de reconciliação dos objetos sem referência, com período de segurança e exclusão apenas de arquivos comprovadamente abandonados. Os 81 objetos atuais serão primeiro inventariados por obra/data antes de qualquer remoção.

### 3. Ativar eventos em tempo real

- Adicionar `projects` e todas as tabelas normalizadas usadas pela obra à publicação de tempo real por migration.
- Assinar um único canal por obra dentro de `useEffect`, filtrado pelo `project_id` quando suportado, e sempre remover o canal ao trocar de obra ou desmontar a tela.
- Agrupar eventos próximos em uma única atualização para evitar recargas repetidas durante um salvamento com várias linhas.
- Ignorar eventos originados pela confirmação local já conhecida e recarregar somente a obra afetada.

### 4. Concorrência sem sobrescrita silenciosa

- Manter uma versão-base completa da obra no armazenamento de recuperação.
- Ao receber alteração remota:
  - sem edição local: hidratar imediatamente a versão nova;
  - com alterações locais em entidades diferentes: aplicar merge de três vias (`base`, `local`, `remoto`) e salvar o resultado;
  - com alteração simultânea da mesma entidade/campo: bloquear o autosave e abrir comparação explícita, sem escolher automaticamente uma versão.
- Identificar coleções por `id`, preservando inclusões independentes e distinguindo inclusão, edição e exclusão.
- Ampliar a recuperação de conflito para todos os módulos, não apenas Almoxarifado.
- Impedir que um snapshot antigo em memória gere exclusões de registros criados por outro usuário.

### 5. Confirmação atômica do salvamento

- Criar uma função transacional no backend que valide usuário/organização, confira a versão esperada e confirme o registro principal junto das alterações das coleções normalizadas em uma única transação.
- Derivar o usuário exclusivamente da sessão autenticada; não confiar em identificador enviado pelo cliente.
- Retornar uma nova versão de confirmação. Em conflito, não aplicar nenhuma parte do lote.
- Preservar RLS, permissões por função e os papéis atuais da organização.

### 6. Estado e mensagens para o usuário

- Diferenciar claramente: enviando arquivo, salvando dados, confirmado, aguardando reconexão, conflito e erro de arquivo.
- Exibir a mensagem real de upload/persistência e oferecer “Tentar novamente” sem exigir novo preenchimento.
- Considerar “salvo” somente após reler a versão confirmada e os registros afetados.

## Detalhes técnicos

```text
arquivo selecionado
  -> upload com caminho idempotente
  -> fila local de confirmação
  -> transação: versão esperada + alterações por linha
  -> releitura e confirmação
  -> remove item da fila
  -> evento em tempo real para os outros usuários
```

A migration incluirá as tabelas: `projects`, `warehouse_movements`, `warehouse_requisitions`, `warehouse_custody`, `daily_reports`, `task_daily_logs`, `measurements`, `additives`, `audit_logs`, `stock_movements`, `material_price_history`, `budget_items`, `material_comparisons`, `analytic_compositions`, `eap_chapters` e `tasks`.

## Testes e validação

- Testes unitários para sanitização de rascunhos, falha de cota, merge de três vias, conflito no mesmo item e preservação de itens independentes.
- Testes dos uploads garantindo que falha nunca produz `dataUrl`, que nova tentativa reutiliza o caminho e que cancelamento remove o provisório.
- Teste transacional: provocar falha em uma coleção e confirmar que nenhuma parte do salvamento foi aplicada.
- Teste autenticado com dois navegadores na mesma obra:
  1. usuário A inclui uma nota e usuário B a recebe sem F5;
  2. ambos editam entidades diferentes e as duas alterações permanecem;
  3. ambos editam a mesma entidade e recebem comparação, sem sobrescrita;
  4. desconectar um navegador, editar, reconectar e confirmar recuperação;
  5. anexar PDF e fotos acima da antiga cota do `localStorage` e confirmar arquivo e registro na nuvem.
- Conferir no banco os autores, versões, registros normalizados e referências do armazenamento após cada cenário.