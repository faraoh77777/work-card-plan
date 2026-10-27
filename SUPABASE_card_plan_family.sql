-- 부부 함께 쓰기 (SUPABASE_card_plan.sql 실행 후, SQL Editor에서 한 번 실행)
-- 초대한 사람(owner)이 초대코드를 만들고, 배우자(member)가 코드를 입력하면 연결됩니다. 한 사람은 한 연결에만 들어갈 수 있습니다.
--  together(같이 사용): 소득이 있는 owner 한 사람의 장부를 둘이 함께 읽고 씁니다. 배우자 사용분도 owner 공제로 잡힙니다.
--  separate(따로 사용): 각자 연말정산. 장부는 각자, 상대 장부는 읽기만 합니다(가계부 부부 합계용).

create table if not exists public.card_plan_family (
  owner uuid not null references auth.users(id) on delete cascade,
  member uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('together','separate')),
  owner_email text,
  member_email text,
  created_at timestamptz not null default now(),
  primary key (owner, member),
  check (owner <> member)
);
create unique index if not exists card_plan_family_owner_one on public.card_plan_family(owner);
create unique index if not exists card_plan_family_member_one on public.card_plan_family(member);

create table if not exists public.card_plan_invites (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  owner uuid not null unique references auth.users(id) on delete cascade,
  mode text not null check (mode in ('together','separate')),
  expires_at timestamptz not null default now() + interval '24 hours'
);

alter table public.card_plan_family enable row level security;
alter table public.card_plan_invites enable row level security;
revoke all on public.card_plan_family, public.card_plan_invites from anon, authenticated;
grant select, delete on public.card_plan_family to authenticated;
grant select on public.card_plan_invites to authenticated;

drop policy if exists "my family" on public.card_plan_family;
create policy "my family" on public.card_plan_family for select to authenticated using (auth.uid() in (owner, member));
drop policy if exists "leave family" on public.card_plan_family;
create policy "leave family" on public.card_plan_family for delete to authenticated using (auth.uid() in (owner, member));
drop policy if exists "my invite" on public.card_plan_invites;
create policy "my invite" on public.card_plan_invites for select to authenticated using (owner = auth.uid());

-- 상대 장부 읽기/쓰기 권한 판단(RLS 안에서 쓰므로 security definer)
create or replace function public.card_plan_can_read(book uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.card_plan_family f
    where (f.member = auth.uid() and f.owner = book) or (f.owner = auth.uid() and f.member = book and f.mode = 'separate'))
$$;
create or replace function public.card_plan_can_write(book uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.card_plan_family f where f.member = auth.uid() and f.owner = book and f.mode = 'together')
$$;
revoke all on function public.card_plan_can_read(uuid), public.card_plan_can_write(uuid) from public, anon;
grant execute on function public.card_plan_can_read(uuid), public.card_plan_can_write(uuid) to authenticated;

-- 초대코드 만들기: 이미 연결돼 있으면 거절, 기존 코드는 새 코드로 바꿈
create or replace function public.card_plan_invite(p_mode text) returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_mode not in ('together','separate') then raise exception 'bad mode'; end if;
  if exists (select 1 from card_plan_family where auth.uid() in (owner, member)) then raise exception 'already linked'; end if;
  delete from card_plan_invites where owner = auth.uid() or expires_at < now();
  loop
    -- 헷갈리는 글자(0·O·1·I·L) 뺀 31자에서 6자
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') into c from generate_series(1, 6);
    exit when not exists (select 1 from card_plan_invites where code = c);
  end loop;
  insert into card_plan_invites(code, owner, mode) values (c, auth.uid(), p_mode);
  return c;
end $$;

-- 초대코드 입력해 연결
create or replace function public.card_plan_join(p_code text) returns text language plpgsql security definer set search_path = public, auth as $$
declare i card_plan_invites;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into i from card_plan_invites where code = upper(trim(p_code)) and expires_at > now();
  if not found then raise exception 'bad code'; end if;
  if i.owner = auth.uid() then raise exception 'own code'; end if;
  if exists (select 1 from card_plan_family where owner in (i.owner, auth.uid()) or member in (i.owner, auth.uid())) then raise exception 'already linked'; end if;
  insert into card_plan_family(owner, member, mode, owner_email, member_email)
  values (i.owner, auth.uid(), i.mode, (select email from auth.users where id = i.owner), (select email from auth.users where id = auth.uid()));
  delete from card_plan_invites where owner = i.owner;
  return i.mode;
end $$;
revoke all on function public.card_plan_invite(text), public.card_plan_join(text) from public, anon;
grant execute on function public.card_plan_invite(text), public.card_plan_join(text) to authenticated;

-- 내역·총급여 정책 교체: 본인 것 + 연결된 배우자 것(같이 사용은 읽기·쓰기, 따로 사용은 읽기만)
drop policy if exists "own records" on public.card_plan_records;
drop policy if exists "records read" on public.card_plan_records;
drop policy if exists "records write" on public.card_plan_records;
create policy "records read" on public.card_plan_records for select to authenticated
  using (user_id = auth.uid() or public.card_plan_can_read(user_id));
create policy "records write" on public.card_plan_records for all to authenticated
  using (user_id = auth.uid() or public.card_plan_can_write(user_id))
  with check (user_id = auth.uid() or public.card_plan_can_write(user_id));
drop policy if exists "own settings" on public.card_plan_settings;
drop policy if exists "settings read" on public.card_plan_settings;
drop policy if exists "settings write" on public.card_plan_settings;
create policy "settings read" on public.card_plan_settings for select to authenticated
  using (user_id = auth.uid() or public.card_plan_can_read(user_id));
create policy "settings write" on public.card_plan_settings for all to authenticated
  using (user_id = auth.uid() or public.card_plan_can_write(user_id))
  with check (user_id = auth.uid() or public.card_plan_can_write(user_id));

-- 확인: 기대값 tables 2 / policies 4 / fns 4 / anon_can_join false
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('card_plan_family','card_plan_invites')) as tables,
  (select count(*) from pg_policies where schemaname = 'public' and tablename in ('card_plan_records','card_plan_settings')) as policies,
  (select count(*) from pg_proc where proname in ('card_plan_can_read','card_plan_can_write','card_plan_invite','card_plan_join')) as fns,
  has_function_privilege('anon', 'public.card_plan_join(text)', 'execute') as anon_can_join;
