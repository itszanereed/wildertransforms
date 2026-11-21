// =============================================================
//  ZANE'S SUPPLEMENT RULES + PRODUCT LINKS
//  The AI follows these when drafting a client's supplement protocol.
//  Edit freely. Plain English is fine.
// =============================================================

// Your products. The AI will ONLY use links from this list (it never makes links up).
// Paste your affiliate or favorite product links between the quotes.
// Leave a link as '' if you don't have one yet. You can still add one per client in the Coach tab.
export const PRODUCTS = [
  { name: 'Creatine Monohydrate', link: '', est_monthly_cost: 15 },
  { name: 'Whey Protein Isolate', link: '', est_monthly_cost: 45 },
  { name: 'Plant Protein (vegan / dairy-free)', link: '', est_monthly_cost: 45 },
  { name: 'Vitamin D3 + K2', link: '', est_monthly_cost: 10 },
  { name: 'Fish Oil (Omega-3)', link: '', est_monthly_cost: 20 },
  { name: 'Algae Omega-3 (vegan)', link: '', est_monthly_cost: 28 },
  { name: 'Magnesium Glycinate', link: '', est_monthly_cost: 15 },
  { name: 'Multivitamin', link: '', est_monthly_cost: 20 },
  { name: 'Electrolytes', link: '', est_monthly_cost: 25 },
  { name: 'Caffeine / Pre-Workout', link: '', est_monthly_cost: 30 },
];

export const SUPPLEMENT_RULES = `
PRINCIPLES
- Natural, legal, over-the-counter supplements only. Never include steroids, SARMs, prohormones,
  peptides, banned stimulants (DMAA, DMHA, ephedra), or anything that needs a prescription.
- Supplements support training, food and sleep. They don't replace them. Food first.
- Fewer, proven supplements beat a long list. Usually 3–6 items.
- Stay inside the client's monthly budget. Use the estimated costs in the product list and show the total.

DOSES (stay within these standard ranges, never above label directions)
- Creatine monohydrate: 3–5 g daily, any time, every day (no loading phase needed).
- Protein powder: 1–2 scoops (about 25–50 g protein) only as needed to hit the daily protein target. Plant protein if vegan or dairy-free.
- Vitamin D3: 1,000–2,000 IU daily with a meal containing fat.
- Fish oil: about 1–2 g combined EPA+DHA daily with food. Algae omega-3 if vegan or allergic to fish.
- Magnesium glycinate: 200–350 mg daily, 30–60 min before bed.
- Multivitamin: as directed on the label, with breakfast.
- Electrolytes: 1 serving on heavy training/sweat days.
- Caffeine: 100–200 mg about 30 min pre-workout. Total daily caffeine under 400 mg. None within 8 hours of bed.

BUDGET TIERS (guideline)
- $0–25: creatine (+ vitamin D3 if it fits).
- $25–50: creatine, vitamin D3, plus protein OR fish oil (whichever helps their goal most).
- $50–100: creatine, protein, vitamin D3, fish oil, magnesium if sleep/recovery is a goal.
- $100+: the above plus multivitamin, electrolytes, and caffeine if they handle it well.

SAFETY (very important)
- If the client lists ANY medication or medical condition, keep the protocol conservative and write in the
  coach-only notes exactly what Zane should confirm with the client or their doctor before publishing
  (for example: fish oil with blood thinners, caffeine with blood pressure or heart conditions or anxiety meds,
  magnesium with kidney conditions, creatine with kidney conditions).
- Caffeine sensitive or avoids caffeine: no caffeine or stimulant pre-workout.
- Respect allergies and diet (vegan, dairy-free, fish allergy).
- Never claim a supplement treats, cures or prevents any disease.

FORMAT
- timing: one of "Morning", "With breakfast", "Pre-workout", "Post-workout", "With dinner", "Before bed", "Any time".
- purpose: one short sentence in Zane's voice on why this is in their stack.
- link: copy the link from the product list exactly, or "" if it has none. Never invent a link.
`;
