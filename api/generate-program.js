// Drafts a training program with Claude from a client's questionnaire.
// The draft is saved as status "draft" and is NEVER shown to the client until the coach publishes it.
//
// Called by:
//   - the client app, right after the questionnaire is submitted (drafts their first program)
//   - the coach tab: "Generate" / "Regenerate with notes"
//
// Vercel env vars needed: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY
// Optional: ANTHROPIC_MODEL (defaults below), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { COACHING_RULES } from './_coaching-rules.js';

const env = (k) => (process.env[k] || '').trim();
const MODEL = () => env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5';
const SB_URL = () => (env('SUPABASE_URL') || 'https://mfvyflsbxrlntefyijsa.supabase.co').replace(/\/+$/, '');

// ---------- Supabase (admin) ----------
function sbHeaders(extra = {}) {
  const key = env('SUPABASE_SECRET_KEY');
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}
async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL()}${path}`, { ...opts, headers: sbHeaders(opts.headers) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Who is calling? Returns { profile } or { err } with a plain-English reason.
async function caller(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { err: 'No login token was sent. Sign out of the app and back in.' };
  const key = env('SUPABASE_SECRET_KEY');
  if (key.startsWith('sb_publishable_')) return { err: 'SUPABASE_SECRET_KEY in Vercel is the publishable key. Use the sb_secret_ key.' };

  let res;
  try {
    res = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { err: 'Could not reach Supabase. Check SUPABASE_URL in Vercel.' };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 160);
    if (/api key|apikey|Invalid API/i.test(detail)) return { err: `Supabase rejected the server key. Re-copy SUPABASE_SECRET_KEY into Vercel and redeploy. (${res.status})` };
    return { err: `Your login expired or wasn't accepted (${res.status}). Sign out of the app and back in. ${detail}` };
  }
  const user = await res.json();
  try {
    const [profile] = await sb(`/rest/v1/profiles?select=id,full_name,email,tier,active,is_coach&id=eq.${user.id}`);
    if (!profile) return { err: 'No profile found for your account.' };
    return { profile };
  } catch (e) {
    return { err: `Profile lookup failed: ${String(e.message).slice(0, 160)}` };
  }
}

// ---------- Telegram ----------
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function telegram(text) {
  if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_CHAT_ID')) return;
  try {
    await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('telegram', e); }
}

// ---------- The program format Claude must return ----------
const PROGRAM_TOOL = {
  name: 'save_program',
  description: 'Save the drafted training program for coach review.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short program name, e.g. "Upper/Lower Hypertrophy, Phase 1"' },
      overview: { type: 'string', description: '2–4 sentences written to the client: what this program is and why it fits them.' },
      duration_weeks: { type: 'integer' },
      progression: { type: 'string', description: 'How to progress week to week, including the deload.' },
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'e.g. "Day 1: Upper"' },
            focus: { type: 'string' },
            warmup: { type: 'string' },
            exercises: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  sets: { type: 'integer' },
                  reps: { type: 'string', description: 'e.g. "8-10"' },
                  rest: { type: 'string', description: 'e.g. "2 min"' },
                  rir: { type: 'string', description: 'Reps in reserve, e.g. "2"' },
                  notes: { type: 'string', description: 'Form cue or why this exercise / swap' },
                },
                required: ['name', 'sets', 'reps', 'rest', 'rir'],
              },
            },
          },
          required: ['name', 'focus', 'exercises'],
        },
      },
      cardio: { type: 'string', description: 'Steps and cardio guidance.' },
      coach_notes: { type: 'string', description: 'PRIVATE notes for Zane only: assumptions you made, injuries or answers he should double-check with the client.' },
    },
    required: ['title', 'overview', 'duration_weeks', 'progression', 'days', 'cardio', 'coach_notes'],
  },
};

async function draftWithClaude({ name, answers, instructions, previous }) {
  const system = `You are the programming assistant for Zane, an online fitness coach (Wilder Transforms).
You draft personalized training programs that Zane reviews and edits before his client ever sees them.
Follow Zane's coaching rules exactly:
${COACHING_RULES}
Return the program as JSON matching the required format (or by calling the save_program tool if it is offered). No other text.`;

  let user = `Draft a program for this client.\n\nClient name: ${name || 'Client'}\n\nQuestionnaire answers:\n${JSON.stringify(answers, null, 2)}`;
  if (previous) user += `\n\nZane's current draft (revise this, keep what he didn't ask to change):\n${JSON.stringify(previous, null, 2)}`;
  if (instructions) user += `\n\nZane's instructions for this version (these take priority):\n${instructions}`;

  const base = { model: MODEL(), max_tokens: 12000, system, messages: [{ role: 'user', content: user }] };

  // 1) Structured output: Claude must return JSON matching the program schema.
  let r = await callClaude({ ...base, output_config: { format: { type: 'json_schema', schema: strictSchema(PROGRAM_TOOL.input_schema) } } });
  if (r.ok) { const p = parseProgram(textOf(r.data)); if (p) return p; }

  // 2) Backup: offer the save_program tool (no forcing) and ask Claude to use it.
  if (!r.ok && r.status !== 400) throw new Error(r.error);
  r = await callClaude({ ...base, tools: [PROGRAM_TOOL], tool_choice: { type: 'auto' } });
  if (!r.ok) throw new Error(r.error);
  const block = (r.data.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_program');
  if (block?.input?.days?.length) return block.input;

  // 3) Last resort: pull JSON out of a plain text answer.
  const p = parseProgram(textOf(r.data));
  if (p) return p;
  throw new Error('Claude did not return a program');
}

async function callClaude(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data } : { ok: false, status: res.status, error: `Claude ${res.status}: ${data?.error?.message || JSON.stringify(data)}` };
}
const textOf = (data) => (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
function parseProgram(text) {
  if (!text) return null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { const p = JSON.parse(text.slice(a, b + 1)); return p?.days?.length ? p : null; } catch { return null; }
}
// Structured outputs want every object closed (additionalProperties:false) with all fields required.
function strictSchema(node) {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = (k === 'description') ? v : strictSchema(v);
  if (out.type === 'object' && out.properties) { out.additionalProperties = false; out.required = Object.keys(out.properties); }
  return out;
}

const json = (obj, status = 200) => Response.json(obj, { status });

export async function POST(request) {
  if (!env('ANTHROPIC_API_KEY') || !env('SUPABASE_SECRET_KEY')) return json({ error: 'Server not configured' }, 500);

  const who = await caller(request).catch((e) => ({ err: String(e.message || e) }));
  if (!who.profile) return json({ error: who.err || 'Not logged in' }, 401);
  const me = who.profile;

  let body = {};
  try { body = await request.json(); } catch { /* client calls may send no body */ }

  // Coach can draft for anyone; a client (or the coach testing on himself) can only trigger their own draft,
  // and only if they don't have one yet, or the last attempt failed / got stuck.
  const coachRun = me.is_coach && !!body.user_id;
  const targetId = coachRun ? body.user_id : me.id;
  let firstSubmit = false;
  if (!coachRun) {
    if (!me.active) return json({ error: 'Inactive' }, 403);
    const rows = await sb(`/rest/v1/programs?select=id,status,updated_at&user_id=eq.${targetId}&status=neq.archived&order=created_at.desc&limit=1`);
    const last = rows[0];
    const stale = last && Date.now() - new Date(last.updated_at).getTime() > 5 * 60 * 1000;
    if (last && (last.status === 'draft' || last.status === 'published')) return json({ ok: true, skipped: 'already has a program' });
    if (last && last.status === 'generating' && !stale) return json({ ok: true, skipped: 'already drafting' });
    if (last && last.status === 'failed' && !stale) return json({ ok: true, skipped: 'failed recently' });
    firstSubmit = !last;
  }

  const [client] = await sb(`/rest/v1/profiles?select=id,full_name,email&id=eq.${targetId}`);
  if (!client) return json({ error: 'Client not found' }, 404);
  const [intake] = await sb(`/rest/v1/intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  if (!intake) return json({ error: 'Client has not filled out the questionnaire yet' }, 400);

  const age = Number(intake.answers?.age);
  if (age && age < 18) {
    await telegram(`⚠️ <b>${esc(client.full_name || client.email)}</b> entered an age under 18. No AI draft was made. Review manually.`);
    return json({ error: 'Client is under 18. Program not drafted automatically.' }, 400);
  }

  if (firstSubmit) {
    await telegram(`📋 <b>${esc(client.full_name || client.email)}</b> submitted their training questionnaire.\nDrafting their program now. You'll get another ping when it's ready to review.`);
  }

  // Reuse their current draft row if there is one, otherwise start a new one.
  const [draftRow] = await sb(`/rest/v1/programs?select=id,data&user_id=eq.${targetId}&status=in.(generating,draft,failed)&order=created_at.desc&limit=1`);
  const previous = body.instructions && draftRow?.data ? draftRow.data : null;
  let rowId = draftRow?.id;
  if (rowId) {
    await sb(`/rest/v1/programs?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'generating', error: null, updated_at: new Date().toISOString() }) });
  } else {
    const [row] = await sb('/rest/v1/programs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: targetId, status: 'generating' }) });
    rowId = row.id;
  }

  try {
    const program = await draftWithClaude({
      name: client.full_name,
      answers: intake.answers,
      instructions: (body.instructions || '').slice(0, 2000),
      previous,
    });
    const { coach_notes, ...clientFacing } = program;
    await sb(`/rest/v1/programs?id=eq.${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'draft', title: program.title, data: clientFacing, ai_notes: coach_notes || null, updated_at: new Date().toISOString() }),
    });
    if (!coachRun) {
      await telegram(`📝 <b>Program draft ready</b>\n${esc(client.full_name || client.email)} finished their questionnaire.\nReview and publish it in the app's Coach tab.`);
    }
    return json({ ok: true, program_id: rowId });
  } catch (err) {
    console.error(err);
    await sb(`/rest/v1/programs?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(err.message).slice(0, 500), updated_at: new Date().toISOString() }) }).catch(() => {});
    if (!coachRun) await telegram(`❌ <b>Program draft failed</b> for ${esc(client.full_name || client.email)}\n${esc(String(err.message).slice(0, 200))}\nOpen the Coach tab and tap Generate to retry.`);
    return json({ error: 'Draft failed. Try Generate again.' }, 502);
  }
}
