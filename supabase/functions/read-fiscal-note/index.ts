import { resolveSupplierIdentity } from "./fiscalIdentity.ts";

const READER_VERSION = "issuer-address-v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FiscalNoteItem = {
  productCode?: string | null;
  description?: string;
  quantity?: number;
  unit?: string | null;
  unitPrice?: number;
  totalPrice?: number;
  category?: string | null;
  confidence?: number | null;
};

type FiscalInvoice = {
  number?: string | null;
  dueDate?: string | null;
  amount?: number | null;
  paymentMethod?: string | null;
  notes?: string | null;
};

type FiscalNotePayload = {
  accessKey?: string | null;
  supplierName?: string | null;
  supplierCnpj?: string | null;
  supplierState?: string | null;
  supplierCity?: string | null;
  supplierHeaderText?: string | null;
  supplierLocationText?: string | null;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  totalAmount?: number | null;
  items?: FiscalNoteItem[];
  invoices?: FiscalInvoice[];
  notes?: string | null;
  confidence?: number | null;
  documentType?: "nfe" | "nfce" | "cupom_fiscal" | "pedido_venda" | "orcamento" | "recibo" | "outro";
  documentTypeConfidence?: number | null;
};

const systemPrompt = `Voce e um assistente especialista em ler notas fiscais brasileiras (DANFE/NFe) de materiais de obra a partir de imagens, PDFs renderizados e texto extraido.
Retorne APENAS JSON valido neste formato:
{
  "accessKey": string|null,
  "supplierName": string|null,
  "supplierCnpj": string|null,
  "supplierState": "UF"|null,
  "supplierCity": string|null,
  "supplierHeaderText": string|null,
  "supplierLocationText": string|null,
  "invoiceNumber": string|null,
  "issueDate": "YYYY-MM-DD"|null,
  "totalAmount": number,
  "confidence": number,
  "documentType": "nfe"|"nfce"|"cupom_fiscal"|"pedido_venda"|"orcamento"|"recibo"|"outro",
  "documentTypeConfidence": number,
  "items": [
    {
      "productCode": string|null,
      "description": string,
      "quantity": number,
      "unit": string|null,
      "unitPrice": number,
      "totalPrice": number,
      "category": string|null,
      "confidence": number
    }
  ],
  "invoices": [
    {
      "number": string|null,
      "dueDate": "YYYY-MM-DD"|null,
      "amount": number,
      "paymentMethod": string|null,
      "notes": string|null
    }
  ],
  "notes": string|null
}
Regras:
- Primeiro classifique o documento. Pedido de venda, pedido de compra, orcamento, proposta e recibo NAO sao nota fiscal e nunca devem ser classificados como NF-e.
- Use "nfe", "nfce" ou "cupom_fiscal" apenas quando houver evidencia fiscal clara (DANFE, chave de acesso, NFC-e ou cupom fiscal de compra).
- Avalie obrigatoriamente o cabecalho e o endereco do EMITENTE para identificar a UF do fornecedor. O emitente fica antes do titulo DESTINATARIO/REMETENTE. Nunca use nenhum municipio ou UF que esteja depois desse titulo.
- Transcreva em supplierHeaderText o bloco visivel do emitente contendo razao social, CNPJ, endereco, municipio e UF. Retorne em supplierCity somente o municipio do emitente.
- Em supplierLocationText copie literalmente a linha do endereco do EMITENTE que contem cidade e UF, por exemplo "Jundiai/SP" ou "SAO PAULO - SP". Se municipio e UF estiverem em campos separados, transcreva os dois juntos.
- supplierCnpj deve ser exclusivamente o numero que aparece logo abaixo ou ao lado do rotulo CNPJ/CPF no cabecalho do EMITENTE, antes de NATUREZA DA OPERACAO e antes de DESTINATARIO/REMETENTE.
- Nunca use como supplierCnpj a inscricao estadual, a chave de acesso ou o CNPJ/CPF do destinatario/remetente. Inclua literalmente em supplierHeaderText o rotulo CNPJ/CPF do emitente e seu numero para validacao.
- Quando houver uma localizacao como "Jundiai/SP", "JUNDIAI - SP", "UF: SP" ou o nome completo "Sao Paulo", supplierState deve ser "SP". Associe somente siglas oficiais: AC, AL, AP, AM, BA, CE, DF, ES, GO, MA, MT, MS, MG, PA, PB, PR, PE, PI, RJ, RN, RS, RO, RR, SC, SP, SE e TO.
- Em accessKey transcreva exatamente os 44 digitos impressos abaixo do rotulo CHAVE DE ACESSO somente para conferencia do CNPJ. A chave nunca deve ser usada para escolher supplierState.
- Leia fornecedor, CNPJ, UF do endereco do emitente, numero da nota, data de emissao, valor total e itens.
- supplierState deve conter apenas a sigla brasileira de duas letras quando estiver legivel no endereco do emitente; nunca use a UF do destinatario e nunca deduza a UF apenas pelo CNPJ.
- Para CADA item extraia o codigo da coluna "COD. PROD.", "Cod. Prod.", "Codigo", "Cod.", "Ref." ou similar como "productCode" — esse codigo e essencial.
- Leia tambem a secao FATURA/DUPLICATAS/COBRANCA/PARCELAS quando existir e devolva no array "invoices" cada parcela com numero (ex.: 001, 002), data de vencimento e valor. Se houver apenas uma cobranca/boleto, devolva uma unica linha em "invoices". "paymentMethod" pode ser "Boleto", "PIX", "Cartao", "A vista", etc., quando explicitado.
- Se a nota nao trouxer faturas, devolva "invoices": [].
- Valores monetarios devem ser numeros em reais (ponto decimal).
- Datas em YYYY-MM-DD.
- Nao invente dados ilegiveis; use null ou 0.
- "confidence" deve ser numero entre 0 e 1.
- Se a imagem estiver ruim, retorne o que conseguir e explique em "notes".`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePayload(raw: FiscalNotePayload, extractedText = ""): FiscalNotePayload {
  const documentTypes = new Set(["nfe", "nfce", "cupom_fiscal", "pedido_venda", "orcamento", "recibo", "outro"]);
  const supplierIdentity = resolveSupplierIdentity({
    accessKey: raw.accessKey,
    extractedText,
    supplierHeaderText: raw.supplierHeaderText,
    supplierLocationText: raw.supplierLocationText,
    supplierCity: raw.supplierCity,
    supplierState: raw.supplierState,
    supplierName: raw.supplierName,
    supplierCnpj: raw.supplierCnpj,
  });
  return {
    supplierName: raw.supplierName ?? null,
    supplierCnpj: supplierIdentity.supplierCnpj ?? null,
    supplierState: supplierIdentity.supplierState ?? null,
    supplierCity: raw.supplierCity ?? null,
    supplierHeaderText: raw.supplierHeaderText ?? null,
    supplierLocationText: raw.supplierLocationText ?? null,
    invoiceNumber: raw.invoiceNumber ?? null,
    issueDate: raw.issueDate ?? null,
    totalAmount: Number(raw.totalAmount ?? 0) || 0,
    notes: raw.notes ?? null,
    confidence: raw.confidence != null ? Math.max(0, Math.min(1, Number(raw.confidence))) : null,
    documentType: raw.documentType && documentTypes.has(raw.documentType) ? raw.documentType : "outro",
    documentTypeConfidence: raw.documentTypeConfidence != null
      ? Math.max(0, Math.min(1, Number(raw.documentTypeConfidence)))
      : null,
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => ({
          productCode: item.productCode ? String(item.productCode).trim() : null,
          description: String(item.description ?? "").trim(),
          quantity: Number(item.quantity ?? 1) || 1,
          unit: item.unit ? String(item.unit) : null,
          unitPrice: Number(item.unitPrice ?? 0) || 0,
          totalPrice: Number(item.totalPrice ?? 0) || 0,
          category: item.category ? String(item.category) : null,
          confidence: item.confidence != null ? Math.max(0, Math.min(1, Number(item.confidence))) : null,
        })).filter((item) => item.description)
      : [],
    invoices: Array.isArray(raw.invoices)
      ? raw.invoices.map((inv) => ({
          number: inv.number ? String(inv.number).trim() : null,
          dueDate: inv.dueDate ? String(inv.dueDate).trim() : null,
          amount: Number(inv.amount ?? 0) || 0,
          paymentMethod: inv.paymentMethod ? String(inv.paymentMethod).trim() : null,
          notes: inv.notes ? String(inv.notes).trim() : null,
        })).filter((inv) => inv.amount > 0 || inv.dueDate || inv.number)
      : [],
  };
}

async function callLovableAiGateway(input: {
  model: string;
  userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
}) {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    return {
      ok: false as const,
      status: 500,
      error: "LOVABLE_API_KEY ausente. Habilite o conector Lovable AI/Lovable Cloud neste projeto para usar a IA nativa do Lovable.",
    };
  }

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: input.userContent,
        },
      ],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const gatewayError =
      response.status === 402
        ? "Creditos da IA do Lovable esgotados. Adicione creditos na workspace do Lovable."
        : response.status === 429
          ? "Limite de requisicoes da IA do Lovable atingido. Tente novamente em instantes."
          : data?.error?.message ?? data?.message ?? "Falha ao chamar a IA do Lovable.";

    return { ok: false as const, status: response.status, error: gatewayError };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false as const, status: 502, error: "IA do Lovable nao retornou conteudo." };
  }

  return { ok: true as const, content: String(content) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Metodo nao permitido" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const fileDataUrl = String(body.fileDataUrl ?? "");
    const fileDataUrls = Array.isArray(body.fileDataUrls)
      ? body.fileDataUrls.map((url: unknown) => String(url)).filter((url: string) => url.startsWith("data:image/")).slice(0, 4)
      : [];
    if (fileDataUrl.startsWith("data:image/") && fileDataUrls.length === 0) {
      fileDataUrls.push(fileDataUrl);
    }
    const extractedText = String(body.extractedText ?? "").trim().slice(0, 20000);
    const supplierHeaderImageDataUrl = String(body.supplierHeaderImageDataUrl ?? "");
    const fileName = String(body.fileName ?? "nota-fiscal");

    if (fileDataUrls.length === 0 && !extractedText) {
      return jsonResponse({ error: "Envie imagem em data URL ou texto extraido do PDF para leitura por IA." }, 400);
    }

    const model = Deno.env.get("LOVABLE_AI_MODEL") ?? "google/gemini-3-flash-preview";
    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [
      {
        type: "text",
        text: `Classifique o documento e extraia seus dados. Nao presuma que seja nota fiscal. Arquivo: ${fileName}`,
      },
    ];
    if (extractedText) {
      userContent.push({
        type: "text",
        text: `Texto extraido do PDF para apoio:\n${extractedText}`,
      });
    }
    for (const url of fileDataUrls) {
      userContent.push({
        type: "image_url",
        image_url: { url },
      });
    }
    if (supplierHeaderImageDataUrl.startsWith("data:image/")) {
      userContent.push({
        type: "text",
        text: "RECORTE AMPLIADO DO CABECALHO DO EMITENTE. Antes de DESTINATARIO/REMETENTE, localize a cidade e a UF da empresa fornecedora. Copie a linha literalmente em supplierLocationText, devolva a cidade em supplierCity e a sigla em supplierState. Exemplos: Jundiai/SP deve resultar SP; SAO PAULO - SP deve resultar SP. Nao use destinatario, transportadora ou local de entrega.",
      });
      userContent.push({
        type: "image_url",
        image_url: { url: supplierHeaderImageDataUrl },
      });
    }

    const ai = await callLovableAiGateway({ model, userContent });
    if (!ai.ok) {
      return jsonResponse({ error: ai.error }, ai.status);
    }

    let parsed: FiscalNotePayload;
    try {
      parsed = JSON.parse(ai.content);
    } catch {
      return jsonResponse({ error: "IA retornou JSON invalido.", raw: ai.content }, 502);
    }

    return jsonResponse({ ok: true, readerVersion: READER_VERSION, note: normalizePayload(parsed, extractedText) });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
