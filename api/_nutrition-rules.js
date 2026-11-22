// =============================================================
//  ZANE'S NUTRITION RULES
//  1) TARGETS: the numbers used to calculate each client's calories and macros (code does the math).
//  2) RULES: plain-English guidance the AI follows when building meals.
//  Edit both to match how you coach.
// =============================================================

export const TARGETS = {
  // Calories vs. maintenance, by goal (1.00 = maintenance)
  goalMultiplier: {
    'Lose fat': 0.80,                          // 20% deficit
    'Recomp (lose fat + build muscle)': 0.95,
    'Build muscle': 1.10,                      // 10% surplus
    'Get stronger': 1.05,
    'Feel better & build confidence': 1.00,
  },
  // Never go below these daily calories, no matter what
  calorieFloor: { Male: 1500, Female: 1200, other: 1350 },
  proteinPerLb: 0.9,      // grams of protein per lb of bodyweight
  fatPercent: 0.27,       // share of calories from fat
  minFatPerLb: 0.3,       // never less fat than this (hormone health)
  minCarbs: 50,           // grams
};

export const NUTRITION_RULES = `
PHILOSOPHY
- Whole foods first, flexible not extreme. About 80% nutrient-dense foods, 20% room for foods they enjoy.
- High protein at every meal. Plenty of vegetables and fruit for fiber.
- Simple, repeatable meals people will actually stick to. Repeating meals across the week is a feature, not a bug.
- Respect the client's budget, cooking time, and whether they meal prep.

STRUCTURE
- Build 2–4 day templates (e.g. "Training Day A", "Training Day B", "Rest Day") and assign one to each day Monday–Sunday.
  Meal preppers: 2–3 templates. Cook-daily clients who enjoy cooking: up to 4.
- Each template's meals must add up to within about 5% of the calorie and protein targets.
- Match the number of meals/snacks the client asked for.
- Ingredient amounts in everyday units people can buy and measure (grams or oz for meat, cups, tbsp, pieces).
- Keep instructions short: 1–3 sentences.

SHOPPING LIST
- One list for the whole week, combined across all days (e.g. "Chicken breast — 3 lb", not seven separate entries).
- Group by store section: Produce, Meat & Seafood, Dairy & Eggs, Grains & Bread, Pantry, Frozen, Other.
- Use package sizes people actually buy when it makes sense ("1 dozen eggs", "2 lb bag of rice").

DIET AND SAFETY
- Never include foods the client is allergic to or said they won't eat. Follow their diet type strictly.
- No crash diets, fasting protocols, detoxes, or "cleanses".
- If they list a medical condition that affects diet (diabetes, kidney disease, high blood pressure, digestive issues),
  keep it general and write in coach-only notes what Zane should confirm with the client or their doctor.

TONE
- Summary and tips written like Zane talking to the client: direct, encouraging, practical.
`;
