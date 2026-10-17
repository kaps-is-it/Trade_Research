-- Backend-only persistence. No browser role can read or change these tables.
create table public.trading_worker (
  singleton boolean primary key default true check (singleton),
  holder uuid,
  expires_at timestamptz not null default '-infinity'
);
insert into public.trading_worker(singleton) values (true);

create table public.trading_accounts (
  id uuid primary key,
  state jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.trading_orders (
  id uuid primary key,
  account_id uuid not null references public.trading_accounts(id),
  state jsonb not null
);
create table public.trading_fills (
  id uuid primary key,
  account_id uuid not null references public.trading_accounts(id),
  state jsonb not null
);
create table public.trading_decisions (
  id uuid primary key,
  account_id uuid not null references public.trading_accounts(id),
  state jsonb not null
);
create index on public.trading_orders(account_id);
create index on public.trading_fills(account_id);
create index on public.trading_decisions(account_id);

alter table public.trading_worker enable row level security;
alter table public.trading_accounts enable row level security;
alter table public.trading_orders enable row level security;
alter table public.trading_fills enable row level security;
alter table public.trading_decisions enable row level security;
revoke all on public.trading_worker, public.trading_accounts, public.trading_orders,
  public.trading_fills, public.trading_decisions from public, anon, authenticated;
grant all on public.trading_worker, public.trading_accounts, public.trading_orders,
  public.trading_fills, public.trading_decisions to service_role;

create function public.trading_claim_worker(p_holder uuid) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.trading_worker set holder = p_holder,
    expires_at = clock_timestamp() + interval '45 seconds'
  where singleton and (holder = p_holder or expires_at < clock_timestamp());
  return found;
end;
$$;

create function public.trading_release_worker(p_holder uuid) returns void
language sql set search_path = '' as $$
  update public.trading_worker set holder = null, expires_at = '-infinity'
  where singleton and holder = p_holder;
$$;

-- One RPC is one Postgres transaction: balances, orders and audit commit together.
-- The worker row lock fences expired workers, including an in-flight late save.
create function public.trading_save_account(
  p_holder uuid, p_account jsonb, p_revision bigint
) returns bigint language plpgsql set search_path = '' as $$
declare
  v_id uuid := (p_account->>'id')::uuid;
  v_revision bigint;
  v_row jsonb;
begin
  perform 1 from public.trading_worker where singleton and holder = p_holder
    and expires_at > clock_timestamp() for update;
  if not found then raise exception 'Trading worker lease lost'; end if;
  if p_revision = 0 then
    insert into public.trading_accounts(id, state) values(v_id, p_account)
      returning revision into v_revision;
  else
    update public.trading_accounts set state = p_account,
      revision = revision + 1, updated_at = now()
    where id = v_id and revision = p_revision returning revision into v_revision;
    if not found then raise exception 'Trading account revision conflict'; end if;
  end if;
  for v_row in select value from jsonb_array_elements(p_account->'orders') loop
    insert into public.trading_orders(id, account_id, state)
    values((v_row->>'id')::uuid, v_id, v_row)
    on conflict(id) do update set state = excluded.state
      where public.trading_orders.account_id = v_id;
  end loop;
  for v_row in select value from jsonb_array_elements(p_account->'fills') loop
    insert into public.trading_fills(id, account_id, state)
    values((v_row->>'id')::uuid, v_id, v_row) on conflict(id) do nothing;
  end loop;
  for v_row in select value from jsonb_array_elements(p_account->'journal') loop
    insert into public.trading_decisions(id, account_id, state)
    values((v_row->>'id')::uuid, v_id, v_row) on conflict(id) do nothing;
  end loop;
  return v_revision;
end;
$$;

revoke execute on function public.trading_claim_worker(uuid),
  public.trading_release_worker(uuid), public.trading_save_account(uuid,jsonb,bigint)
  from public, anon, authenticated;
grant execute on function public.trading_claim_worker(uuid),
  public.trading_release_worker(uuid), public.trading_save_account(uuid,jsonb,bigint)
  to service_role;
