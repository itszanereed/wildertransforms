// Vercel serverless function: receives the application form and sends it to Telegram.
// Set these in Vercel → Project → Settings → Environment Variables:
//   TELEGRAM_BOT_TOKEN  (from @BotFather)
//   TELEGRAM_CHAT_ID    (your personal chat ID)

const esc = (v) =>
  String(v ?? '')
    .slice(0, 1500)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  // Honeypot: real people never fill this in. Pretend success so bots move on.
  if (body.company) return res.status(200).json({ ok: true });

  const { name, age, email, ig, goal, why, commit } = body;
  if (!name || !email || !goal || !why) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const text = [
    '🔥 <b>NEW APPLICATION — Wilder Transforms</b>',
    '',
    `👤 <b>Name:</b> ${esc(name)}`,
    `🎂 <b>Age:</b> ${esc(age)}`,
    `📧 <b>Email:</b> ${esc(email)}`,
    `📱 <b>Socials:</b> ${esc(ig) || '—'}`,
    `🎯 <b>Goal:</b> ${esc(goal)}`,
    `💪 <b>Commitment:</b> ${esc(commit)}/10`,
    '',
    '🧱 <b>What\'s holding him back:</b>',
    esc(why),
  ].join('\n');

  try {
    const tg = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
        }),
      }
    );
    if (!tg.ok) {
      console.error('Telegram error:', await tg.text());
      return res.status(502).json({ ok: false, error: 'Notification failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
