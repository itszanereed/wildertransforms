// Shared helpers for the server functions (Supabase admin, login check, Telegram, Claude).
// Files starting with _ are private helpers, not web pages.

export const env = (k) => (process.env[k] || '').trim();
export const SB_URL = () => (env('SUPABASE_URL') || 'https://mfvyflsbxrlntefyijsa.supabase.co').replace(/\/+$/, '');
export const MODEL = () => env('ANTHROPIC_MODEL') || 'claude-sonnet-5-5';
export const json = (obj, status = 200) => Response.json(obj, { status });
export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sbHeaders(extra = {}) {
  const key = env('SUPABASE_SECRET_KEY');
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}
export async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL()}${path}`, { ...opts, headers: sbHeaders(opts.headers) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Who is calling? Returns { profile } or { err } in plain English.
export async function caller(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { err: 'No login token was sent. Sign out of the app and back in.' };
  const key = env('SUPABASE_SECRET_KEY');
  if (key.startsWith('sb_publishable_')) return { err: 'SUPABASE_SECRET_KEY in Vercel is the publishable key. Use the sb_secret_ key.' };
  let res;
  try { res = await fetch(`${SB_URL()}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } }); }
  catch { return { err: 'Could not reach Supabase. Check SUPABASE_URL in Vercel.' }; }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 160);
    if (/api key|apikey|Invalid API/i.test(detail)) return { err: `Supabase rejected the server key. Re-copy SUPABASE_SECRET_KEY into Vercel and redeploy. (${res.status})` };
    return { err: `Your login expired or wasn't accepted (${res.status}). Sign out of the app and back in.` };
  }
  const user = await res.json();
  try {
    const [profile] = await sb(`/rest/v1/profiles?select=id,full_name,email,tier,active,is_coach&id=eq.${user.id}`);
    return profile ? { profile } : { err: 'No profile found for your account.' };
  } catch (e) { return { err: `Profile lookup failed: ${String(e.message).slice(0, 160)}` }; }
}

export async function telegram(text) {
  if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_CHAT_ID')) return;
  try {
    await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('telegram', e); }
}

// ---------- Claude: structured JSON with two fallbacks ----------
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
function parseJson(text, isValid) {
  if (!text) return null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { const p = JSON.parse(text.slice(a, b + 1)); return isValid(p) ? p : null; } catch { return null; }
}
export function strictSchema(node) {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === 'description' ? v : strictSchema(v);
  if (out.type === 'object' && out.properties) { out.additionalProperties = false; out.required = Object.keys(out.properties); }
  return out;
}

// tool = { name, description, input_schema }, isValid = (obj) => boolean
export async function askClaudeForJson({ system, user, tool, isValid, maxTokens = 8000 }) {
  const base = { model: MODEL(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  let r = await callClaude({ ...base, output_config: { format: { type: 'json_schema', schema: strictSchema(tool.input_schema) } } });
  if (r.ok) { const p = parseJson(textOf(r.data), isValid); if (p) return p; }
  if (!r.ok && r.status !== 400) throw new Error(r.error);
  r = await callClaude({ ...base, tools: [tool], tool_choice: { type: 'auto' } });
  if (!r.ok) throw new Error(r.error);
  const block = (r.data.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  if (block && isValid(block.input)) return block.input;
  const p = parseJson(textOf(r.data), isValid);
  if (p) return p;
  throw new Error('Claude did not return a usable answer');
}
