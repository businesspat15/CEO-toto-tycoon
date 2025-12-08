-- schema.sql
-- Run this in Supabase SQL editor (Project -> SQL Editor -> New Query)

-- 1) users table (id primary key)
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

-- Replace existing function with one that returns the new referrals_count (int)
create or replace function public.increment_referral_bonus(ref_id text)
returns int language plpgsql as $$
declare
  new_cnt int := 0;
begin
  update public.users
    set referrals_count = coalesce(referrals_count,0) + 1,
        coins = coalesce(coins,0) + 100
  where id = ref_id;

  select referrals_count into new_cnt from public.users where id = ref_id;

  -- If user not found, return -1 so caller can tell
  if new_cnt is null then
    return -1;
  end if;

  return new_cnt;
end;
$$;
