-- AGENDA NATALINA — MARLUCE SOUZA FOTOGRAFIA
-- 1. No Supabase, Authentication > Users > Add user.
-- 2. Crie um usuário com e-mail e senha forte (e-mail confirmado).
-- 3. Copie o UUID (User UID) e substitua TODAS as ocorrências de
--    00000000-0000-0000-0000-000000000000 abaixo pelo UUID real.
-- 4. Execute no SQL Editor. NÃO execute com o UUID de exemplo.
-- 5. Em Authentication > Providers > Email, DESATIVE Allow new users to sign up.

create extension if not exists pgcrypto;
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  owner_uid uuid not null default auth.uid(),
  client_name text not null check (length(trim(client_name)) between 1 and 120),
  phone text not null check (phone ~ '^[0-9]{10,11}$'),
  subject_name text not null default '',
  session_date date not null check (session_date between date '2026-12-02' and date '2027-01-18'),
  start_time time without time zone not null check (extract(hour from start_time) between 10 and 16 and extract(minute from start_time) = 0),
  session_type text not null default 'Natalino',
  clothing_size text not null default '',
  status text not null default 'pendente' check (status in ('pendente','confirmado','concluido','cancelado')),
  total_amount numeric(10,2) not null default 200 check (total_amount >= 0),
  paid_amount numeric(10,2) not null default 0 check (paid_amount >= 0 and paid_amount <= total_amount),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- O banco impede reserva simultânea (PC/celular), mesmo se ambas forem salvas no mesmo instante.
create unique index if not exists appointments_one_active_per_slot
on public.appointments(session_date,start_time) where (status <> 'cancelado');

create or replace function public.agenda_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_agenda_updated on public.appointments;
create trigger trg_agenda_updated before update on public.appointments
for each row execute function public.agenda_touch_updated_at();

alter table public.appointments enable row level security;
revoke all on public.appointments from anon;
grant select,insert,update,delete on public.appointments to authenticated;

drop policy if exists "agenda_somente_usuario_autorizado" on public.appointments;
create policy "agenda_somente_usuario_autorizado" on public.appointments
for all to authenticated
using (owner_uid = (select auth.uid()) and (select auth.uid()) = '0eb12544-cb5f-4774-b27f-01aa5455822e'::uuid)
with check (owner_uid = (select auth.uid()) and (select auth.uid()) = '0eb12544-cb5f-4774-b27f-01aa5455822e'::uuid);

-- Opcional: realtime. A atualização automática já funciona a cada 30 segundos
-- e ao retornar para a aba, mesmo sem configurar realtime.
-- alter publication supabase_realtime add table public.appointments;
