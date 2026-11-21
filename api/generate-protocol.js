// Drafts a supplement protocol from a client's supplement questionnaire, using Zane's rules + product links.
// Saved as a DRAFT. Nothing reaches the client until the coach publishes it.
// Vercel env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY (+ Telegram ones, optional)

import { env, sb, caller, telegram, askClaudeForJson, json, esc } from './_shared.js';
import { SUPPLEMENT_RULES, PRODUCTS } from './_supplement-rules.js';

const TIMINGS = ['Morning', 'With breakfast', 'Pre-workout', 'Post-workout', 'With dinner', 'Before bed', 'Any time'];

const PROTOCOL_TOOL = {
  name: 'save_protocol',
  description: 'Save the drafted supplement protocol for coach review.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2–3 sentences to the client: what this stack does for them.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Product name from the list, e.g. "Creatine Monohydrate"' },
            dose: { type: 'string', description: 'e.g. "5 g daily"' },
            timing: { type: 'string', enum: TIMINGS },
            purpose: { type: 'string' },
            est_monthly_cost: { type: 'number' },
            link: { type: 'string', description: 'Exact link from the product list, or "".' },
          },
          required: ['name', 'dose', 'timing', 'purpose', 'est_monthly_cost', 'link'],
        },
      },
      total_est_monthly_cost: { type: 'number' },
      coach_notes: { type: 'string', description: 'PRIVATE notes for Zane: medication/condition interactions to confirm, assumptions made.' },
    },
    required: ['summary', 'items', 'total_est_monthly_cost', 'coach_notes'],
  },
};

const isNone = (v) => !v || /^(none|no|n\/a|na|nothing|-)\.?$/i.test(String(v).trim());

export async function POST(request) {
  if (!env('ANTHROPIC_API_KEY') || !env('SUPABASE_SECRET_KEY')) return json({ error: 'Server not configured' }, 500);
  const who = await caller(request).catch((e) => ({ err: String(e.message || e) }));
  if (!who.profile) return json({ error: who.err || 'Not logged in' }, 401);
  const me = who.profile;

  let body = {};
  try { body = await request.json(); } catch { /* no body */ }
  const targetId = me.is_coach && body.user_id ? body.user_id : me.id;

  if (!me.is_coach) {
    if (!me.active) return json({ error: 'Inactive' }, 403);
    const existing = await sb(`/rest/v1/protocols?select=id&user_id=eq.${targetId}&status=in.(generating,draft,published)&limit=1`);
    if (existing.length) return json({ ok: true, skipped: 'already has a protocol' });
  }

  const [client] = await sb(`/rest/v1/profiles?select=id,full_name,email&id=eq.${targetId}`);
  if (!client) return json({ error: 'Client not found' }, 404);
  const [intake] = await sb(`/rest/v1/supp_intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  if (!intake) return json({ error: "Client hasn't filled out the supplement questions yet" }, 400);
  const [training] = await sb(`/rest/v1/intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  const a = intake.answers || {};
  const name = client.full_name || client.email;

  // Hard stops: these need a doctor, not an auto-draft.
  const age = Number(a.age || training?.answers?.age);
  if (age && age < 18) {
    await telegram(`⚠️ <b>${esc(name)}</b> is under 18. No supplement protocol was drafted. Review manually.`);
    return json({ error: 'Client is under 18. Protocol not drafted automatically.' }, 400);
  }
  if (a.pregnant === 'Yes') {
    await telegram(`⚠️ <b>${esc(name)}</b> is pregnant or breastfeeding. No supplement protocol was drafted. They should get supplement guidance from their doctor.`);
    return json({ error: 'Client is pregnant or breastfeeding. Supplement guidance should come from their doctor.' }, 400);
  }

  const [draftRow] = await sb(`/rest/v1/protocols?select=id,data&user_id=eq.${targetId}&status=in.(generating,draft,failed)&order=created_at.desc&limit=1`);
  const previous = body.instructions && draftRow?.data ? draftRow.data : null;
  let rowId = draftRow?.id;
  if (rowId) await sb(`/rest/v1/protocols?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'generating', error: null, updated_at: new Date().toISOString() }) });
  else rowId = (await sb('/rest/v1/protocols', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: targetId, status: 'generating' }) }))[0].id;

  const system = `You are the supplement assistant for Zane, an online fitness coach (Wilder Transforms).
You draft supplement protocols that Zane reviews and edits before the client sees them. You are not a doctor and must not give medical advice.
Follow Zane's rules exactly:
${SUPPLEMENT_RULES}
PRODUCT LIST (only use these names and links; costs are estimates):
${JSON.stringify(PRODUCTS, null, 2)}
Return the protocol as JSON in the required format. No other text.`;

  let user = `Client: ${name}\n\nSupplement questionnaire:\n${JSON.stringify(a, null, 2)}`;
  if (training?.answers) user += `\n\nTraining questionnaire (for context):\n${JSON.stringify(training.answers, null, 2)}`;
  if (!isNone(a.medications) || !isNone(a.conditions)) user += `\n\nNOTE: This client listed medications or medical conditions. Be conservative and spell out what Zane must confirm in coach_notes.`;
  if (previous) user += `\n\nZane's current draft (revise this, keep what he didn't ask to change):\n${JSON.stringify(previous, null, 2)}`;
  if (body.instructions) user += `\n\nZane's instructions for this version (these take priority):\n${String(body.instructions).slice(0, 2000)}`;

  try {
    const p = await askClaudeForJson({
      system, user, tool: PROTOCOL_TOOL, maxTokens: 6000,
      isValid: (o) => Array.isArray(o?.items) && o.items.length > 0,
    });
    // Only allow links that are actually in Zane's product list.
    const allowed = new Set(PRODUCTS.map((x) => x.link).filter(Boolean));
    const items = p.items.map((it) => ({ ...it, link: allowed.has(it.link) ? it.link : '', timing: TIMINGS.includes(it.timing) ? it.timing : 'Any time' }));
    const data = { summary: p.summary, items, total_est_monthly_cost: items.reduce((s, it) => s + (Number(it.est_monthly_cost) || 0), 0) };
    await sb(`/rest/v1/protocols?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft', data, ai_notes: p.coach_notes || null, updated_at: new Date().toISOString() }) });
    if (!me.is_coach) await telegram(`💊 <b>Supplement protocol ready</b>\n${esc(name)} finished the supplement questions.\nReview and publish it in the Coach tab.`);
    return json({ ok: true, protocol_id: rowId });
  } catch (err) {
    console.error(err);
    await sb(`/rest/v1/protocols?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(err.message).slice(0, 500), updated_at: new Date().toISOString() }) }).catch(() => {});
    return json({ error: 'Generating failed. Try again.' }, 502);
  }
}
