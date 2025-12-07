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

-- optional helper function to reward referrer (increment count and add coins)
create or replace function public.increment_referral_bonus(ref_id text)
returns void language plpgsql as $$
begin
  update public.users set referrals_count = coalesce(referrals_count,0) + 1,
                         coins = coalesce(coins,0) + 100
  where id = ref_id;
end;
$$;
