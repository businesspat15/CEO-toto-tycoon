-- ====================================================================
-- FULL SCHEMA & RPCs for CEO TOTO Tycoon (corrected)
-- - Ensures businesses.total_coins_invested increments atomically
-- - Race-safe manual_refer_by_id
-- - purchase_business uses INSERT ... ON CONFLICT DO UPDATE
-- - Helpful FK and indexes (FK creation done conditionally)
-- ====================================================================

-- 1) users table
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text default null,
  subscribed boolean default false,
  created_at timestamptz default now()
);

-- 2) transactions table (audit)
create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

-- 3) businesses table (simple global totals per business)
create table if not exists public.businesses (
  business text primary key,
  total_coins_invested bigint default 0
);

-- 4) Seed common business rows (won't overwrite existing)
insert into public.businesses (business, total_coins_invested) values
('DAPP', 0),
('TOTO_VAULT', 0),
('CIFCI_STABLE', 0),
('TYPOGRAM', 0),
('APPLE', 0),
('BITCOIN', 0)
on conflict (business) do nothing;

-- 5) Indexes (idempotent)
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_users_coins_desc on public.users(coins desc);

-- 6) Create foreign key constraint only if it doesn't exist
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

-- ====================================================================
-- 7) manual_refer_by_id: race-safe, idempotent referral function
-- returns jsonb: { success: bool, error: text?, inviter_id?, inviter_username? }
-- ====================================================================
create or replace function public.manual_refer_by_id(
  referrer_id text,
  referred_id text,
  referred_username text
) returns jsonb
language plpgsql
security definer
as $$
declare
  ref_row record;
  self_row record;
begin
  -- find inviter by id
  select id, username into ref_row from public.users where id = referrer_id limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  -- prevent self-referral
  if ref_row.id = referred_id then
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  -- Try to create the referred user if missing, but avoid raising on concurrent inserts
  begin
    insert into public.users (
      id, username, coins, businesses, level, last_mine, referrals_count, referred_by, subscribed, created_at
    ) values (
      referred_id, referred_username, 100, '{}'::jsonb, 1, 0, 0, null, false, now()
    )
    on conflict (id) do nothing;
  exception when others then
    -- continue: we'll re-select the row below
    raise notice 'manual_refer_by_id: insert attempt failed: %', sqlerrm;
  end;

  -- Select the referred user's row FOR UPDATE to serialize checks/updates
  select id, referred_by into self_row from public.users where id = referred_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'user_create_failed');
  end if;

  -- If referred_by already set, do not reward again
  if self_row.referred_by is not null then
    return jsonb_build_object('success', false, 'error', 'already_referred');
  end if;

  -- Set referred_by
  update public.users set referred_by = ref_row.id where id = referred_id;

  -- Reward inviter
  update public.users
    set coins = coalesce(coins,0) + 100,
        referrals_count = coalesce(referrals_count,0) + 1
    where id = ref_row.id;

  insert into public.transactions (user_id, amount, type, note)
    values (ref_row.id, 100, 'refer', 'Referral bonus from ' || referred_id);

  return jsonb_build_object('success', true, 'inviter_id', ref_row.id, 'inviter_username', ref_row.username);
end;
$$;

-- ====================================================================
-- 8) purchase_business: atomic, race-safe increment of business totals
-- CALL example:
-- select public.purchase_business('DAPP', '12345', 2, 1000);
-- Returns jsonb: { success: true/false, coins: <new>, user_businesses: <json>, total_invested: <bigint> }
-- ====================================================================
create or replace function public.purchase_business(
  p_business text,
  p_user_id text,
  p_qty int,
  p_unit_cost bigint
) returns jsonb
language plpgsql
security definer
as $$
declare
  usr record;
  cur_qty int := 0;
  total_cost bigint;
  new_coins bigint;
  new_businesses jsonb;
  biz record;
  p_business_norm text;
begin
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_qty');
  end if;

  if p_unit_cost is null or p_unit_cost < 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_price');
  end if;

  -- normalize business name (trim + upper) so the businesses table keys are consistent
  p_business_norm := upper(trim(coalesce(p_business, '')));

  total_cost := p_unit_cost * p_qty;

  -- lock user's row
  select * into usr from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'user_not_found');
  end if;

  if coalesce(usr.coins,0) < total_cost then
    return jsonb_build_object('success', false, 'error', 'insufficient_funds', 'needed', total_cost, 'have', coalesce(usr.coins,0));
  end if;

  -- compute current qty from JSON (safe)
  if usr.businesses is not null then
    begin
      cur_qty := (usr.businesses ->> p_business_norm)::int;
    exception when others then
      cur_qty := 0;
    end;
    if cur_qty is null then cur_qty := 0; end if;
  else
    cur_qty := 0;
  end if;

  -- update user's businesses JSON: set new qty = cur_qty + p_qty
  new_businesses := jsonb_set(coalesce(usr.businesses, '{}'::jsonb), array[p_business_norm], to_jsonb(cur_qty + p_qty), true);

  new_coins := coalesce(usr.coins,0) - total_cost;

  -- update users row with new coins and businesses
  update public.users
    set coins = new_coins,
        businesses = new_businesses
  where id = p_user_id;

  -- atomically increment/insert total_coins_invested for the normalized business
  insert into public.businesses (business, total_coins_invested)
    values (p_business_norm, total_cost)
    on conflict (business) do update
      set total_coins_invested = public.businesses.total_coins_invested + EXCLUDED.total_coins_invested;

  -- insert transaction record
  insert into public.transactions (user_id, amount, type, note)
    values (p_user_id, total_cost, 'purchase', 'Bought ' || p_qty || ' x ' || p_business_norm || ' @' || p_unit_cost);

  -- return useful info (fresh values)
  select total_coins_invested into biz from public.businesses where business = p_business_norm;

  return jsonb_build_object(
    'success', true,
    'coins', new_coins,
    'user_businesses', (select businesses from public.users where id = p_user_id),
    'total_invested', coalesce(biz.total_coins_invested,0)
  );
exception
  when others then
    -- bubble up error message for debugging (can be restricted in production)
    return jsonb_build_object('success', false, 'error', 'internal_error', 'message', sqlerrm);
end;
$$;

-- ====================================================================
-- 9) Optional repair: Recompute businesses.total_coins_invested from transactions
-- This will replace totals with sums computed from transaction.amount for purchase rows.
-- NOTE: This depends on the 'note' format used in the purchase function:
-- note = 'Bought <qty> x <BUSINESS> @<unit_cost>'
-- If your historical transactions follow that format, this will work.
-- Run only if you want to repair existing totals.
-- ====================================================================
with purchases as (
  select
    (regexp_matches(note, 'Bought\\s+\\d+\\s+x\\s+([A-Z0-9_]+)\\s+@'))[1] as business,
    amount
  from public.transactions
  where type = 'purchase' and note ~ 'Bought\\s+\\d+\\s+x\\s+[A-Z0-9_]+\\s+@'
)
insert into public.businesses (business, total_coins_invested)
select business, sum(amount)::bigint
from purchases
group by business
on conflict (business) do update
  set total_coins_invested = excluded.total_coins_invested;

-- ====================================================================
-- Done
-- ====================================================================
