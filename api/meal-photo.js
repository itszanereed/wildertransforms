// Coach-only: find food photos for meals (used by "Different photo" and "Add photos").
// POST { items: [{ query, page }] } → { photos: [...] }
import { caller, json } from './_shared.js';
import { findPhotos, photosEnabled } from './_photos.js';

export async function POST(request) {
  const who = await caller(request).catch(() => ({}));
  if (!who.profile?.is_coach) return json({ error: 'Coach only' }, 403);
  if (!photosEnabled()) return json({ error: 'Add UNSPLASH_ACCESS_KEY (or PEXELS_API_KEY) in Vercel to use meal photos.' }, 400);
  let body = {};
  try { body = await request.json(); } catch { /* none */ }
  const items = (body.items || []).slice(0, 40).map((x) => ({ query: String(x.query || '').slice(0, 80), page: Math.max(1, Math.min(50, Number(x.page) || 1)) }));
  return json({ photos: await findPhotos(items) });
}
