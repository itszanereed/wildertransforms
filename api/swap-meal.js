// Coach-only: replace ONE meal in a client's meal plan with something completely different,
// based on the coach's notes about why the client doesn't like it. Also returns the updated shopping list.
// POST { user_id, plan, ti, mi, notes } → { meal, shopping_list }

import { sb, caller, askClaudeForJson, json, env } from './_shared.js';
import { NUTRITION_RULES } from './_nutrition-rules.js';
import { addPhotosToPlan } from './_photos.js';

const SECTIONS = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Grains & Bread', 'Pantry', 'Frozen', 'Other'];
const num = { type: 'number' };
const SWAP_TOOL = {
  name: 'save_swap',
  description: 'Save the replacement meal and the updated weekly shopping list.',
  input_schema: {
    type: 'object',
    properties: {
      meal: {
        type: 'object',
        properties: {
          slot: { type: 'string' }, title: { type: 'string' },
          photo_query: { type: 'string', description: '2–4 word stock-photo search for the dish' },
          ingredients: { type: 'array', items: { type: 'string' } }, instructions: { type: 'string' },
          calories: num, protein_g: num, carbs_g: num, fat_g: num,
        },
        required: ['slot', 'title', 'photo_query', 'ingredients', 'instructions', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
      },
      shopping_list: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: SECTIONS },
            items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'string' } }, required: ['name', 'qty'] } },
          },
          required: ['section', 'items'],
        },
      },
    },
    required: ['meal', 'shopping_list'],
  },
};

export async function POST(request) {
  if (!env('ANTHROPIC_API_KEY')) return json({ error: 'Server not configured' }, 500);
  const who = await caller(request).catch(() => ({}));
  if (!who.profile?.is_coach) return json({ error: 'Coach only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const { user_id, plan, notes } = body, ti = Number(body.ti), mi = Number(body.mi);
  const tpl = plan?.day_templates?.[ti], old = tpl?.meals?.[mi];
  if (!user_id || !old) return json({ error: 'Meal not found' }, 400);
  if (!String(notes || '').trim()) return json({ error: 'Add a note about why they don\'t like it' }, 400);

  const [nut] = await sb(`/rest/v1/nutrition_intakes?select=answers&user_id=eq.${user_id}&order=created_at.desc&limit=1`).catch(() => []);
  const daysUsed = (plan.week || []).filter((w) => w.template_id === tpl.id).length || 1;
  const otherTitles = plan.day_templates.flatMap((t) => (t.meals || []).map((m) => m.title)).filter((t) => t !== old.title);
  const gentle = !!plan.gentle;

  const system = `You are the nutrition assistant for Zane, an online fitness coach. You swap a single meal a client doesn't like.
Follow Zane's rules:
${NUTRITION_RULES}
Return JSON in the required format. No other text.`;

  const user = `Replace this meal with something COMPLETELY DIFFERENT (different main protein or style, not a variation of the same dish).

Meal to replace (${old.slot}, appears ${daysUsed} day(s) per week via "${tpl.name}"):
${JSON.stringify({ title: old.title, ingredients: old.ingredients, calories: old.calories, protein_g: old.protein_g, carbs_g: old.carbs_g, fat_g: old.fat_g })}

Why the client doesn't like it (Zane's notes, top priority): ${String(notes).slice(0, 600)}
${(plan.dislikes || []).length ? `Other things this client dislikes (never use): ${plan.dislikes.join('; ')}` : ''}
Don't repeat or closely copy any other meal already in the plan: ${otherTitles.join(', ') || 'none'}
Client questionnaire (diet, allergies, cooking time, budget): ${JSON.stringify(nut?.answers || {})}

${gentle
  ? 'GENTLE PLAN: set calories/protein_g/carbs_g/fat_g to 0 and use portion guides (palm, fist, handful) instead of exact amounts.'
  : `Keep it within about 10% of the old meal's calories and protein so the day still hits its targets.`}
Keep the same slot ("${old.slot}").

Then return the FULL updated weekly shopping list: start from the current list below, remove or reduce what only the old meal needed
(it was eaten ${daysUsed} time(s) per week), and add what the new meal needs for ${daysUsed} time(s) per week. Keep everything else the same.
Current shopping list:
${JSON.stringify(plan.shopping_list || [])}`;

  try {
    const out = await askClaudeForJson({
      system, user, tool: SWAP_TOOL, maxTokens: 5000,
      isValid: (o) => o?.meal?.title && Array.isArray(o?.meal?.ingredients) && Array.isArray(o?.shopping_list),
    });
    const meal = { ...out.meal, slot: out.meal.slot || old.slot };
    if (gentle) Object.assign(meal, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
    await addPhotosToPlan({ day_templates: [{ meals: [meal] }] }).catch(() => {});
    const shopping_list = out.shopping_list
      .map((s) => ({ section: SECTIONS.includes(s.section) ? s.section : 'Other', items: (s.items || []).filter((i) => i?.name) }))
      .filter((s) => s.items.length)
      .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
    return json({ meal, shopping_list });
  } catch (err) {
    console.error(err);
    return json({ error: `Swap failed: ${String(err.message || err).slice(0, 220)}` }, 502);
  }
}
