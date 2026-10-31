// أنيس — خادم الحسابات والاشتراكات وتمرير طلبات Gemini
// Cloudflare Worker + D1. المفاتيح كلها أسرار (secrets) لا تظهر في الكود.

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Password',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const err = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);
const now = () => Date.now();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()); // YYYY-MM-DD
const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
};

function randToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- users & sessions ----------
async function upsertUser(env, { email, name, picture }) {
  email = String(email).trim().toLowerCase();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO users (email,name,picture,created,last_seen) VALUES (?1,?2,?3,?4,?4)
     ON CONFLICT(email) DO UPDATE SET name=COALESCE(excluded.name,users.name), picture=COALESCE(excluded.picture,users.picture), last_seen=?4`
  ).bind(email, name || null, picture || null, t).run();
  return env.DB.prepare('SELECT * FROM users WHERE email=?1').bind(email).first();
}

async function newSession(env, userId) {
  const token = randToken();
  await env.DB.prepare('INSERT INTO sessions (token,user_id,created) VALUES (?1,?2,?3)').bind(token, userId, now()).run();
  return token;
}

async function authUser(req, env) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?1').bind(token).first();
}

const isPremium = (u) => (u.premium_until || 0) > now();

async function usageToday(env, userId) {
  const row = await env.DB.prepare('SELECT count,bonus FROM usage WHERE user_id=?1 AND day=?2').bind(userId, today()).first();
  return { count: row?.count || 0, bonus: row?.bonus || 0 };
}

async function status(env, u) {
  const prem = isPremium(u);
  const use = await usageToday(env, u.id);
  const base = parseInt(prem ? env.PREMIUM_DAILY : env.FREE_DAILY, 10);
  const limit = base + (prem ? 0 : use.bonus);
  return {
    user: { email: u.email, name: u.name, picture: u.picture },
    premium: prem,
    premium_until: u.premium_until || 0,
    used: use.count,
    limit,
    remaining: Math.max(0, limit - use.count),
    bonus_claimed: u.bonus_day === today(),
    streak: u.streak || 0,
  };
}

// ---------- Google sign-in ----------
async function verifyGoogle(env, idToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return null;
  const p = await r.json();
  const allowed = String(env.GOOGLE_CLIENT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(p.aud)) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
  if (String(p.email_verified) !== 'true') return null;
  if (Number(p.exp) * 1000 < now()) return null;
  return { email: p.email, name: p.name, picture: p.picture };
}

// ---------- Gemini proxy with daily quota ----------
async function proxyGemini(req, env, u, target) {
  // target like "gemini-3.1-flash-lite:streamGenerateContent"
  const m = /^([a-z0-9][a-z0-9.\-]{2,60}):(generateContent|streamGenerateContent)$/i.exec(target);
  if (!m) return err('طلب غير صالح', 400);
  const st = await status(env, u);
  if (st.remaining <= 0)
    return err(st.premium ? 'وصلت للحد اليومي، يتجدد غدًا' : 'انتهت شروحك المجانية اليوم', 429, { code: 'QUOTA', status: st });

  // count first (prevents abuse by parallel requests); refund if Gemini fails
  const day = today();
  await env.DB.prepare(
    'INSERT INTO usage (user_id,day,count) VALUES (?1,?2,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1'
  ).bind(u.id, day).run();

  const url = new URL(req.url);
  const qs = m[2] === 'streamGenerateContent' ? '?alt=sse' : '';
  const body = await req.text();
  if (body.length > 8_000_000) return err('الطلب كبير جدًا', 413);
  let g;
  try {
    g = await fetch(GEMINI + encodeURIComponent(m[1]) + ':' + m[2] + qs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body,
    });
  } catch (e) {
    await env.DB.prepare('UPDATE usage SET count=MAX(0,count-1) WHERE user_id=?1 AND day=?2').bind(u.id, day).run();
    return err('تعذّر الاتصال بـ Gemini، حاول مرة أخرى', 502);
  }
  if (!g.ok) {
    await env.DB.prepare('UPDATE usage SET count=MAX(0,count-1) WHERE user_id=?1 AND day=?2').bind(u.id, day).run();
  }
  const headers = new Headers(CORS);
  headers.set('Content-Type', g.headers.get('Content-Type') || 'application/json');
  headers.set('X-Anis-Remaining', String(Math.max(0, st.remaining - (g.ok ? 1 : 0))));
  headers.set('Access-Control-Expose-Headers', 'X-Anis-Remaining');
  return new Response(g.body, { status: g.status, headers });
}

// ---------- daily bonus + streak ----------
async function claimDaily(env, u) {
  const d = today();
  if (u.bonus_day === d) return status(env, u);
  const streak = u.bonus_day === yesterday() ? (u.streak || 0) + 1 : 1;
  await env.DB.prepare('UPDATE users SET bonus_day=?1, streak=?2, last_seen=?3 WHERE id=?4').bind(d, streak, now(), u.id).run();
  await env.DB.prepare(
    'INSERT INTO usage (user_id,day,count,bonus) VALUES (?1,?2,0,?3) ON CONFLICT(user_id,day) DO UPDATE SET bonus=?3'
  ).bind(u.id, d, parseInt(env.DAILY_BONUS, 10)).run();
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(u.id).first();
  return status(env, fresh);
}

// ---------- admin ----------
function isAdmin(req, env) {
  return safeEqual(req.headers.get('X-Admin-Password'), env.ADMIN_PASSWORD);
}

async function adminApi(req, env, path) {
  if (!isAdmin(req, env)) return err('كلمة السر غير صحيحة', 401);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  if (path === '/admin/api/stats') {
    const t = await env.DB.prepare('SELECT COUNT(*) n FROM users').first();
    const p = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE premium_until>?1').bind(now()).first();
    const a = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(count),0) req FROM usage WHERE day=?1').bind(today()).first();
    const n7 = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE created>?1').bind(now() - 7 * 86400000).first();
    return json({ users: t.n, premium: p.n, active_today: a.n, requests_today: a.req, new_7d: n7.n });
  }
  if (path === '/admin/api/users') {
    const q = '%' + String(new URL(req.url).searchParams.get('q') || '').toLowerCase() + '%';
    const r = await env.DB.prepare(
      `SELECT id,email,name,premium_until,created,last_seen,streak FROM users WHERE lower(email) LIKE ?1 OR lower(COALESCE(name,'')) LIKE ?1 ORDER BY last_seen DESC LIMIT 50`
    ).bind(q).all();
    return json({ users: r.results });
  }
  if (path === '/admin/api/grant') {
    const days = Math.max(1, Math.min(3660, parseInt(body.days, 10) || 30));
    const u = await upsertUser(env, { email: body.email });
    const start = Math.max(now(), u.premium_until || 0);
    const until = start + days * 86400000;
    await env.DB.prepare('UPDATE users SET premium_until=?1 WHERE id=?2').bind(until, u.id).run();
    await env.DB.prepare('INSERT INTO grants (user_id,days,note,created) VALUES (?1,?2,?3,?4)').bind(u.id, days, body.note || '', now()).run();
    return json({ ok: true, email: u.email, premium_until: until });
  }
  if (path === '/admin/api/reports') {
    const r = await env.DB.prepare('SELECT id,email,reason,note,content,created FROM reports ORDER BY created DESC LIMIT 50').all();
    return json({ reports: r.results });
  }
  if (path === '/admin/api/revoke') {
    await env.DB.prepare('UPDATE users SET premium_until=0 WHERE email=?1').bind(String(body.email || '').toLowerCase()).run();
    return json({ ok: true });
  }
  if (path === '/admin/api/dev-session') {
    // للتجربة قبل تفعيل الدخول بجوجل: جلسة لبريد معيّن (للمدير فقط)
    const u = await upsertUser(env, { email: body.email, name: body.name || null });
    return json({ token: await newSession(env, u.id) });
  }
  return err('غير موجود', 404);
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/health') return json({ ok: true, name: 'anis', time: new Date().toISOString(), google: !!env.GOOGLE_CLIENT_IDS });
      if (path === '/config')
        return json({
          free_daily: parseInt(env.FREE_DAILY, 10), daily_bonus: parseInt(env.DAILY_BONUS, 10), premium_daily: parseInt(env.PREMIUM_DAILY, 10),
          price_month: env.PRICE_MONTH, price_year: env.PRICE_YEAR,
          instapay: env.PAY_INSTAPAY || '', instapay_link: env.PAY_INSTAPAY_LINK || '', wallet: env.PAY_WALLET || '', whatsapp: env.WHATSAPP || '',
        });
      if (path === '/privacy') return new Response(PRIVACY_HTML.replaceAll('{{EMAIL}}', env.SUPPORT_EMAIL || 'gamyahmed024@gmail.com'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path === '/delete-account') return new Response(DELETE_HTML.replaceAll('{{EMAIL}}', env.SUPPORT_EMAIL || 'gamyahmed024@gmail.com'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path === '/report' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const ru = await authUser(req, env).catch(() => null);
        const clip = (v, n) => String(v || '').slice(0, n);
        await env.DB.prepare('INSERT INTO reports (user_id,email,reason,note,content,created) VALUES (?1,?2,?3,?4,?5,?6)')
          .bind(ru ? ru.id : null, ru ? ru.email : null, clip(b.reason, 40), clip(b.note, 600), clip(b.content, 4000), now()).run();
        return json({ ok: true });
      }
      if (path === '/admin') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path.startsWith('/admin/api/')) return adminApi(req, env, path);

      if (path === '/auth/google' && req.method === 'POST') {
        const { idToken } = await req.json().catch(() => ({}));
        if (!idToken) return err('بيانات الدخول ناقصة');
        const g = await verifyGoogle(env, idToken);
        if (!g) return err('تعذّر التحقق من حساب جوجل', 401);
        const u = await upsertUser(env, g);
        const token = await newSession(env, u.id);
        return json({ token, ...(await status(env, u)) });
      }

      const u = await authUser(req, env);
      if (!u) return err('سجّل الدخول أولًا', 401, { code: 'AUTH' });

      if (path === '/me') {
        await env.DB.prepare('UPDATE users SET last_seen=?1 WHERE id=?2').bind(now(), u.id).run();
        return json(await status(env, u));
      }
      if (path === '/daily' && req.method === 'POST') return json(await claimDaily(env, u));
      if (path.startsWith('/ai/') && req.method === 'POST') return proxyGemini(req, env, u, decodeURIComponent(path.slice(4)));
      if (path === '/logout' && req.method === 'POST') {
        const token = (req.headers.get('Authorization') || '').slice(7).trim();
        await env.DB.prepare('DELETE FROM sessions WHERE token=?1').bind(token).run();
        return json({ ok: true });
      }
      if (path === '/account/delete' && req.method === 'POST') {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?1').bind(u.id),
          env.DB.prepare('DELETE FROM usage WHERE user_id=?1').bind(u.id),
          env.DB.prepare('DELETE FROM grants WHERE user_id=?1').bind(u.id),
          env.DB.prepare('DELETE FROM users WHERE id=?1').bind(u.id),
        ]);
        return json({ ok: true });
      }
      return err('غير موجود', 404);
    } catch (e) {
      return err('خطأ في الخادم: ' + (e && e.message ? e.message : e), 500);
    }
  },
};

const PAGE_CSS = `<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:760px;margin:0 auto;padding:24px 18px;line-height:1.9;color:#1C2A24;background:#F6F0E2}h1{color:#1F4D3F;line-height:1.4}h2{color:#A87A2C;font-size:19px;margin-top:26px}.en{direction:ltr;text-align:left;border-top:2px solid #E4D9BF;margin-top:40px;padding-top:10px}a{color:#1F4D3F}.box{background:#FFFDF7;border:1px solid #E4D9BF;border-radius:14px;padding:12px 16px}</style>`;
const PRIVACY_HTML = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — Anis: Read with a Friend · سياسة الخصوصية — أنيس</title>${PAGE_CSS}</head><body>
<p><a href="#en">English version below ↓</a></p>
<h1>سياسة الخصوصية لتطبيق «أنيس: اقرأ مع صديق»</h1>
<p>آخر تحديث: 31 أكتوبر 2026 · المطوّر: عمر جمال (مصر)</p>
<h2>ما الذي نجمعه؟</h2>
<p>عند تسجيل الدخول بحساب جوجل نحصل فقط على: اسمك، وبريدك الإلكتروني، وصورة حسابك. لا نحصل أبدًا على كلمة سرّك.</p>
<p>ونحفظ أيضًا: حالة اشتراكك وتاريخ انتهائه، وعدد طلبات الذكاء الاصطناعي اليومية (لتطبيق الحد اليومي)، وسلسلة أيام استخدامك.</p>
<h2>كتبك ومحتواك</h2>
<p>كتبك وملفاتك وملاحظاتك ودفترك وبطاقاتك محفوظة على هاتفك فقط ولا تُرفع إلى خوادمنا.</p>
<p>عند طلبك شرحًا أو ترجمة أو أي ميزة ذكاء اصطناعي، يُرسَل المقطع الذي حددته (نصًا أو صورة) أو الصفحة الحالية عبر خادمنا إلى خدمة Google Gemini لمعالجته وإرجاع الرد. لا نخزّن هذا المحتوى على خوادمنا. وتعالجه Google وفق شروطها لخدمة Gemini API.</p>
<h2>البلاغات</h2>
<p>إذا أبلغت عن رد غير لائق من داخل التطبيق، نحفظ نص الرد وسبب البلاغ وبريدك (إن كنت مسجلًا) لمراجعته وتحسين الخدمة.</p>
<h2>الأذونات</h2>
<p>الميكروفون: فقط عند ضغطك زر الإملاء الصوتي لتحويل كلامك إلى نص. الإشعارات: فقط إن فعّلت التذكير اليومي.</p>
<h2>كيف نستخدم بياناتك؟</h2>
<p>لتشغيل حسابك واشتراكك والحد اليومي فقط. لا نبيع بياناتك، ولا نشاركها مع أي جهة إعلانية، ولا نعرض إعلانات. تُنقل البيانات مشفّرة (HTTPS).</p>
<h2>الأطفال</h2>
<p>التطبيق غير موجّه للأطفال دون 13 عامًا.</p>
<h2>حذف الحساب</h2>
<p>يمكنك حذف حسابك وكل بياناته على خوادمنا في أي وقت من داخل التطبيق: الإعدادات ← «حذف حسابي»، ويتم الحذف فورًا. أو اطلب الحذف من صفحة <a href="/delete-account">حذف الحساب</a>.</p>
<h2>التواصل</h2>
<p>{{EMAIL}}</p>
<div class="en" id="en" dir="ltr">
<h1>Privacy Policy — Anis: Read with a Friend</h1>
<p>Last updated: October 31, 2026 · Developer: Omar Gamal (Egypt)</p>
<h2>What we collect</h2>
<p>When you sign in with Google we receive only your name, email address and profile picture. We never receive your password.</p>
<p>We also store your subscription status and expiry date, your daily number of AI requests (to apply the daily limit), and your usage streak.</p>
<h2>Your books and content</h2>
<p>Your books, files, notes, notebook and cards are stored on your phone only and are not uploaded to our servers.</p>
<p>When you request an explanation, translation or any AI feature, the passage you selected (text or image) or the current page is sent through our server to Google Gemini to generate the reply. We do not store this content on our servers. Google processes it under the Gemini API terms.</p>
<h2>Reports</h2>
<p>If you report an inappropriate reply from inside the app, we store the reply text, the reason and your email (if signed in) to review it and improve the service.</p>
<h2>Permissions</h2>
<p>Microphone: only when you tap the voice-dictation button, to turn your speech into text. Notifications: only if you turn on the daily reminder.</p>
<h2>How we use your data</h2>
<p>Only to run your account, subscription and daily limit. We do not sell your data, share it with advertisers, or show ads. Data is encrypted in transit (HTTPS).</p>
<h2>Children</h2>
<p>The app is not directed to children under 13.</p>
<h2>Account deletion</h2>
<p>You can delete your account and all its data on our servers at any time in the app: Settings → “Delete my account”. Deletion is immediate. You can also request it on the <a href="/delete-account">account deletion page</a>.</p>
<h2>Contact</h2>
<p>{{EMAIL}}</p>
</div>
</body></html>`;
const DELETE_HTML = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delete your account — Anis · حذف الحساب — أنيس</title>${PAGE_CSS}</head><body>
<h1>حذف حسابك في «أنيس: اقرأ مع صديق»</h1>
<div class="box">
<h2 style="margin-top:6px">الطريقة الأسرع: من داخل التطبيق</h2>
<ol><li>افتح التطبيق ← <b>الإعدادات</b>.</li><li>في بطاقة «حسابك» اضغط <b>حذف حسابي</b>.</li><li>اضغط <b>نعم، احذف حسابي</b>.</li></ol>
<h2>أو اطلب الحذف بالبريد</h2>
<p>أرسل رسالة إلى <a href="mailto:{{EMAIL}}?subject=Delete%20my%20Anis%20account">{{EMAIL}}</a> من نفس البريد المسجّل في التطبيق بعنوان «حذف حسابي»، وسنحذفه خلال 7 أيام كحد أقصى.</p>
</div>
<h2>ما الذي يُحذف؟</h2>
<p>كل بياناتك على خوادمنا: الاسم والبريد والصورة، والاشتراك، وسجل الاستخدام اليومي، وجلسات الدخول. لا نحتفظ بأي نسخة منها بعد الحذف.</p>
<p>كتبك ودفترك وبطاقاتك محفوظة على هاتفك فقط، وتُحذف بحذف التطبيق.</p>
<div class="en" dir="ltr">
<h1>Delete your “Anis: Read with a Friend” account</h1>
<div class="box">
<h2 style="margin-top:6px">Fastest: inside the app</h2>
<ol><li>Open the app → <b>Settings</b>.</li><li>In the “Your account” card tap <b>Delete my account</b>.</li><li>Tap <b>Yes, delete my account</b>.</li></ol>
<h2>Or request deletion by email</h2>
<p>Email <a href="mailto:{{EMAIL}}?subject=Delete%20my%20Anis%20account">{{EMAIL}}</a> from the email address you use in the app, with the subject “Delete my account”. We will delete it within 7 days at most.</p>
</div>
<h2>What is deleted?</h2>
<p>All your data on our servers: name, email and picture, subscription, daily usage history and sign-in sessions. We keep no copy after deletion.</p>
<p>Your books, notebook and cards are stored only on your phone and are removed when you uninstall the app.</p>
</div>
</body></html>`;

const ADMIN_HTML = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>لوحة تحكم أنيس</title>
<style>
:root{--bg:#F6F0E2;--ink:#1C2A24;--em:#1F4D3F;--gold:#B8893B;--card:#FFFDF7;--line:#E4D9BF;--muted:#7D7766}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Tahoma,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 60px}
.hero{background:linear-gradient(150deg,#123128,#1F4D3F 50%,#2E6B57);color:#F6E7C1;border-radius:22px;padding:18px;box-shadow:0 16px 30px -16px rgba(12,40,32,.7)}
.hero h1{margin:0 0 6px;font-size:22px;color:#E9CF8F}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:12px}
.st{background:rgba(255,255,255,.08);border:1px solid rgba(233,207,143,.3);border-radius:14px;padding:10px;text-align:center}
.st b{display:block;font-size:24px;color:#E9CF8F}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:14px}
input,select{font:inherit;width:100%;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff}
button{font:inherit;border:0;border-radius:12px;padding:11px 14px;background:linear-gradient(135deg,#1F4D3F,#2B6650);color:#F6E7C1;cursor:pointer}
button.g{background:linear-gradient(135deg,#C9973F,#E3C27A);color:#14201B}button.r{background:#9b2d2d;color:#fff}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:var(--muted);font-size:13px}
.u{border-top:1px solid var(--line);padding:10px 0}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;background:#F1E6CB;color:#7a5a1d}.pill.p{background:#1F4D3F;color:#F6E7C1}
#msg{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1C2A24;color:#F6E7C1;padding:10px 16px;border-radius:99px;display:none}
</style></head><body><div class="wrap">
<div id="login" class="card"><h2 style="margin-top:0">لوحة تحكم أنيس 🔐</h2><input id="pw" type="password" placeholder="كلمة سر لوحة التحكم" onkeydown="if(event.key==='Enter')enter()"><div style="height:10px"></div><button onclick="enter()">دخول</button></div>
<div id="app" style="display:none">
<div class="hero"><h1>لوحة تحكم أنيس</h1><div class="muted" style="color:rgba(246,231,193,.75)">المستخدمون والاشتراكات</div>
<div class="grid"><div class="st"><b id="s1">–</b>مستخدم</div><div class="st"><b id="s2">–</b>مشترك</div><div class="st"><b id="s3">–</b>نشط اليوم</div><div class="st"><b id="s4">–</b>طلبات اليوم</div><div class="st"><b id="s5">–</b>جديد هذا الأسبوع</div></div></div>
<div class="card"><b>تفعيل اشتراك</b><div class="muted" style="margin:4px 0 10px">اكتب بريد المستخدم كما يظهر في التطبيق، ثم اختر المدة.</div>
<input id="em" type="email" placeholder="name@gmail.com" dir="ltr"><div style="height:8px"></div>
<input id="note" placeholder="ملاحظة (اختياري): مثلًا إنستاباي 49ج"><div style="height:8px"></div>
<div class="row"><button class="g" onclick="grant(30)">فعّل شهر</button><button class="g" onclick="grant(365)">فعّل سنة</button><button onclick="grant(7)">أسبوع تجربة</button><button class="r" onclick="revoke()">إلغاء الاشتراك</button></div></div>
<div class="card"><div class="row"><b style="flex:1">🚩 بلاغات عن ردود أنيس</b><button onclick="reps()">عرض</button></div><div id="rl" class="muted" style="margin-top:6px">اضغط «عرض» لرؤية آخر البلاغات.</div></div>
<div class="card"><div class="row"><input id="q" placeholder="ابحث بالبريد أو الاسم…" oninput="clearTimeout(window.t);window.t=setTimeout(load,300)" style="flex:1"></div><div id="list"></div></div>
</div></div><div id="msg"></div>
<script>
let PW='';try{PW=sessionStorage.getItem('pw')||''}catch(e){}
const api=async(p,b)=>{const r=await fetch(p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json','X-Admin-Password':PW},body:b?JSON.stringify(b):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d};
const msg=t=>{const m=document.getElementById('msg');m.textContent=t;m.style.display='block';clearTimeout(window.mt);window.mt=setTimeout(()=>m.style.display='none',2600)};
const fmt=t=>t?new Date(t).toLocaleDateString('ar-EG',{day:'numeric',month:'short',year:'numeric'}):'—';
async function enter(){PW=document.getElementById('pw').value||PW;try{await stats();try{sessionStorage.setItem('pw',PW)}catch(e){}document.getElementById('login').style.display='none';document.getElementById('app').style.display='block';load()}catch(e){msg('كلمة السر غير صحيحة')}}
async function stats(){const s=await api('/admin/api/stats');s1.textContent=s.users;s2.textContent=s.premium;s3.textContent=s.active_today;s4.textContent=s.requests_today;s5.textContent=s.new_7d}
async function load(){const d=await api('/admin/api/users?q='+encodeURIComponent(q.value));list.innerHTML=d.users.length?d.users.map(u=>{const p=u.premium_until>Date.now();return '<div class="u"><div class="row"><b style="flex:1" dir="ltr">'+u.email+'</b><span class="pill '+(p?'p':'')+'">'+(p?'مميّز حتى '+fmt(u.premium_until):'مجاني')+'</span></div><div class="muted">'+(u.name||'')+' · آخر ظهور '+fmt(u.last_seen)+' · سلسلة '+(u.streak||0)+' يوم</div><div class="row" style="margin-top:6px"><button class="g" onclick="em.value=\\''+u.email+'\\';grant(30)">+ شهر</button><button onclick="em.value=\\''+u.email+'\\';window.scrollTo(0,0)">تحديد</button></div></div>'}).join(''):'<div class="muted" style="padding:10px 0">لا يوجد مستخدمون بعد.</div>'}
async function grant(days){const e=em.value.trim();if(!e)return msg('اكتب البريد أولًا');try{const r=await api('/admin/api/grant',{email:e,days,note:note.value});msg('تم ✓ مميّز حتى '+fmt(r.premium_until));note.value='';stats();load()}catch(x){msg('خطأ: '+x.message)}}
async function revoke(){const e=em.value.trim();if(!e)return msg('اكتب البريد أولًا');if(!confirm('إلغاء اشتراك '+e+'؟'))return;await api('/admin/api/revoke',{email:e});msg('أُلغي الاشتراك');stats();load()}
async function reps(){const d=await api('/admin/api/reports');const e=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));rl.innerHTML=d.reports.length?d.reports.map(r=>'<div class="u"><div class="row"><span class="pill">'+e(r.reason)+'</span><span class="muted" style="flex:1">'+fmt(r.created)+' · '+e(r.email||'بدون حساب')+'</span></div>'+(r.note?'<div>'+e(r.note)+'</div>':'')+'<div class="muted" style="white-space:pre-wrap;max-height:160px;overflow:auto;margin-top:4px">'+e(r.content)+'</div></div>').join(''):'لا بلاغات 🌿'}
if(PW)enter();
</script></body></html>`;
