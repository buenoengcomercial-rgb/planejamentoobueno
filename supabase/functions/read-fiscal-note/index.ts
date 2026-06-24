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
  supplierName?: string | null;
  supplierCnpj?: string | null;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  totalAmount?: number | null;
  items?: FiscalNoteItem[];
  invoices?: FiscalInvoice[];
  notes?: string | null;
  confidence?: number | null;
};

const systemPrompt = `Voce e um assistente especialista em ler notas fiscais brasileiras (DANFE/NFe) de materiais de obra a partir de imagens, PDFs renderizados e texto extraido.
Retorne APENAS JSON valido neste formato:
{
  "supplierName": string|null,
  "supplierCnpj": string|null,
  "invoiceNumber": string|null,
  "issueDate": "YYYY-MM-DD"|null,
  "totalAmount": number,
  "confidence": number,
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
- Leia fornecedor, CNPJ, numero da nota, data de emissao, valor total e itens.
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

function normalizePayload(raw: FiscalNotePayload): FiscalNotePayload {
  return {
    supplierName: raw.supplierName ?? null,
    supplierCnpj: raw.supplierCnpj ?? null,
    invoiceNumber: raw.invoiceNumber ?? null,
    issueDate: raw.issueDate ?? null,
    totalAmount: Number(raw.totalAmount ?? 0) || 0,
    notes: raw.notes ?? null,
    confidence: raw.confidence != null ? Math.max(0, Math.min(1, Number(raw.confidence))) : null,
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
        text: `Extraia os dados desta nota fiscal de materiais. Arquivo: ${fileName}`,
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

    return jsonResponse({ ok: true, note: normalizePayload(parsed) });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
