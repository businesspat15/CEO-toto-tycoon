-- ===============================
-- USERS TABLE
-- ===============================
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text null,
  subscribed boolean default true,
  created_at timestamptz default now()
);

-- Prevent self-referral
alter table public.users
  drop constraint if exists no_self_referral;

alter table public.users
  add constraint no_self_referral
  check (referred_by is null or referred_by <> id);

-- ===============================
-- BUSINESSES MASTER
-- ===============================
create table if not exists public.businesses (
  name text primary key,
  cost bigint not null default 1000
);

insert into public.businesses (name, cost)
values
  ('DAPP', 1000),
  ('TOTO_VAULT', 1000),
  ('CIFCI_STABLE', 1000),
  ('TYPOGRAM', 1000),
  ('APPLE', 1000),
  ('BITCOIN', 1000)
on conflict do nothing;

-- ===============================
-- BUSINESS TOTALS (REAL TABLE)
-- ===============================
create table if not exists public.business_totals (
  name text primary key,
  total_qty bigint not null default 0,
  total_invested bigint not null default 0,
  updated_at timestamptz default now()
);

-- Seed totals table
insert into public.business_totals (name)
select name from public.businesses
on conflict do nothing;

-- ===============================
-- SAFE UPDATE FUNCTION (ROW-LEVEL)
-- ===============================
create or replace function public.update_business_totals_row()
returns trigger
language plpgsql
as $$
declare
  k text;
  v bigint;
begin
  -- Only process if businesses exists
  if new.businesses is null then
    return new;
  end if;

  -- Loop over user's businesses JSON
  for k, v in
    select key, value::bigint
    from jsonb_each_text(new.businesses)
  loop
    insert into public.business_totals (name, total_qty, total_invested)
    values (k, v, v * 1000)
    on conflict (name) do update
      set total_qty = (
            select coalesce(sum((u.businesses ->> k)::bigint), 0)
            from public.users u
            where u.businesses ? k
          ),
          total_invested = (
            select coalesce(sum((u.businesses ->> k)::bigint), 0) * 1000
            from public.users u
            where u.businesses ? k
          ),
          updated_at = now();
  end loop;

  return new;
end;
$$;

-- ===============================
-- TRIGGER (ROW LEVEL, SAFE)
-- ===============================
drop trigger if exists trg_update_business_totals on public.users;

create trigger trg_update_business_totals
after insert or update of businesses
on public.users
for each row
execute function public.update_business_totals_row();

-- ===============================
-- REFERRAL FUNCTION (SAFE INSERT)
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
begin
  -- Already exists → cannot be referred again
  if exists (select 1 from public.users where id = referred_id) then
    return json_build_object('success', false, 'error', 'already_user');
  end if;

  -- Create referred user
  insert into public.users (
    id, username, coins, businesses,
    level, last_mine, referrals_count,
    referred_by, subscribed
  ) values (
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

  -- Reward referrer
  update public.users
  set coins = coins + 100,
      referrals_count = referrals_count + 1
  where id = referrer_id;

  return json_build_object('success', true);
end;
$$;

-- ===============================
-- PURCHASE FUNCTION
-- ===============================
create or replace function public.purchase_business(
  p_user_id text,
  p_business text,
  p_qty int
)
returns json
language plpgsql
security definer
as $$
declare
  cur_qty bigint;
  cost bigint := p_qty * 1000;
begin
  if p_qty <= 0 then
    return json_build_object('success', false, 'error', 'invalid_qty');
  end if;

  select coalesce((businesses ->> p_business)::bigint, 0)
  into cur_qty
  from public.users
  where id = p_user_id
  for update;

  update public.users
  set coins = coins - cost,
      businesses = jsonb_set(
        businesses,
        array[p_business],
        to_jsonb(cur_qty + p_qty),
        true
      )
  where id = p_user_id
    and coins >= cost;

  if not found then
    return json_build_object('success', false, 'error', 'insufficient_funds');
  end if;

  return json_build_object(
    'success', true,
    'business', p_business,
    'owned', cur_qty + p_qty
  );
end;
$$;
-- ===============================
-- USERS TABLE
-- ===============================
create table if not exists public.users (
  id text primary key,
  username text,
  coins bigint default 0,
  businesses jsonb default '{}'::jsonb,
  level int default 1,
  last_mine bigint default 0,
  referrals_count int default 0,
  referred_by text null,
  subscribed boolean default true,
  created_at timestamptz default now()
);

-- Prevent self-referral
alter table public.users
  drop constraint if exists no_self_referral;

alter table public.users
  add constraint no_self_referral
  check (referred_by is null or referred_by <> id);

-- ===============================
-- BUSINESSES MASTER
-- ===============================
create table if not exists public.businesses (
  name text primary key,
  cost bigint not null default 1000
);

insert into public.businesses (name, cost)
values
  ('DAPP', 1000),
  ('TOTO_VAULT', 1000),
  ('CIFCI_STABLE', 1000),
  ('TYPOGRAM', 1000),
  ('APPLE', 1000),
  ('BITCOIN', 1000)
on conflict do nothing;

-- ===============================
-- BUSINESS TOTALS (REAL TABLE)
-- ===============================
create table if not exists public.business_totals (
  name text primary key,
  total_qty bigint not null default 0,
  total_invested bigint not null default 0,
  updated_at timestamptz default now()
);

-- Seed totals table
insert into public.business_totals (name)
select name from public.businesses
on conflict do nothing;

-- ===============================
-- SAFE UPDATE FUNCTION (ROW-LEVEL)
-- ===============================
create or replace function public.update_business_totals_row()
returns trigger
language plpgsql
as $$
declare
  k text;
  v bigint;
begin
  -- Only process if businesses exists
  if new.businesses is null then
    return new;
  end if;

  -- Loop over user's businesses JSON
  for k, v in
    select key, value::bigint
    from jsonb_each_text(new.businesses)
  loop
    insert into public.business_totals (name, total_qty, total_invested)
    values (k, v, v * 1000)
    on conflict (name) do update
      set total_qty = (
            select coalesce(sum((u.businesses ->> k)::bigint), 0)
            from public.users u
            where u.businesses ? k
          ),
          total_invested = (
            select coalesce(sum((u.businesses ->> k)::bigint), 0) * 1000
            from public.users u
            where u.businesses ? k
          ),
          updated_at = now();
  end loop;

  return new;
end;
$$;

-- ===============================
-- TRIGGER (ROW LEVEL, SAFE)
-- ===============================
drop trigger if exists trg_update_business_totals on public.users;

create trigger trg_update_business_totals
after insert or update of businesses
on public.users
for each row
execute function public.update_business_totals_row();

-- ===============================
-- REFERRAL FUNCTION (SAFE INSERT)
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
begin
  -- Already exists → cannot be referred again
  if exists (select 1 from public.users where id = referred_id) then
    return json_build_object('success', false, 'error', 'already_user');
  end if;

  -- Create referred user
  insert into public.users (
    id, username, coins, businesses,
    level, last_mine, referrals_count,
    referred_by, subscribed
  ) values (
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

  -- Reward referrer
  update public.users
  set coins = coins + 100,
      referrals_count = referrals_count + 1
  where id = referrer_id;

  return json_build_object('success', true);
end;
$$;

-- ===============================
-- PURCHASE FUNCTION
-- ===============================
create or replace function public.purchase_business(
  p_user_id text,
  p_business text,
  p_qty int
)
returns json
language plpgsql
security definer
as $$
declare
  cur_qty bigint;
  cost bigint := p_qty * 1000;
begin
  if p_qty <= 0 then
    return json_build_object('success', false, 'error', 'invalid_qty');
  end if;

  select coalesce((businesses ->> p_business)::bigint, 0)
  into cur_qty
  from public.users
  where id = p_user_id
  for update;

  update public.users
  set coins = coins - cost,
      businesses = jsonb_set(
        businesses,
        array[p_business],
        to_jsonb(cur_qty + p_qty),
        true
      )
  where id = p_user_id
    and coins >= cost;

  if not found then
    return json_build_object('success', false, 'error', 'insufficient_funds');
  end if;

  return json_build_object(
    'success', true,
    'business', p_business,
    'owned', cur_qty + p_qty
  );
end;
$$;
