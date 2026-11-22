// Drafts a weekly meal plan + shopping list. Calories/macros are CALCULATED here (not by the AI),
// then the AI builds meals that hit them. Saved as DRAFT until the coach publishes.
// Vercel env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY (+ Telegram, optional)

import { env, sb, caller, telegram, askClaudeForJson, json, esc } from './_shared.js';
import { TARGETS, NUTRITION_RULES } from './_nutrition-rules.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SECTIONS = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Grains & Bread', 'Pantry', 'Frozen', 'Other'];

// ---------- Math ----------
export function parseHeightIn(h) {
  const s = String(h || '').toLowerCase().trim();
  if (!s) return null;
  const cm = s.match(/(\d{3}(?:\.\d+)?)\s*cm/);
  if (cm) return Number(cm[1]) / 2.54;
  const ftin = s.match(/(\d)\s*(?:'|’|ft|feet|foot)\s*(\d{1,2}(?:\.\d+)?)?/);
  if (ftin) return Number(ftin[1]) * 12 + Number(ftin[2] || 0);
  const n = parseFloat(s);
  if (!n) return null;
  if (n > 100) return n / 2.54;        // assume cm
  if (n >= 48 && n <= 90) return n;    // assume inches
  if (n >= 4 && n < 8) return n * 12;  // "5.9" style feet
  return null;
}
export function parseWeightLb(w) {
  const s = String(w || '').toLowerCase();
  const n = parseFloat(s);
  if (!n) return null;
  return /kg/.test(s) ? n * 2.20462 : n;
}
const round = (n, to) => Math.round(n / to) * to;

export function calcTargets({ sex, age, height, weight, goal, activity, days }) {
  const inches = parseHeightIn(height), lb = parseWeightLb(weight), yrs = Number(age);
  if (!inches || !lb || !yrs) return null;
  const kg = lb / 2.20462, cm = inches * 2.54;
  const sexAdj = sex === 'Male' ? 5 : sex === 'Female' ? -161 : -78;
  const bmr = 10 * kg + 6.25 * cm - 5 * yrs + sexAdj;
  const base = /very active/i.test(activity || '') ? 1.55 : /on my feet/i.test(activity || '') ? 1.375 : 1.2;
  const factor = Math.min(1.9, base + (Number(days) || 3) * 0.04);
  const maintenance = bmr * factor;
  const bmi = kg / ((cm / 100) ** 2);

  let mult = TARGETS.goalMultiplier[goal] ?? 1;
  const notes = [];
  if (bmi < 18.5 && mult < 1) { mult = 1; notes.push(`BMI is about ${bmi.toFixed(1)} (underweight range), so calories were set to maintenance instead of a deficit. Confirm the goal with the client.`); }
  const floor = TARGETS.calorieFloor[sex] ?? TARGETS.calorieFloor.other;
  let calories = Math.max(floor, maintenance * mult);
  if (calories === floor && maintenance * mult < floor) notes.push(`Calculated calories were below the ${floor} kcal minimum, so the floor was used.`);
  calories = round(calories, 25);

  const refLb = Math.min(lb, 27 * ((cm / 100) ** 2) * 2.20462); // cap protein for higher bodyweights (BMI 27 reference)
  const protein_g = round(refLb * TARGETS.proteinPerLb, 5);
  const fat_g = round(Math.max(calories * TARGETS.fatPercent / 9, lb * TARGETS.minFatPerLb), 5);
  const carbs_g = round(Math.max(TARGETS.minCarbs, (calories - protein_g * 4 - fat_g * 9) / 4), 5);
  return { calories, protein_g, carbs_g, fat_g, maintenance: round(maintenance, 25), bmi: Number(bmi.toFixed(1)), notes };
}

// ---------- Format the AI must return ----------
const num = { type: 'number' };
const MEALPLAN_TOOL = {
  name: 'save_meal_plan',
  description: 'Save the drafted weekly meal plan for coach review.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2–3 sentences to the client about this plan.' },
      day_templates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id like "A", "B", "R"' },
            name: { type: 'string', description: 'e.g. "Training Day A"' },
            meals: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slot: { type: 'string', description: 'e.g. "Breakfast", "Lunch", "Snack", "Dinner"' },
                  title: { type: 'string' },
                  ingredients: { type: 'array', items: { type: 'string' }, description: 'Each with amount, e.g. "6 oz chicken breast"' },
                  instructions: { type: 'string' },
                  calories: num, protein_g: num, carbs_g: num, fat_g: num,
                },
                required: ['slot', 'title', 'ingredients', 'instructions', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
              },
            },
          },
          required: ['id', 'name', 'meals'],
        },
      },
      week: {
        type: 'array',
        description: 'Exactly 7 entries, Monday to Sunday.',
        items: { type: 'object', properties: { day: { type: 'string', enum: DAYS }, template_id: { type: 'string' } }, required: ['day', 'template_id'] },
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
      prep_tips: { type: 'array', items: { type: 'string' } },
      coach_notes: { type: 'string', description: 'PRIVATE notes for Zane only.' },
    },
    required: ['summary', 'day_templates', 'week', 'shopping_list', 'prep_tips', 'coach_notes'],
  },
};

const sum = (meals, k) => Math.round(meals.reduce((s, m) => s + (Number(m[k]) || 0), 0));

export async function POST(request) {
  if (!env('ANTHROPIC_API_KEY') || !env('SUPABASE_SECRET_KEY')) return json({ error: 'Server not configured' }, 500);
  const who = await caller(request).catch((e) => ({ err: String(e.message || e) }));
  if (!who.profile) return json({ error: who.err || 'Not logged in' }, 401);
  const me = who.profile;
  let body = {};
  try { body = await request.json(); } catch { /* none */ }

  const coachRun = me.is_coach && !!body.user_id;
  const targetId = coachRun ? body.user_id : me.id;
  let firstSubmit = false;
  if (!coachRun) {
    if (!me.active) return json({ error: 'Inactive' }, 403);
    const rows = await sb(`/rest/v1/meal_plans?select=id,status,updated_at&user_id=eq.${targetId}&status=neq.archived&order=created_at.desc&limit=1`);
    const last = rows[0];
    const stale = last && Date.now() - new Date(last.updated_at).getTime() > 6 * 60 * 1000;
    if (last && ['draft', 'published', 'flagged'].includes(last.status)) return json({ ok: true, skipped: 'already has a plan' });
    if (last && last.status === 'generating' && !stale) return json({ ok: true, skipped: 'already drafting' });
    if (last && last.status === 'failed' && !stale) return json({ ok: true, skipped: 'failed recently' });
    firstSubmit = !last;
  }

  const [client] = await sb(`/rest/v1/profiles?select=id,full_name,email&id=eq.${targetId}`);
  if (!client) return json({ error: 'Client not found' }, 404);
  const name = client.full_name || client.email;
  const [nut] = await sb(`/rest/v1/nutrition_intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  if (!nut) return json({ error: "Client hasn't filled out the nutrition questions yet" }, 400);
  const [tr] = await sb(`/rest/v1/intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  const [sp] = await sb(`/rest/v1/supp_intakes?select=answers&user_id=eq.${targetId}&order=created_at.desc&limit=1`);
  const n = nut.answers || {}, t = tr?.answers || {}, s = sp?.answers || {};
  const p = {
    sex: n.sex || t.sex, age: n.age || t.age, height: n.height || t.height, weight: n.weight || t.weight,
    goal: t.goal || n.goal, activity: t.activity || n.activity, days: t.days,
  };

  // ---------- Hard stops ----------
  if (Number(p.age) && Number(p.age) < 18) {
    await telegram(`⚠️ <b>${esc(name)}</b> is under 18. No meal plan was drafted. Review manually.`);
    return json({ error: 'Client is under 18. Meal plan not drafted automatically.' }, 400);
  }
  if (n.pregnant === 'Yes' || s.pregnant === 'Yes') {
    await telegram(`⚠️ <b>${esc(name)}</b> is pregnant or breastfeeding. No meal plan was drafted. Their nutrition should be guided by their doctor.`);
    return json({ error: 'Client is pregnant or breastfeeding. Nutrition guidance should come from their doctor.' }, 400);
  }
  const edFlag = n.eating_history === 'Yes' || n.eating_history === 'Prefer not to say';
  if (edFlag && !coachRun) {
    const existing = await sb(`/rest/v1/meal_plans?select=id&user_id=eq.${targetId}&status=eq.flagged&limit=1`);
    if (!existing.length) {
      await sb('/rest/v1/meal_plans', { method: 'POST', body: JSON.stringify({ user_id: targetId, status: 'flagged', error: 'Client indicated a history of disordered eating (or preferred not to say).' }) });
      await telegram(`🤍 <b>${esc(name)}</b> answered "${esc(n.eating_history)}" to the eating-history question.\nNo calorie plan was made automatically. Reach out personally. Consider referring them to a registered dietitian. In the Coach tab you can create a gentle, numbers-free plan if appropriate.`);
    }
    return json({ ok: true, flagged: true });
  }

  const gentle = edFlag; // coach chose to create a plan anyway → no numbers, portion-based
  const targets = gentle ? null : calcTargets(p);
  if (!gentle && !targets) return json({ error: 'Missing or unreadable height, weight, or age. Check their answers.' }, 400);

  if (firstSubmit) await telegram(`📋 <b>${esc(name)}</b> submitted their nutrition questions.\nBuilding their meal plan now. You'll get another ping when it's ready to review.`);

  const [draftRow] = await sb(`/rest/v1/meal_plans?select=id,data&user_id=eq.${targetId}&status=in.(generating,draft,failed,flagged)&order=created_at.desc&limit=1`);
  const previous = body.instructions && draftRow?.data ? draftRow.data : null;
  let rowId = draftRow?.id;
  if (rowId) await sb(`/rest/v1/meal_plans?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'generating', error: null, updated_at: new Date().toISOString() }) });
  else rowId = (await sb('/rest/v1/meal_plans', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: targetId, status: 'generating' }) }))[0].id;

  const system = `You are the nutrition assistant for Zane, an online fitness coach (Wilder Transforms).
You draft weekly meal plans that Zane reviews and edits before the client sees them. You are not a doctor or dietitian and must not give medical advice.
Follow Zane's rules exactly:
${NUTRITION_RULES}
Return the plan as JSON in the required format. No other text.`;

  let user = `Client: ${name}\n\nBody & goal: ${JSON.stringify(p)}\n\nNutrition questionnaire:\n${JSON.stringify(n, null, 2)}`;
  if (s.allergies_diet) user += `\n\nAllergies/diet from supplement questions: ${s.allergies_diet}`;
  if (gentle) {
    user += `\n\nIMPORTANT: This client indicated a history of disordered eating. Build a GENTLE plan: regular balanced meals, no calorie counting, no weighing.
Set every calories/protein_g/carbs_g/fat_g field to 0. Use portion guides instead of exact amounts (e.g. "1 palm-sized portion of chicken", "1 fist of rice", "2 handfuls of vegetables").
Never mention weight loss, "clean" vs "bad" foods, or restriction. Keep the tone warm and supportive.`;
  } else {
    user += `\n\nDAILY TARGETS (calculated, hit these within about 5%): ${targets.calories} kcal, ${targets.protein_g} g protein, ${targets.carbs_g} g carbs, ${targets.fat_g} g fat.`;
  }
  if (previous) user += `\n\nZane's current draft (revise this, keep what he didn't ask to change):\n${JSON.stringify(previous)}`;
  if (body.instructions) user += `\n\nZane's instructions for this version (these take priority):\n${String(body.instructions).slice(0, 2000)}`;

  try {
    const plan = await askClaudeForJson({
      system, user, tool: MEALPLAN_TOOL, maxTokens: 14000,
      isValid: (o) => Array.isArray(o?.day_templates) && o.day_templates.length > 0 && Array.isArray(o.week),
    });
    const ids = plan.day_templates.map((d) => d.id);
    const byDay = Object.fromEntries((plan.week || []).map((w) => [w.day, w.template_id]));
    const week = DAYS.map((day, i) => ({ day, template_id: ids.includes(byDay[day]) ? byDay[day] : ids[i % ids.length] }));
    const day_templates = plan.day_templates.map((d) => ({
      ...d,
      totals: gentle ? null : { calories: sum(d.meals, 'calories'), protein_g: sum(d.meals, 'protein_g'), carbs_g: sum(d.meals, 'carbs_g'), fat_g: sum(d.meals, 'fat_g') },
    }));
    const shopping_list = (plan.shopping_list || [])
      .map((sec) => ({ section: SECTIONS.includes(sec.section) ? sec.section : 'Other', items: (sec.items || []).filter((it) => it?.name) }))
      .filter((sec) => sec.items.length)
      .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
    const data = {
      summary: plan.summary, gentle,
      targets: targets ? { calories: targets.calories, protein_g: targets.protein_g, carbs_g: targets.carbs_g, fat_g: targets.fat_g } : null,
      day_templates, week, shopping_list, prep_tips: plan.prep_tips || [],
    };
    const notes = [
      targets ? `Maintenance ≈ ${targets.maintenance} kcal · BMI ${targets.bmi}. ${targets.notes.join(' ')}` : 'Gentle plan: no numbers shown to the client.',
      plan.coach_notes || '',
    ].filter(Boolean).join('\n');
    await sb(`/rest/v1/meal_plans?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'draft', data, ai_notes: notes, updated_at: new Date().toISOString() }) });
    if (!coachRun) await telegram(`🥗 <b>Meal plan ready</b>\n${esc(name)}'s weekly plan and shopping list are drafted.\nReview and publish in the Coach tab.`);
    return json({ ok: true, plan_id: rowId });
  } catch (err) {
    console.error(err);
    await sb(`/rest/v1/meal_plans?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(err.message).slice(0, 500), updated_at: new Date().toISOString() }) }).catch(() => {});
    if (!coachRun) await telegram(`❌ <b>Meal plan failed</b> for ${esc(name)}\n${esc(String(err.message).slice(0, 200))}\nOpen the Coach tab and tap Generate to retry.`);
    return json({ error: 'Generating failed. Try again.' }, 502);
  }
}
