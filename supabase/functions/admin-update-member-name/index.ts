import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth.user) return json({ error: "Não autenticado" }, 401);

    const body = await req.json().catch(() => ({}));
    const organizationId = String(body.organization_id ?? "");
    const userId = String(body.user_id ?? "");
    const name = String(body.name ?? "").trim();
    if (!organizationId || !userId || !name || name.length > 120) return json({ error: "Nome ou identificação inválidos" }, 400);

    const { data: caller } = await admin.from("organization_members").select("id").eq("organization_id", organizationId).eq("user_id", auth.user.id).eq("status", "active").in("role", ["owner", "admin"]).maybeSingle();
    if (!caller) return json({ error: "Sem permissão para atualizar usuários desta empresa" }, 403);

    const { data: target } = await admin.from("organization_members").select("id").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
    if (!target) return json({ error: "Usuário não pertence a esta empresa" }, 404);

    const { data: targetUser, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !targetUser.user) return json({ error: "Usuário não encontrado" }, 404);
    const metadata = { ...(targetUser.user.user_metadata ?? {}), name };
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(userId, { user_metadata: metadata });
    if (authUpdateError) throw authUpdateError;

    const { error: profileError } = await admin.from("profiles").upsert({ user_id: userId, name, email: targetUser.user.email ?? null }, { onConflict: "user_id" });
    if (profileError) throw profileError;
    return json({ ok: true, name });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erro ao atualizar nome" }, 500);
  }
});
