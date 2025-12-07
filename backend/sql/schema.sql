-- 1) ensure users table exists (skip if already created)
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

-- 2) referral_rewards table to track which (referrer, referred) pairs have been rewarded
create table if not exists public.referral_rewards (
  referrer_id text not null references public.users(id) on delete cascade,
  referred_user_id text not null references public.users(id) on delete cascade,
  rewarded_at timestamptz default now(),
  primary key (referrer_id, referred_user_id)
);

-- 3) atomic, idempotent function to reward a referrer for a specific referred user
create or replace function public.reward_referrer(
  p_referrer_id text,
  p_referred_user_id text,
  p_coin_bonus bigint default 100
)
returns table(referrer_id text, referrals_count int, coins bigint, rewarded boolean)
language plpgsql
as $$
declare
  v_inserted boolean := false;
begin
  -- Try to record the reward; if it already exists, unique_violation will fire
  begin
    insert into public.referral_rewards(referrer_id, referred_user_id)
    values (p_referrer_id, p_referred_user_id);
    v_inserted := true;
  exception when unique_violation then
    v_inserted := false;
  end;

  if v_inserted then
    -- Atomically update user counters and return the new state + rewarded = true
    update public.users
    set
      referrals_count = coalesce(referrals_count, 0) + 1,
      coins = coalesce(coins, 0) + p_coin_bonus
    where id = p_referrer_id
    returning id, referrals_count, coins into referrer_id, referrals_count, coins;

    if referrer_id is null then
      -- referrer missing: undo reward record and return rewarded = false
      delete from public.referral_rewards
      where referrer_id = p_referrer_id and referred_user_id = p_referred_user_id;
      rewarded := false;
      return next;
    end if;

    rewarded := true;
    return next;
  else
    -- Already rewarded previously — return current state + rewarded = false
    return query
      select id, coalesce(referrals_count,0), coalesce(coins,0), false
      from public.users
      where id = p_referrer_id;
  end if;
end;
$$;
