-- ============================================================================
-- FULL SCHEMA & RPCs for CEO TOTO Tycoon
-- Includes: users, transactions, businesses, manual_refer_by_id, purchase_business
-- ============================================================================

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

-- 2) transactions table
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

-- Optional: seed some common business rows (won't overwrite existing)
insert into public.businesses (business, total_coins_invested) values
('DAPP', 0),
('TOTO_VAULT', 0),
('CIFCI_STABLE', 0),
('TYPOGRAM', 0),
('APPLE', 0),
('BITCOIN', 0)
on conflict (business) do nothing;

-- 4) Atomic referral function for "ref_<INVITER_ID>" deep links.
-- CALL example:
-- select public.manual_refer_by_id('12345', '67890', 'tg_username');
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
  updated boolean := false;
begin
  -- find inviter by id
  select * into ref_row from public.users where id = referrer_id limit 1;
  if not found then
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  -- prevent self-referral
  if ref_row.id = referred_id then
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  -- lock referred user's row (if exists)
  select id, referred_by into self_row from public.users where id = referred_id for update;

  if not found then
    -- create referred user and attach referred_by
    insert into public.users
      (id, username, coins, businesses, level, last_mine, referrals_count, referred_by, subscribed, created_at)
    values
      (referred_id, referred_username, 100, '{}'::jsonb, 1, 0, 0, ref_row.id, false, now());
    updated := true;
  else
    -- if user exists and hasn't been referred (or already referred to same referrer), set referred_by
    if self_row.referred_by is null or self_row.referred_by = ref_row.id then
      update public.users set referred_by = ref_row.id where id = referred_id;
      updated := true;
    else
      return jsonb_build_object('success', false, 'error', 'already_referred');
    end if;
  end if;

  if updated then
    -- reward inviter
    update public.users
      set coins = coins + 100,
          referrals_count = coalesce(referrals_count,0) + 1
      where id = ref_row.id;

    insert into public.transactions (user_id, amount, type, note)
      values (ref_row.id, 100, 'refer', 'Referral bonus from ' || referred_id);

    return jsonb_build_object('success', true, 'inviter_id', ref_row.id, 'inviter_username', ref_row.username);
  end if;

  return jsonb_build_object('success', false, 'error', 'unknown');
end;
$$;

-- 5) Atomic purchase function
-- CALL example:
-- select public.purchase_business('DAPP', '12345', 2, 1000);
-- Returns jsonb containing success, coins (new), user_businesses JSON, total_invested
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
begin
  if p_qty is null or p_qty <= 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_qty');
  end if;

  if p_unit_cost is null or p_unit_cost < 0 then
    return jsonb_build_object('success', false, 'error', 'invalid_price');
  end if;

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
      cur_qty := (usr.businesses ->> p_business)::int;
    exception when others then
      cur_qty := 0;
    end;
    if cur_qty is null then cur_qty := 0; end if;
  else
    cur_qty := 0;
  end if;

  -- update user's businesses JSON: set new qty = cur_qty + p_qty
  new_businesses := jsonb_set(coalesce(usr.businesses, '{}'::jsonb), array[p_business], to_jsonb(cur_qty + p_qty), true);

  new_coins := coalesce(usr.coins,0) - total_cost;

  -- update users row
  update public.users
    set coins = new_coins,
        businesses = new_businesses
  where id = p_user_id;

  -- ensure a businesses row exists for p_business
  insert into public.businesses (business, total_coins_invested)
  values (p_business, 0)
  on conflict (business) do nothing;

  -- atomically increment total_coins_invested
  update public.businesses
    set total_coins_invested = coalesce(total_coins_invested,0) + total_cost
  where business = p_business;

  -- insert transaction record
  insert into public.transactions (user_id, amount, type, note)
    values (p_user_id, total_cost, 'purchase', 'Bought ' || p_qty || ' x ' || p_business || ' @' || p_unit_cost);

  -- return useful info
  select total_coins_invested into biz from public.businesses where business = p_business;

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

-- 6) Helpful index for leaderboard sorting
create index if not exists idx_users_coins_desc on public.users(coins desc);

-- Done
