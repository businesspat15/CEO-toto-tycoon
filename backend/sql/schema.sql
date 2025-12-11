-- ============================================================================
-- FULL SQL: derive businesses.total_coins_invested from users.businesses JSON
-- - Adds businesses.unit_price (if missing)
-- - Adds refresh_business_totals_from_users() which recomputes totals
-- - Adds optional refresh_business_totals_from_transactions()
-- - Idempotent / safe to run multiple times
-- ============================================================================
BEGIN;

-- Ensure base tables exist (keeps existing definitions if already present)
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text default null,
  subscribed boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

create table if not exists public.businesses (
  business text primary key,
  total_coins_invested bigint default 0,
  unit_price bigint default 1000
);

-- Seed common businesses (won't overwrite existing unit_price or totals)
insert into public.businesses (business, total_coins_invested, unit_price) values
('DAPP', 0, 1000),
('TOTO_VAULT', 0, 1000),
('CIFCI_STABLE', 0, 1000),
('TYPOGRAM', 0, 1000),
('APPLE', 0, 1000),
('BITCOIN', 0, 1000)
on conflict (business) do nothing;

-- Ensure indexes exist
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_users_coins_desc on public.users(coins desc);

-- Conditionally add foreign key constraint for transactions.user_id -> users.id
do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'fk_transactions_user'
      and table_schema = 'public'
      and table_name = 'transactions'
  ) then
    alter table public.transactions
      add constraint fk_transactions_user
        foreign key (user_id) references public.users(id)
        on delete no action
        on update cascade;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Add unit_price column if missing (idempotent)
-- Note: PostgreSQL supports ADD COLUMN IF NOT EXISTS
-- ---------------------------------------------------------------------------
alter table public.businesses add column if not exists unit_price bigint default 1000;

-- ---------------------------------------------------------------------------
-- Helper: set default unit prices for known businesses (call manually if needed)
-- ---------------------------------------------------------------------------
create or replace function public.set_default_unit_prices() returns void language sql as $$
  update public.businesses set unit_price = 1000 where business in ('DAPP','TOTO_VAULT','CIFCI_STABLE','TYPOGRAM','APPLE','BITCOIN') and (unit_price is null or unit_price = 0);
$$;

-- ---------------------------------------------------------------------------
-- Function: refresh_business_totals_from_users()
-- Recomputes total_coins_invested for each business by summing across all users:
-- SUM( (users.businesses ->> business)::bigint * businesses.unit_price )
-- If businesses.unit_price is missing, defaults to 1000.
-- Returns jsonb: { success: true, updated_count: n }.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_business_totals_from_users()
returns jsonb
language plpgsql
security definer
as $$
declare
  rec record;
  updated int := 0;
begin
  /*
    Strategy:
    - Extract distinct business keys used in users.businesses
    - For each key, aggregate the quantity across users (cast safely)
    - Multiply by unit_price from public.businesses (or 1000 default)
    - Upsert into public.businesses (set total_coins_invested = computed sum)
  */

  with keys as (
    select distinct jsonb_object_keys(u.businesses) as business
    from public.users u
    where u.businesses is not null and u.businesses <> '{}'::jsonb
  ),
  agg as (
    select
      k.business,
      sum( (coalesce(nullif(u.businesses ->> k.business, ''), '0'))::bigint * coalesce(b.unit_price, 1000) ) as total
    from keys k
    join public.users u on (u.businesses ->> k.business) is not null
    left join public.businesses b on b.business = k.business
    group by k.business
  )
  -- upsert aggregated totals into businesses table
  insert into public.businesses (business, total_coins_invested, unit_price)
  select a.business, coalesce(a.total,0)::bigint, coalesce(b.unit_price, 1000)
  from agg a
  left join public.businesses b on b.business = a.business
  on conflict (business) do update
    set total_coins_invested = excluded.total_coins_invested,
        unit_price = coalesce(public.businesses.unit_price, excluded.unit_price);

  GET DIAGNOSTICS updated = ROW_COUNT;

  -- Optionally set total_coins_invested = 0 for businesses that no longer exist in users list:
  -- (if desired) -- uncomment to zero out business rows not present in any user
  -- update public.businesses set total_coins_invested = 0
  -- where business not in (select business from agg);

  return jsonb_build_object('success', true, 'updated_count', updated);
end;
$$;

-- ---------------------------------------------------------------------------
-- Optional: refresh from transactions (historical audit)
-- If you prefer computing totals from transactions.amount (purchase records),
-- use this function. It aggregates purchase transactions and writes totals.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_business_totals_from_transactions()
returns jsonb
language plpgsql
security definer
as $$
declare
  updated int := 0;
begin
  with purchases as (
    select
      (regexp_matches(note, 'Bought\\s+\\d+\\s+x\\s+([A-Z0-9_]+)\\s+@'))[1] as business,
      sum(amount)::bigint as total_amount
    from public.transactions
    where type = 'purchase' and note ~ 'Bought\\s+\\d+\\s+x\\s+[A-Z0-9_]+\\s+@'
    group by 1
  )
  insert into public.businesses (business, total_coins_invested, unit_price)
  select p.business, p.total_amount, coalesce(b.unit_price, 1000)
  from purchases p
  left join public.businesses b on b.business = p.business
  on conflict (business) do update
    set total_coins_invested = excluded.total_coins_invested,
        unit_price = coalesce(public.businesses.unit_price, excluded.unit_price);

  GET DIAGNOSTICS updated = ROW_COUNT;
  return jsonb_build_object('success', true, 'updated_count', updated);
end;
$$;

-- ---------------------------------------------------------------------------
-- Optional: convenience view to see computed totals from users (no writes)
-- ---------------------------------------------------------------------------
create or replace view public.business_totals_from_users as
with keys as (
  select distinct jsonb_object_keys(u.businesses) as business
  from public.users u
  where u.businesses is not null and u.businesses <> '{}'::jsonb
)
select
  k.business,
  sum( (coalesce(nullif(u.businesses ->> k.business, ''), '0'))::bigint ) as total_qty,
  coalesce(b.unit_price,1000) as unit_price,
  sum( (coalesce(nullif(u.businesses ->> k.business, ''), '0'))::bigint ) * coalesce(b.unit_price,1000) as computed_total_invested
from keys k
join public.users u on (u.businesses ->> k.business) is not null
left join public.businesses b on b.business = k.business
group by k.business, b.unit_price
order by computed_total_invested desc;

COMMIT;

-- ============================================================================
-- Quick usage:
-- 1) Ensure unit prices are set as desired:
--    select public.set_default_unit_prices();
--    -- or update unit_price manually:
--    update public.businesses set unit_price = 1200 where business = 'APPLE';
--
-- 2) Recompute totals from users' JSON:
--    select public.refresh_business_totals_from_users();
--
-- 3) (Optional) Recompute totals from transactions:
--    select public.refresh_business_totals_from_transactions();
--
-- 4) Inspect computed view (no writes):
--    select * from public.business_totals_from_users;
-- ============================================================================
