import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Role = "owner" | "admin" | "engineer" | "field_user" | "viewer";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes.user) {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const callerId = userRes.user.id;

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = body.name ? String(body.name).trim() : null;
    const role = String(body.role ?? "field_user") as Role;
    const organizationId = String(body.organization_id ?? "");

    if (!email || !password || !organizationId) {
      return new Response(JSON.stringify({ error: "Dados obrigatórios faltando" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Senha precisa ter pelo menos 6 caracteres" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verificar se quem chama é owner/admin da organização
    const { data: hasRole, error: roleErr } = await admin.rpc("has_org_role", {
      _user_id: callerId,
      _org_id: organizationId,
      _roles: ["owner", "admin"],
    });
    if (roleErr || !hasRole) {
      return new Response(JSON.stringify({ error: "Sem permissão para criar acessos nesta empresa" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Procurar se já existe usuário com esse e-mail
    let targetUserId: string | null = null;
    const { data: existingProfile } = await admin
      .from("profiles")
      .select("user_id")
      .ilike("email", email)
      .maybeSingle();

    if (existingProfile?.user_id) {
      targetUserId = existingProfile.user_id;
    } else {
      // Tentar criar novo usuário no auth
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: name ? { name } : undefined,
      });
      if (createErr || !created.user) {
        // Pode já existir no auth mas sem profile — tentar localizar
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const found = list?.users?.find((u) => (u.email ?? "").toLowerCase() === email);
        if (!found) {
          return new Response(JSON.stringify({ error: createErr?.message ?? "Erro ao criar usuário" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        targetUserId = found.id;
      } else {
        targetUserId = created.user.id;
      }

      // Garantir profile
      await admin.from("profiles").upsert(
        { user_id: targetUserId, email, name: name ?? email },
        { onConflict: "user_id" }
      );
    }

    // Vincular à organização
    const { error: memberErr } = await admin
      .from("organization_members")
      .insert([{
        organization_id: organizationId,
        user_id: targetUserId,
        role,
        status: "active",
        invited_email: email,
      }]);

    if (memberErr) {
      if (memberErr.code === "23505") {
        return new Response(JSON.stringify({ error: "already_member" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: memberErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, user_id: targetUserId }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
