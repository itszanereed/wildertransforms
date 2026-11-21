// Stripe → Wilder Transforms app
// When a client pays: create their app account, set their tier, turn access on, ping Telegram.
// When a subscription is canceled or stops paying: turn access off, ping Telegram.
//
// Vercel → Settings → Environment Variables:
//   STRIPE_WEBHOOK_SECRET        whsec_...   (Stripe → Webhooks → your endpoint → Signing secret)
//   STRIPE_LINK_FITNESS          plink_...   (ID of your Fitness payment link)
//   STRIPE_LINK_TRANSFORMATION   plink_...   (ID of your Transformation payment link)
//   SUPABASE_URL                 https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY          sb_secret_... (or legacy service_role key). NEVER put this in the app.
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  (already set for the application form)

import crypto from 'node:crypto';

const env = (k) => (process.env[k] || '').trim();

// ---------- Stripe signature check (no extra packages needed) ----------
function verifyStripe(raw, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; })
  );
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// ---------- Supabase admin helpers ----------
function sbHeaders(extra = {}) {
  const key = env('SUPABASE_SECRET_KEY');
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`; // legacy service_role JWT
  return h;
}
async function sb(path, opts = {}) {
  const res = await fetch(`${env('SUPABASE_URL')}${path}`, { ...opts, headers: sbHeaders(opts.headers) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function findProfileByEmail(email) {
  const r = await sb(`/rest/v1/profiles?select=id,full_name&email=eq.${encodeURIComponent(email)}`);
  if (!r.ok) throw new Error(`profile lookup failed ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data[0] || null;
}

async function findOrCreateUser(email, name) {
  const existing = await findProfileByEmail(email);
  if (existing) return existing.id;

  const r = await sb('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: name || '' } }),
  });
  if (r.ok && r.data?.id) return r.data.id;

  // Already exists in auth but somehow no profile: find them in the user list.
  if (r.status === 422 || r.status === 409) {
    const list = await sb('/auth/v1/admin/users?page=1&per_page=1000');
    const u = (list.data?.users || []).find((x) => (x.email || '').toLowerCase() === email);
    if (u) return u.id;
  }
  throw new Error(`create user failed ${r.status}: ${JSON.stringify(r.data)}`);
}

async function upsertProfile(id, fields) {
  const r = await sb('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id, ...fields }),
  });
  if (!r.ok) throw new Error(`profile update failed ${r.status}: ${JSON.stringify(r.data)}`);
}

async function updateBySubscription(subId, fields) {
  const r = await sb(`/rest/v1/profiles?stripe_subscription_id=eq.${encodeURIComponent(subId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error(`subscription update failed ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data || [];
}

// ---------- Telegram ----------
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function telegram(text) {
  if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_CHAT_ID')) return;
  try {
    await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('telegram failed', e); }
}

// ---------- Event handling ----------
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due']; // past_due = grace period while Stripe retries the card
const tierLabel = (t) => (t === 'transformation' ? 'Transformation' : 'Fitness');

function tierFromLink(linkId) {
  if (linkId && linkId === env('STRIPE_LINK_TRANSFORMATION')) return 'transformation';
  if (linkId && linkId === env('STRIPE_LINK_FITNESS')) return 'fitness';
  return null;
}

async function onCheckoutCompleted(s) {
  if (s.mode !== 'subscription') return; // only monthly coaching unlocks the app
  const email = (s.customer_details?.email || s.customer_email || '').toLowerCase().trim();
  const name = (s.customer_details?.name || '').trim();
  if (!email) throw new Error('checkout session has no email');

  const matched = tierFromLink(s.payment_link);
  const tier = matched || 'fitness';
  const id = await findOrCreateUser(email, name);
  const existing = await findProfileByEmail(email);

  await upsertProfile(id, {
    email,
    full_name: existing?.full_name || name || null,
    tier,
    active: true,
    subscription_status: 'active',
    stripe_customer_id: typeof s.customer === 'string' ? s.customer : s.customer?.id || null,
    stripe_subscription_id: typeof s.subscription === 'string' ? s.subscription : s.subscription?.id || null,
  });

  const amount = s.amount_total != null ? `$${(s.amount_total / 100).toFixed(2)}/mo` : '';
  await telegram([
    '💰 <b>NEW CLIENT PAID</b>',
    '',
    `👤 ${esc(name || '—')}`,
    `📧 ${esc(email)}`,
    `🏷 ${tierLabel(tier)} ${esc(amount)}`,
    matched ? '✅ App access is ON' : '⚠️ Payment link not recognized, so the tier was set to Fitness. Check it in Supabase.',
  ].join('\n'));
}

async function onSubscriptionChanged(sub, deleted = false) {
  const status = deleted ? 'canceled' : sub.status;
  const active = !deleted && ACTIVE_STATUSES.includes(status);
  const rows = await updateBySubscription(sub.id, { active, subscription_status: status });
  const who = rows[0] ? `${esc(rows[0].full_name || rows[0].email)}` : `subscription ${esc(sub.id)}`;

  if (!active) {
    await telegram(`🚪 <b>Access turned OFF</b>\n${who}\nStatus: ${esc(status)}`);
  } else if (status === 'past_due') {
    await telegram(`⚠️ <b>Payment past due</b>\n${who}\nStripe is retrying their card. Access stays on for now.`);
  } else if (sub.cancel_at_period_end) {
    const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
    const when = end ? new Date(end * 1000).toLocaleDateString('en-US') : 'the end of the period';
    await telegram(`📅 <b>Client canceled</b>\n${who}\nAccess ends ${esc(when)}.`);
  }
}

async function onPaymentFailed(inv) {
  const email = inv.customer_email || '';
  await telegram(`❌ <b>Payment failed</b>\n${esc(inv.customer_name || '')} ${esc(email)}\nStripe will retry automatically.`);
}

// ---------- Entry point ----------
export async function POST(request) {
  const raw = await request.text();
  if (!verifyStripe(raw, request.headers.get('stripe-signature'), env('STRIPE_WEBHOOK_SECRET'))) {
    return new Response('Bad signature', { status: 400 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }

  try {
    const obj = event.data?.object || {};
    switch (event.type) {
      case 'checkout.session.completed': await onCheckoutCompleted(obj); break;
      case 'customer.subscription.updated': await onSubscriptionChanged(obj); break;
      case 'customer.subscription.deleted': await onSubscriptionChanged(obj, true); break;
      case 'invoice.payment_failed': await onPaymentFailed(obj); break;
      default: break; // ignore everything else
    }
    return Response.json({ received: true });
  } catch (err) {
    console.error(event.type, err);
    // 500 makes Stripe retry later, so a temporary hiccup doesn't lose a client.
    return new Response('Handler error', { status: 500 });
  }
}

export function GET() {
  return new Response('Stripe webhook endpoint is live. Stripe sends POST requests here.', { status: 200 });
}
