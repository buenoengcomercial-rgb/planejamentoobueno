const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FiscalNoteItem = {
  description?: string;
  quantity?: number;
  unit?: string | null;
  unitPrice?: number;
  totalPrice?: number;
  category?: string | null;
  confidence?: number | null;
};

type FiscalNotePayload = {
  supplierName?: string | null;
  supplierCnpj?: string | null;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  totalAmount?: number | null;
  items?: FiscalNoteItem[];
  notes?: string | null;
  confidence?: number | null;
};

const systemPrompt = `Voce e um assistente especialista em ler notas fiscais brasileiras de materiais de obra a partir de imagens, paginas de PDF renderizadas e texto extraido de PDF.
Retorne apenas JSON valido no formato:
{
  "supplierName": string|null,
  "supplierCnpj": string|null,
  "invoiceNumber": string|null,
  "issueDate": "YYYY-MM-DD"|null,
  "totalAmount": number,
  "confidence": number,
  "items": [
    {
      "description": string,
      "quantity": number,
      "unit": string|null,
      "unitPrice": number,
      "totalPrice": number,
      "category": string|null,
      "confidence": number
    }
  ],
  "notes": string|null
}
Regras:
- Leia fornecedor/razao social, CNPJ, numero da nota, data de emissao, valor total e itens.
- Valores monetarios devem ser numeros em reais, com ponto decimal.
- Datas devem estar em YYYY-MM-DD.
- Nao invente dados ilegiveis; use null ou 0.
- Para itens, priorize materiais, descricao, quantidade, unidade, valor unitario e total.
- Quando houver texto extraido e imagem, use os dois para conferir os dados.
- "confidence" deve ser um numero entre 0 e 1 indicando o quao confiavel ficou a leitura (da nota e de cada item).
- Se a imagem/PDF estiver ruim, retorne os campos que conseguir e explique em "notes".`;

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
          description: String(item.description ?? "").trim(),
          quantity: Number(item.quantity ?? 1) || 1,
          unit: item.unit ? String(item.unit) : null,
          unitPrice: Number(item.unitPrice ?? 0) || 0,
          totalPrice: Number(item.totalPrice ?? 0) || 0,
          category: item.category ? String(item.category) : null,
          confidence: item.confidence != null ? Math.max(0, Math.min(1, Number(item.confidence))) : null,
        })).filter((item) => item.description)
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
