# Reduzir o consumo de créditos da leitura por IA (notas e fotos)

## O que os registros mostram

Nos últimos dias cada leitura no Almoxarifado gastou entre 0,015 e 0,038 crédito, com este padrão:

- A entrada é pequena (cerca de 3.500 tokens), mas a **saída chega a 1.300–2.600 tokens** — o modelo `gemini-3-flash-preview` gera "raciocínio" antes do JSON, e isso é cobrado como saída. É aí que está a maior parte do custo.
- Os registros aparecem **em pares poucos segundos depois um do outro** com a mesma entrada (ex.: 13:44:47 e 13:44:59), indicando que **uma mesma leitura está chamando a IA duas vezes** e dobrando o custo.
- Cada chamada envia até 4 páginas/fotos em alta resolução **mais um recorte ampliado do cabeçalho** (imagem extra) e o texto do PDF (até 20.000 caracteres) — parte disso é redundante quando o texto do PDF já traz os dados.

Antes o leitor era mais simples: menos imagens por chamada, sem recorte extra de cabeçalho e prompt mais curto. As melhorias de precisão da UF do emitente aumentaram o custo por leitura.

## Como reduzir (mantendo a precisão)

1. **Eliminar a chamada duplicada** — investigar e corrigir a origem do segundo disparo por leitura (o ganho é imediato: até 50%).
2. **Cortar o "raciocínio" do modelo** — enviar configuração de baixo esforço de raciocínio na chamada, já que a resposta é um JSON estruturado. Reduz muito os tokens de saída.
3. **Enviar o recorte do cabeçalho só quando necessário** — usar a imagem extra apenas se a UF/cidade do emitente não tiver sido identificada com segurança pelo texto, em vez de sempre.
4. **Otimizar as imagens antes de enviar** — reaproveitar a mesma compactação já usada nas fotos de equipamento (lado máximo ~1280 px, JPEG) e reduzir a escala de renderização do PDF; limitar a 2 páginas por padrão (a 3ª e 4ª só se o texto vier vazio).
5. **Enxugar o prompt e o texto extraído** — prompt do sistema mais curto e limite de texto do PDF de 20.000 para ~8.000 caracteres, priorizando o trecho do cabeçalho e da tabela de itens.
6. **Rota barata quando há texto** — se o PDF tiver texto legível (DANFE nativo), enviar somente texto, sem imagens.

Expectativa: queda de aproximadamente 60–75% no custo por leitura, sem perder a leitura correta do emitente, dos itens e das parcelas.

## Detalhes técnicos

- `supabase/functions/read-fiscal-note/index.ts`: adicionar `reasoning_effort`/configuração de raciocínio baixo, encurtar `systemPrompt`, reduzir o corte de `extractedText`, tornar opcional o uso de `supplierHeaderImageDataUrl`.
- `src/components/warehouse/WarehouseFiscalNotesTab.tsx`: rastrear e bloquear a segunda invocação (guarda de execução em `processing`/`retryExtraction`), reduzir `scale` em `extractPdf`, aplicar compactação de imagem antes de montar `urls`, gerar o recorte de cabeçalho apenas sob demanda.
- Reutilizar `optimizeEquipmentPhoto` (`src/lib/equipmentPhotoOptimization.ts`) para as fotos de nota.
- Validar com uma leitura real de nota em PDF e uma em foto, comparando os créditos gastos nos registros do gateway antes/depois e confirmando `readerVersion`, `supplierState` e itens.
