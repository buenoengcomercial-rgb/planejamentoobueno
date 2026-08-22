-- Pacotes de mão de obra terceirizada. Os itens e pagamentos ficam no JSON
-- para preservar o rateio congelado de cada contratação em uma única revisão.
create table if not exists public.subcontracts (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text,
  contractor_name text,
  status text not null default 'draft' check (status in ('draft', 'contracted', 'cancelled')),
  contract_date date,
  contracted_value numeric(14,2),
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subcontracts_project_status_idx on public.subcontracts(project_id, status);
alter table public.subcontracts enable row level security;

create policy "subcontracts_select_org_members" on public.subcontracts for select using (
  exists (select 1 from public.projects p where p.id = subcontracts.project_id
    and public.has_org_role(auth.uid(), p.organization_id, array['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[]))
);
create policy "subcontracts_insert_owner_admin" on public.subcontracts for insert with check (
  exists (select 1 from public.projects p where p.id = subcontracts.project_id
    and public.has_org_role(auth.uid(), p.organization_id, array['owner','admin']::public.org_role[]))
);
create policy "subcontracts_update_owner_admin" on public.subcontracts for update using (
  exists (select 1 from public.projects p where p.id = subcontracts.project_id
    and public.has_org_role(auth.uid(), p.organization_id, array['owner','admin']::public.org_role[]))
) with check (
  exists (select 1 from public.projects p where p.id = subcontracts.project_id
    and public.has_org_role(auth.uid(), p.organization_id, array['owner','admin']::public.org_role[]))
);
