-- ===============================
-- USERS TABLE
-- ===============================
create table if not exists public.users (
  id text primary key,                  -- Telegram user id (string-safe)
  username text,
  coins bigint not null default 100,
  businesses jsonb not null default '{}'::jsonb,
  level integer not null default 1,
  last_mine bigint not null default 0,
  referrals_count integer not null default 0,
  referred_by text null,
  subscribed boolean not null default true,
  created_at timestamptz not null default now()
);

-- ===============================
-- INDEXES
-- ===============================
create index if not exists idx_users_coins on public.users (coins desc);
create index if not exists idx_users_username on public.users (username);
create index if not exists idx_users_referred_by on public.users (referred_by);

-- ===============================
-- SAFETY CONSTRAINTS
-- ===============================
alter table public.users
  add constraint no_self_referral
  check (referred_by is null or referred_by <> id);

-- ===============================
-- MANUAL REFERRAL FUNCTION
-- (If referred user already exists -> returns already_registered and does nothing)
-- ===============================
create or replace function public.manual_refer_by_id(
  referrer_id text,
  referred_id text,
  referred_username text
)
returns json
language plpgsql
security definer
as $$
declare
  referrer_record public.users;
  referred_record public.users;
begin
  -- Prevent self referral
  if referrer_id = referred_id then
    return json_build_object(
      'success', false,
      'error', 'self_referral'
    );
  end if;

  -- Check inviter exists
  select * into referrer_record
  from public.users
  where id = referrer_id;

  if not found then
    return json_build_object(
      'success', false,
      'error', 'inviter_not_found'
    );
  end if;

  -- If the referred user already exists in the users table,
  -- do NOT register them or change their referred_by.
  select * into referred_record
  from public.users
  where id = referred_id;

  if found then
    return json_build_object(
      'success', false,
      'error', 'already_registered'
    );
  end if;

  -- Create the referred user (only if they do NOT already exist)
  insert into public.users (
    id,
    username,
    coins,
    businesses,
    level,
    last_mine,
    referrals_count,
    referred_by,
    subscribed
  )
  values (
    referred_id,
    referred_username,
    100,
    '{}'::jsonb,
    1,
    0,
    0,
    referrer_id,
    true
  );

  -- Reward inviter (ONLY ONCE — because the referred user did not exist before)
  update public.users
  set
    coins = coins + 100,
    referrals_count = referrals_count + 1
  where id = referrer_id;

  return json_build_object(
    'success', true,
    'inviter_id', referrer_record.id,
    'inviter_username', referrer_record.username,
    'awarded', true
  );
end;
$$;

-- ===============================
-- PURCHASE BUSINESS FUNCTION
-- ===============================
create or replace function public.purchase_business(
  p_user_id text,
  p_business text,
  p_qty integer,
  p_unit_cost numeric
)
returns json
language plpgsql
security definer
as $$
declare
  user_record public.users;
  total_cost numeric;
  current_qty integer;
begin
  select * into user_record
  from public.users
  where id = p_user_id;

  if not found then
    return json_build_object(
      'success', false,
      'error', 'user_not_found'
    );
  end if;

  if p_qty <= 0 then
    return json_build_object(
      'success', false,
      'error', 'invalid_quantity'
    );
  end if;

  total_cost := p_qty * p_unit_cost;

  if user_record.coins < total_cost then
    return json_build_object(
      'success', false,
      'error', 'insufficient_funds'
    );
  end if;

  current_qty :=
    coalesce((user_record.businesses ->> p_business)::integer, 0);

  update public.users
  set
    coins = coins - total_cost,
    businesses = jsonb_set(
      businesses,
      array[p_business],
      to_jsonb(current_qty + p_qty),
      true
    )
  where id = p_user_id;

  return json_build_object(
    'success', true,
    'business', p_business,
    'qty', current_qty + p_qty,
    'spent', total_cost
  );
end;
$$;


grant select, insert, update on public.users to anon, authenticated;
grant execute on function public.manual_refer_by_id(text, text, text) to anon, authenticated;
grant execute on function public.purchase_business(text, text, integer, numeric) to anon, authenticated;
