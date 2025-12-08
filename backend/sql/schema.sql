-- ============================================================
-- STEP 1 — USERS TABLE  (Run only if not already created)
-- ============================================================
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

-- ============================================================
-- STEP 2 — FIXED REFERRAL FUNCTION (RPC)
-- RETURNS new referral count
-- Also adds +100 coins to referrer (remove if you don’t want)
-- ============================================================
create or replace function public.increment_referral_bonus(ref_id text)
returns table(new_count int)
language plpgsql
security definer
as $$
begin
  update public.users
  set referrals_count = coalesce(referrals_count, 0) + 1,
      coins = coalesce(coins, 0) + 100  -- delete this line if NO reward
  where id = ref_id
  returning referrals_count into new_count;

  -- if no matching id found
  if not found then
    new_count := 0;
  end if;

  return;
end;
$$;
