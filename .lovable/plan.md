
## Contexto

A funcionalidade de envio de nota fiscal já existe em `WarehouseFiscalNotesTab.tsx` + Edge Function `read-fiscal-note` + `approveFiscalNote` em `src/lib/warehouse.ts`. Hoje ela já:

- Faz upload (PDF/PNG/JPG/JPEG/HEIC), extrai texto e/ou renderiza páginas e chama a IA
- Abre o modal de conferência editável (fornecedor, CNPJ, número, data, total, itens)
- Cria movimento de entrada e cria/vincula material no almoxarifado ao aprovar (match por descrição+unidade)
- Status `em_processamento | a_conferir | aprovada | rejeitada`

Vou completar o que está pedido sem mexer no visual nem nas outras abas (Materiais, Movimentações, Requisições, Equipamentos, Inventário, Relatórios).

## O que vou fazer

### 1. Formatos aceitos
- Adicionar **WEBP** ao input e à validação (manter PDF/PNG/JPG/JPEG; remover HEIC do texto exibido, mas manter aceito).

### 2. Detecção de duplicidade
- Antes de salvar no upload e ao Aprovar, checar notas existentes com **mesmo CNPJ + mesmo número + mesmo valor total**.
- Se houver, mostrar `confirm` com: "Esta nota fiscal aparentemente já foi cadastrada. Deseja continuar mesmo assim?".

### 3. Validações antes de Aprovar
- CNPJ válido (14 dígitos + dígito verificador real).
- Número da nota e fornecedor preenchidos.
- Pelo menos um item; quantidade > 0 em todos.
- Soma dos itens ≠ total → exibir aviso amarelo no topo do modal e pedir justificativa (campo "Observações") antes de aprovar.

### 4. Vínculo material por item (auto + manual + criar)
- Nova coluna **"Material vinculado"** na tabela de itens dentro do modal.
- Função `findMaterialMatch(description, unit, materials)` com normalização (lowercase, sem acento, remoção de palavras genéricas: "de", "para", "mm", abreviações comuns "sold"→"soldavel") + score Jaccard de tokens.
- Auto-preenche `itemKey` para matches com score ≥ 0.6 logo após a leitura da IA.
- Combobox por item com 3 opções:
  - Selecionar material existente
  - "Criar novo material" (inline → adiciona em `project.materials` + cria entrada em `warehouse.items` com `manualItem: true`)
  - "Deixar pendente" (sem `itemKey`, badge "Pendente de vínculo")
- Item sem vínculo manda a nota inteira para status complementar `pendente_vinculo` (computado a partir dos itens da nota aprovada — exibido como subtítulo/badge, não substitui `aprovada`).

### 5. Histórico de compras por material
- Já temos `warehouse.movements` com `invoiceNumber` e `attachments`. Adicionar:
  - botão "Histórico de compras" no `WarehouseStockTab.tsx` (linha do material) → abre dialog com tabela: data, NF, fornecedor, qtd, valor unit, arquivo (link).
  - Source: `movements.filter(m => m.itemKey === key && m.type === 'entrada')` + lookup da NF por `invoiceNumber`.

### 6. Coluna "Ações" na lista de notas
- Substituir a linha clicável por uma coluna com botões compactos: **Visualizar**, **Conferir/Editar** (abre o modal), **Aprovar**, **Rejeitar**, **Excluir** (com confirmação).
- "Visualizar arquivo" abre o `attachment.url` em nova aba.

### 7. Confiança da IA
- Aceitar `confidence` (0-1) no payload da Edge Function por item e por nota; exibir badge sutil ("IA 87%") ao lado do campo e do item quando presente. Sem mudanças destrutivas se a Function não retornar.

### 8. Indicadores superiores
- Já são derivados de `warehouse.items` (`plannedQuantity`, `purchasedQuantity`) e movimentos. Garantir que ao aprovar a nota:
  - `purchasedQuantity` é incrementado para materiais vinculados (hoje só faz isso para `manualItem`; passar a incrementar também para materiais planejados quando o item vem de NF).
  - Sem alterar a UI dos cards superiores.

## Arquivos afetados

- `src/components/warehouse/WarehouseFiscalNotesTab.tsx` — webp, duplicidade, validações, coluna Material vinculado, coluna Ações, badges de confiança
- `src/lib/warehouse.ts` — `findFiscalNoteDuplicate`, `findMaterialMatch`, ajuste em `approveFiscalNote` (incrementar `purchasedQuantity` mesmo em itens planejados; honrar `itemKey` definido na conferência), tipo `WarehouseFiscalNoteItem` ganha `confidence?` e `linkStatus?`
- `src/types/project.ts` — campos opcionais novos (`confidence`, `linkStatus`)
- `src/components/warehouse/WarehouseStockTab.tsx` — botão "Histórico" + dialog
- `supabase/functions/read-fiscal-note/index.ts` — pedir `confidence` no JSON schema (opcional, sem quebrar se vier ausente)

## Fora de escopo

- Nova tabela `notas_fiscais`/`nota_fiscal_itens` no banco — os dados continuam em `project.warehouse.fiscalNotes` (persistidos no `data_json` do projeto), seguindo o padrão atual da app. Migrar para tabelas dedicadas seria uma Etapa 8 separada.
- Mexer no visual dos cards superiores ou nas demais abas do almoxarifado.

Confirma que posso seguir nessa direção? Em particular: manter as notas dentro do `data_json` do projeto (como hoje) ou você quer que eu já crie tabelas dedicadas `notas_fiscais` e `nota_fiscal_itens` no banco?
