-- 공제플랜 기기 간 동기화 테이블 (새 Supabase 프로젝트의 SQL Editor에서 한 번 실행)
-- 내역 1건 = 1행, 총급여는 사용자당 1행. RLS로 로그인한 본인 행만 읽고 쓸 수 있습니다.

create table if not exists public.card_plan_records (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  payload jsonb not null check (pg_column_size(payload) <= 4096),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  check (length(id) between 1 and 100)
);

create table if not exists public.card_plan_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  salary bigint not null check (salary > 0),
  updated_at timestamptz not null default now()
);

create or replace function public.card_plan_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists card_plan_records_touch on public.card_plan_records;
create trigger card_plan_records_touch before update on public.card_plan_records for each row execute function public.card_plan_touch();
drop trigger if exists card_plan_settings_touch on public.card_plan_settings;
create trigger card_plan_settings_touch before update on public.card_plan_settings for each row execute function public.card_plan_touch();

-- 한 사람이 서버를 가득 채우지 못하게 내역은 사용자당 5만 건까지
create or replace function public.card_plan_records_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.card_plan_records where user_id = new.user_id) >= 50000 then
    raise exception 'card_plan_records limit 50000';
  end if;
  return new;
end $$;
drop trigger if exists card_plan_records_limit on public.card_plan_records;
create trigger card_plan_records_limit before insert on public.card_plan_records for each row execute function public.card_plan_records_limit();

-- 회원 탈퇴: 로그인한 본인의 내역·총급여·계정을 모두 삭제(앱 설정 → 회원 탈퇴)
create or replace function public.card_plan_delete_me() returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.card_plan_records where user_id = auth.uid();
  delete from public.card_plan_settings where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.card_plan_delete_me() from public, anon;
grant execute on function public.card_plan_delete_me() to authenticated;
revoke all on function public.card_plan_records_limit() from public, anon, authenticated;

alter table public.card_plan_records enable row level security;
alter table public.card_plan_settings enable row level security;

revoke all on public.card_plan_records, public.card_plan_settings from anon;
grant select, insert, update, delete on public.card_plan_records, public.card_plan_settings to authenticated;

drop policy if exists "own records" on public.card_plan_records;
create policy "own records" on public.card_plan_records for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own settings" on public.card_plan_settings;
create policy "own settings" on public.card_plan_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 확인: 기대값 tables 2 / rls_on true / policies 2 / anon_grants 0 / delete_fn 1 / anon_can_delete false
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('card_plan_records','card_plan_settings')) as tables,
  (select bool_and(relrowsecurity) from pg_class where relname in ('card_plan_records','card_plan_settings') and relnamespace = 'public'::regnamespace) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename in ('card_plan_records','card_plan_settings')) as policies,
  (select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_name in ('card_plan_records','card_plan_settings')) as anon_grants,
  (select count(*) from pg_proc where proname = 'card_plan_delete_me') as delete_fn,
  has_function_privilege('anon', 'public.card_plan_delete_me()', 'execute') as anon_can_delete;
