create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'google_play',
  product_id text not null,
  purchase_token text not null,
  order_id text,
  status text not null default 'inactive',
  expires_at timestamptz,
  auto_renewing boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_subscriptions_purchase_token_key unique (purchase_token)
);

create index if not exists user_subscriptions_user_updated_idx
  on public.user_subscriptions (user_id, updated_at desc);

create index if not exists user_subscriptions_purchase_token_idx
  on public.user_subscriptions (purchase_token);

create or replace function public.set_user_subscriptions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_subscriptions_updated_at
  on public.user_subscriptions;

create trigger set_user_subscriptions_updated_at
before update on public.user_subscriptions
for each row
execute function public.set_user_subscriptions_updated_at();

alter table public.user_subscriptions enable row level security;

drop policy if exists "Users can read their own subscriptions"
  on public.user_subscriptions;

create policy "Users can read their own subscriptions"
on public.user_subscriptions
for select
to authenticated
using (auth.uid() = user_id);
