const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FiscalNoteItem = {
  description?: string;
  quantity?: number;
  unit?: string | null;
  unitPrice?: number;
  totalPrice?: number;
  category?: string | null;
};

type FiscalNotePayload = {
  supplierName?: string | null;
  supplierCnpj?: string | null;
  invoiceNumber?: string | null;
  issueDate?: string | null;
  totalAmount?: number | null;
  items?: FiscalNoteItem[];
  notes?: string | null;
};

const systemPrompt = `Voce e um assistente especialista em ler notas fiscais brasileiras de materiais de obra a partir de imagens.
Retorne apenas JSON valido no formato:
{
  "supplierName": string|null,
  "supplierCnpj": string|null,
  "invoiceNumber": string|null,
  "issueDate": "YYYY-MM-DD"|null,
  "totalAmount": number,
  "items": [
    {
      "description": string,
      "quantity": number,
      "unit": string|null,
      "unitPrice": number,
      "totalPrice": number,
      "category": string|null
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
- Se a imagem estiver ruim, retorne os campos que conseguir e explique em "notes".`;

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
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => ({
          description: String(item.description ?? "").trim(),
          quantity: Number(item.quantity ?? 1) || 1,
          unit: item.unit ? String(item.unit) : null,
          unitPrice: Number(item.unitPrice ?? 0) || 0,
          totalPrice: Number(item.totalPrice ?? 0) || 0,
          category: item.category ? String(item.category) : null,
        })).filter((item) => item.description)
      : [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Metodo nao permitido" }, 405);

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return jsonResponse({
        error: "OPENAI_API_KEY nao configurada nos secrets da Supabase Edge Function.",
      }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const fileDataUrl = String(body.fileDataUrl ?? "");
    const fileName = String(body.fileName ?? "nota-fiscal");

    if (!fileDataUrl.startsWith("data:image/")) {
      return jsonResponse({ error: "Envie uma imagem em data URL para leitura por IA." }, 400);
    }

    const model = Deno.env.get("OPENAI_VISION_MODEL") ?? "gpt-4o-mini";
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Extraia os dados desta nota fiscal de materiais. Arquivo: ${fileName}`,
              },
              {
                type: "image_url",
                image_url: { url: fileDataUrl },
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return jsonResponse({
        error: data?.error?.message ?? "Falha ao chamar IA de leitura da nota.",
      }, response.status);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return jsonResponse({ error: "IA nao retornou conteudo." }, 502);

    let parsed: FiscalNotePayload;
    try {
      parsed = JSON.parse(content);
    } catch {
      return jsonResponse({ error: "IA retornou JSON invalido.", raw: content }, 502);
    }

    return jsonResponse({ ok: true, note: normalizePayload(parsed) });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
