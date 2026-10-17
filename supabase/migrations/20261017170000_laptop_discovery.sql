-- Public connection metadata only. Account records and secrets remain private.
create table public.trading_runtime (
  singleton boolean primary key default true check (singleton),
  holder uuid not null,
  url text not null check (url ~ '^https://[a-z0-9-]+[.]trycloudflare[.]com$'),
  heartbeat timestamptz not null default now()
);
alter table public.trading_runtime enable row level security;
revoke all on public.trading_runtime from public, anon, authenticated;
grant all on public.trading_runtime to service_role;

create function public.trading_publish_runtime(p_holder uuid, p_url text) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.trading_worker where singleton and holder = p_holder
    and expires_at > clock_timestamp() for update;
  if not found then raise exception 'Trading worker lease lost'; end if;
  insert into public.trading_runtime(singleton, holder, url, heartbeat)
    values(true, p_holder, p_url, clock_timestamp())
  on conflict(singleton) do update set holder = excluded.holder,
    url = excluded.url, heartbeat = excluded.heartbeat;
end;
$$;
revoke execute on function public.trading_publish_runtime(uuid,text) from public, anon, authenticated;
grant execute on function public.trading_publish_runtime(uuid,text) to service_role;

-- This narrowly scoped definer exposes only a fresh HTTPS connection URL.
create function public.trading_discover_runtime() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('url', r.url, 'heartbeat', r.heartbeat)
  from public.trading_runtime r join public.trading_worker w
    on w.singleton = r.singleton and w.holder = r.holder
  where r.singleton and w.expires_at > now()
    and r.heartbeat > now() - interval '45 seconds';
$$;
revoke execute on function public.trading_discover_runtime() from public;
grant execute on function public.trading_discover_runtime() to anon, authenticated, service_role;
