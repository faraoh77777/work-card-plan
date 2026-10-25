-- 똑씀이 경조사 자동 알림(웹 푸시). SUPABASE_card_plan.sql 다음에 실행합니다.
-- 1) 기기별 푸시 구독(회원 본인만 넣고 지움) 2) 보낸 알림 기록(서버 함수만 씀) 3) 10분마다 발송 함수 호출 예약.
-- 예약이 쓰는 비밀값은 저장소에 두지 않고 Vault에 'card_plan_push_cron' 이름으로 따로 넣습니다:
--   select vault.create_secret('<비밀값>', 'card_plan_push_cron');   (함수 비밀 CARD_PLAN_CRON_SECRET과 같은 값)

create table if not exists public.card_plan_push_subs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null check (length(endpoint) between 10 and 1000),
  p256dh text not null check (length(p256dh) between 10 and 200),
  auth text not null check (length(auth) between 10 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, endpoint)
);
alter table public.card_plan_push_subs enable row level security;
drop policy if exists "own push subs select" on public.card_plan_push_subs;
create policy "own push subs select" on public.card_plan_push_subs for select to authenticated using (user_id = auth.uid());
drop policy if exists "own push subs insert" on public.card_plan_push_subs;
create policy "own push subs insert" on public.card_plan_push_subs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "own push subs update" on public.card_plan_push_subs;
create policy "own push subs update" on public.card_plan_push_subs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own push subs delete" on public.card_plan_push_subs;
create policy "own push subs delete" on public.card_plan_push_subs for delete to authenticated using (user_id = auth.uid());

-- 한 회원 기기 20대까지
create or replace function public.card_plan_push_subs_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.card_plan_push_subs where user_id = new.user_id) >= 20 then
    raise exception 'card_plan_push_subs limit 20';
  end if;
  return new;
end $$;
drop trigger if exists card_plan_push_subs_limit on public.card_plan_push_subs;
create trigger card_plan_push_subs_limit before insert on public.card_plan_push_subs for each row execute function public.card_plan_push_subs_limit();

create table if not exists public.card_plan_push_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null,
  kind text not null,
  due text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, event_id, kind, due)
);
alter table public.card_plan_push_log enable row level security; -- 정책 없음 = 앱에서는 못 읽고 서버 함수(service role)만 씀

-- 10분마다 발송 함수 호출
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule('card-plan-push') where exists (select 1 from cron.job where jobname = 'card-plan-push');
select cron.schedule('card-plan-push', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://dfbexiheqigxnboyzrmt.supabase.co/functions/v1/card-plan-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'card_plan_push_cron')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$$);
