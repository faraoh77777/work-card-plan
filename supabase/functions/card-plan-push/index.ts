// 똑씀이 경조사 자동 알림(웹 푸시) 발송 함수.
// - 예약(pg_cron, 10분마다)이 x-cron-secret 머리글로 부르면: 알림을 켠 기기의 회원마다 경조사 일정(card_plan_records의 ev- 행)과
//   알람 시간(cfg-alert의 time)을 보고, 지금 보낼 알림(전날 알람 시간 / 시간 있는 일정 1시간 전 / 시간 없는 일정 당일 08:00)을 보냅니다.
// - 로그인한 앱이 {action:'test'}로 부르면: 그 회원의 기기에 시험 알림을 보냅니다.
// 시간은 모두 한국 시간(UTC+9, 서머타임 없음)으로 계산합니다. 보낸 알림은 card_plan_push_log에 남겨 두 번 보내지 않습니다.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import webpush from 'npm:web-push@3.6.7';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CARD_PLAN_CRON_SECRET') ?? '';
webpush.setVapidDetails('mailto:faraoh@naver.com', Deno.env.get('VAPID_PUBLIC')!, Deno.env.get('VAPID_PRIVATE')!);

const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info' };
const KST = 9 * 3600e3;
const CATCH_UP = 3 * 3600e3; // 서버가 잠시 멈췄어도 3시간 안이면 늦게라도 보냄
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Ev = { id: string; date: string; time?: string; person: string; kind: string; place?: string };
type Sub = { user_id: string; endpoint: string; p256dh: string; auth: string };

// 한국 시간 'YYYY-MM-DD' + 분 → UTC 밀리초
const kstMs = (date: string, min: number) => Date.parse(date + 'T00:00:00Z') - KST + min * 60e3;
const hm = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// 일정 하나의 알림 2개(앱의 eventAlarmPlan과 같은 규칙)
function duesOf(v: Ev, alarmTime: string) {
  const title = `${v.person} ${v.kind}`;
  const when = v.time ? ` ${v.time}` : '';
  const where = v.place ? ` · ${v.place}` : '';
  return [
    { kind: 'before', at: kstMs(v.date, hm(alarmTime) - 1440), title: `내일 ${title}`, body: `내일${when}${where || ' 일정이 있어요'}` },
    v.time
      ? { kind: 'second', at: kstMs(v.date, hm(v.time) - 60), title: `1시간 뒤 ${title}`, body: `오늘${when}${where}` }
      : { kind: 'second', at: kstMs(v.date, 480), title: `오늘 ${title}`, body: `오늘${where || ' 일정이 있어요'}` },
  ];
}

async function sendTo(subs: Sub[], msg: Record<string, unknown>) {
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 6 * 3600 });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404·410 = 기기에서 알림을 끄거나 앱을 지움 → 구독 삭제
      if (code === 404 || code === 410) await db.from('card_plan_push_subs').delete().eq('user_id', s.user_id).eq('endpoint', s.endpoint);
      else console.warn('push fail', code, String(e).slice(0, 200));
    }
  }
  return ok;
}

async function runCron() {
  const now = Date.now();
  const { data: subs, error } = await db.from('card_plan_push_subs').select('user_id,endpoint,p256dh,auth');
  if (error) throw error;
  const byUser = new Map<string, Sub[]>();
  for (const s of subs ?? []) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);
  // 어제~모레 일정만 보면 됨(전날 알림 ~ 당일 알림)
  const day = (d: number) => new Date(now + KST + d * 864e5).toISOString().slice(0, 10);
  const lo = day(-1), hi = day(2);
  let sent = 0;
  for (const [uid, us] of byUser) {
    const { data: rows, error: e2 } = await db.from('card_plan_records').select('id,payload').eq('user_id', uid).or('id.like.ev-*,id.eq.cfg-alert');
    if (e2) { console.warn('records', e2.message); continue; }
    const cfg = rows?.find((r) => r.id === 'cfg-alert')?.payload ?? {};
    const alarmTime = /^\d{2}:\d{2}$/.test(cfg.time) ? cfg.time : '09:00';
    const evs = (rows ?? []).filter((r) => r.id.startsWith('ev-')).map((r) => ({ ...r.payload, id: r.id }) as Ev)
      .filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date) && v.date >= lo && v.date <= hi);
    for (const v of evs) {
      for (const d of duesOf(v, alarmTime)) {
        if (d.at > now || now - d.at > CATCH_UP) continue;
        const key = new Date(d.at).toISOString();
        // 먼저 기록(중복 키면 이미 보낸 것) → 그다음 발송
        const { error: e3 } = await db.from('card_plan_push_log').insert({ user_id: uid, event_id: v.id, kind: d.kind, due: key });
        if (e3) continue;
        sent += await sendTo(us, { title: d.title, body: d.body, tag: v.id + '-' + d.kind, url: './' });
      }
    }
  }
  await db.from('card_plan_push_log').delete().lt('sent_at', new Date(now - 60 * 864e5).toISOString());
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  try {
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) return json({ sent: await runCron() });
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = token ? await db.auth.getUser(token) : { data: { user: null } };
    if (!u?.user) return json({ error: 'auth' }, 401);
    const body = await req.json().catch(() => ({}));
    if (body?.action !== 'test') return json({ error: 'action' }, 400);
    const { data: subs, error } = await db.from('card_plan_push_subs').select('user_id,endpoint,p256dh,auth').eq('user_id', u.user.id);
    if (error) throw error;
    return json({ sent: await sendTo(subs ?? [], { title: '똑씀이 알림 시험', body: '경조사 자동 알림이 이 기기에 잘 도착해요.', tag: 'test', url: './' }) });
  } catch (e) {
    console.error(e);
    return json({ error: 'server' }, 500);
  }
});
