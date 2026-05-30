# Etapa 6 — Mover `phases[]` e `tasks[]` do `data_json` para tabelas dedicadas

## Por quê

Depois das Etapas 1-5, o `data_json` ficou em ~215 KB num projeto real. Praticamente tudo o que sobra é a árvore da EAP (`phases` → `children`/`tasks`). É a última grande coleção de alto crescimento — e a mais sensível, porque alimenta CPM, Gantt, medição e dashboard.

## Escopo

**Entra:**
- Capítulos (`phases[]` e `phases[].children[]` recursivos) → tabela `eap_chapters`
- Tarefas folha (`phases[]...tasks[]`) → tabela `tasks`
- Hidratação reconstrói a árvore exatamente como hoje, preservando ordem e hierarquia
- Sync incremental por linha (mesmo padrão `diffAndSync` das etapas anteriores)

**Não entra:**
- Refatoração do CPM (continua rodando em memória sobre o `Project` hidratado)
- Mudanças de UI/Gantt
- `project_history` (fica para etapa futura)

## Modelo de dados

```text
eap_chapters
  id (text)           -- mesmo id usado hoje no JSON
  project_id (uuid)
  parent_id (text)    -- null = raiz (phase de topo)
  order_index (int)   -- posição entre irmãos
  name, code, ...     -- demais campos em `data jsonb`
  created_at, updated_at

tasks
  id (text)
  project_id (uuid)
  chapter_id (text)   -- FK lógica para eap_chapters.id
  order_index (int)
  -- campos "quentes" para query/índice:
  start_date, end_date, duration_days, progress, status,
  -- restante (RUP, recursos, predecessoras, etc.) em `data jsonb`
  created_at, updated_at

INDEX(project_id, parent_id, order_index)   -- chapters
INDEX(project_id, chapter_id, order_index)  -- tasks
```

RLS idêntica às demais tabelas normalizadas (`is_org_member` para SELECT, `has_org_role` para escrita).

## Plano de execução

1. **Migração de schema** — criar `eap_chapters` + `tasks` + GRANTs + RLS + índices.
2. **Backfill one-shot** — função recursiva PL/pgSQL que percorre `data_json->'phases'` e insere capítulos/tarefas mantendo `parent_id` e `order_index`.
3. **Hidratação** (`projectSync.ts`) — após carregar o projeto, montar `phases[]` a partir das duas tabelas (reconstrução da árvore via `parent_id`).
4. **Strip** — remover `phases` do `data_json` antes de salvar (igual fizemos com as outras coleções).
5. **Sync incremental** — `diffAndSync` para `eap_chapters` e `tasks`, com upsert por id.
6. **Cleanup** — segunda migração apaga `phases` do `data_json` dos projetos existentes (só depois da hidratação validada).

## Riscos & mitigação

- **CPM depende da árvore montada corretamente** → hidratação reconstrói a estrutura idêntica ao formato atual antes de qualquer cálculo rodar.
- **Ordem dos irmãos importa para o Gantt** → `order_index` explícito, preenchido no backfill e mantido no sync.
- **Sync incremental pode mandar muitas linhas na primeira gravação** → mitigado porque o `diffAndSync` compara `prev` vs `next` em memória.
- **Rollback**: manter `data_json.phases` populado por 1 release (steps 1-5 sem step 6) antes do cleanup.

## Validação

- Abrir projeto: Gantt, EAP, CPM e dashboard mostram exatamente o mesmo conteúdo.
- Editar uma tarefa: salva em <1 s sem reenviar o projeto inteiro.
- Adicionar/remover capítulo: hierarquia persiste após reload.
- `pg_column_size(data_json)` cai de ~215 KB para <30 KB.

Posso seguir com a migração de schema + backfill?
