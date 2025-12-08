-- schema.sql
-- Run in Supabase > SQL editor

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

-- Safer RPC: increment referrals_count and coins, and return the updated values.
-- This helps the server confirm the update when calling rpc().
create or replace function public.increment_referral_bonus(ref_id text)
returns table(referrals_count int, coins bigint)
language plpgsql as $$
begin
  update public.users
  set referrals_count = coalesce(referrals_count,0) + 1,
      coins = coalesce(coins,0) + 100
  where id = ref_id
  returning referrals_count, coins
  into referrals_count, coins;

  if NOT FOUND then
    -- No matching referrer row; return nothing (caller sees empty result)
    return;
  end if;

  return next;
end;
$$;
