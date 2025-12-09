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

create table if not exists public.transactions (
  id bigserial primary key,
  user_id text not null,
  amount bigint not null,
  type text,
  note text,
  created_at timestamptz default now()
);

create or replace function public.manual_refer(
  referrer_username text,
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
  -- Find inviter by username (case-insensitive)
  select * into ref_row 
  from public.users 
  where lower(username) = lower(referrer_username)
  limit 1;

  if not found then
    return jsonb_build_object('success', false, 'error', 'inviter_not_found');
  end if;

  -- Self referral check
  if ref_row.id = referred_id then
    return jsonb_build_object('success', false, 'error', 'self_referral');
  end if;

  -- Lock referred user row if exists
  select id, referred_by into self_row
  from public.users
  where id = referred_id
  for update;

  -- If referred user does not exist → create & attach referral
  if not found then
    insert into public.users
      (id, username, coins, businesses_json, level, experience, referred_by, referrals_count, last_mine, subscribed, created_at)
    values
      (referred_id, referred_username, 100, '{}'::jsonb, 1, 0, ref_row.id, 0, null, false, now());

    updated := true;

  else
    -- User exists → update referral only if empty or same inviter
    if self_row.referred_by is null or self_row.referred_by = ref_row.id then
      update public.users 
      set referred_by = ref_row.id 
      where id = referred_id;

      updated := true;
    else
      return jsonb_build_object('success', false, 'error', 'already_referred');
    end if;
  end if;

  -- If referral registered, reward inviter
  if updated then
    update public.users
    set coins = coins + 100,
        referrals_count = coalesce(referrals_count,0) + 1
    where id = ref_row.id;

    insert into public.transactions (user_id, amount, type, note)
    values (ref_row.id, 100, 'refer', 'Referral bonus from ' || referred_id);

    return jsonb_build_object(
      'success', true,
      'inviter_id', ref_row.id,
      'inviter_username', ref_row.username
    );
  end if;

  return jsonb_build_object('success', false, 'error', 'unknown');
end;
$$;
