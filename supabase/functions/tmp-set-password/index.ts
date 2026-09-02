import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

Deno.serve(async (req) => {
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { email, password } = await req.json();
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw listErr;
    const user = list.users.find((u) => (u.email ?? "").toLowerCase() === String(email).toLowerCase());
    if (!user) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const { error } = await admin.auth.admin.updateUserById(user.id, { password });
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true, user_id: user.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
