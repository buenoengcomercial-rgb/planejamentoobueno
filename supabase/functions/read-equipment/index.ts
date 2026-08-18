const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EquipmentPayload = {
  brand?: string | null;
  model?: string | null;
  serial?: string | null;
  category?: string | null;
  description?: string | null;
  confidence?: Partial<Record<"brand" | "model" | "serial" | "category" | "description", number>>;
};

const prompt = `Voce identifica equipamentos de construcao pertencentes a uma empresa a partir de ate tres fotos: equipamento completo, etiqueta do fabricante e numero de serie ou patrimonio.
Retorne APENAS JSON valido:
{
  "brand": string|null,
  "model": string|null,
  "serial": string|null,
  "category": string|null,
  "description": string|null,
  "confidence": { "brand": number, "model": number, "serial": number, "category": number, "description": number }
}
Nao invente texto ilegivel. Preserve pontuacao e zeros do numero de serie. A descricao deve identificar o tipo do equipamento sem afirmar propriedade. Cada confianca deve ficar entre 0 e 1.`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

const confidence = (value: unknown) => Math.max(0, Math.min(1, Number(value ?? 0) || 0));

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Metodo nao permitido" }, 405);
  try {
    const body = await request.json().catch(() => ({}));
    const imageUrls = Array.isArray(body.imageDataUrls)
      ? body.imageDataUrls.map((value: unknown) => String(value)).filter((value: string) => value.startsWith("data:image/")).slice(0, 3)
      : [];
    if (!imageUrls.length) return json({ error: "Envie ao menos uma foto do equipamento." }, 400);
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) return json({ error: "LOVABLE_API_KEY ausente para a leitura por IA." }, 500);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      body: JSON.stringify({
        model: Deno.env.get("LOVABLE_AI_MODEL") ?? "google/gemini-3-flash-preview",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: [
            { type: "text", text: "Leia as fotos, sugira os campos e informe a confianca de cada um." },
            ...imageUrls.map((url: string) => ({ type: "image_url", image_url: { url } })),
          ] },
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: data?.error?.message ?? data?.message ?? "Falha na leitura por IA." }, response.status);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return json({ error: "A IA nao retornou conteudo." }, 502);
    const parsed = JSON.parse(String(content)) as EquipmentPayload;
    return json({
      ok: true,
      equipment: {
        brand: parsed.brand ? String(parsed.brand).trim() : null,
        model: parsed.model ? String(parsed.model).trim() : null,
        serial: parsed.serial ? String(parsed.serial).trim() : null,
        category: parsed.category ? String(parsed.category).trim() : null,
        description: parsed.description ? String(parsed.description).trim() : null,
        confidence: {
          brand: confidence(parsed.confidence?.brand),
          model: confidence(parsed.confidence?.model),
          serial: confidence(parsed.confidence?.serial),
          category: confidence(parsed.confidence?.category),
          description: confidence(parsed.confidence?.description),
        },
      },
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
});
