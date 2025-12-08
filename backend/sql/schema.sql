-- === CEO TOTO Tycoon DB setup (run in Supabase SQL editor) ===

-- 1) users table (minimal schema you requested)
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

-- 2) referrals table (idempotency: primary key prevents duplicate crediting)
create table if not exists public.referrals (
  referrer_id text not null,
  referred_id text not null,
  created_at timestamptz default now(),
  primary key (referrer_id, referred_id)
);

-- 3) Optional: make sure there's an index on referrals.referred_id (useful for lookups)
create index if not exists idx_referrals_referred_id on public.referrals(referred_id);

-- 4) RPC: increment_referral_bonus(ref_id)
--    This function increments referrals_count and adds coins atomically.
create or replace function public.increment_referral_bonus(ref_id text)
returns void language plpgsql as $$
begin
  update public.users
  set referrals_count = coalesce(referrals_count, 0) + 1,
      coins = coalesce(coins, 0) + 100
  where id = ref_id;
end;
$$;

-- 5) (Optional) Grant execute on function to public (if you want non-super roles to call it)
--    Note: if your backend uses the service_role key this is not necessary, but it's safe.
grant execute on function public.increment_referral_bonus(text) to public;

-- === Quick verification queries (run manually to inspect results) ===
-- Insert test rows (only if you want to test; comment out in production)
-- insert into public.users (id, username, coins) values ('ref123','bob', 100) on conflict (id) do nothing;
-- insert into public.users (id, username, coins) values ('newUser','charlie', 100) on conflict (id) do nothing;

-- Test RPC (run only if referrer exists)
-- select public.increment_referral_bonus('ref123');
-- select id, coins, referrals_count from public.users where id = 'ref123';

-- Test idempotency (insert into referrals table)
-- insert into public.referrals (referrer_id, referred_id) values ('ref123','newUser'); -- first time -> succeeds
-- insert into public.referrals (referrer_id, referred_id) values ('ref123','newUser'); -- second time -> fails with duplicate key

-- End of script
