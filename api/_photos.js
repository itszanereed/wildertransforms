// Food photos from Pexels OR Unsplash (both free stock photo libraries).
// Vercel env var: PEXELS_API_KEY (pexels.com/api) or UNSPLASH_ACCESS_KEY (unsplash.com/developers).
// Without either, plans just have no photos.
import { env } from './_shared.js';

const timed = async (url, headers) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try { return await fetch(url, { headers, signal: ctrl.signal }); } finally { clearTimeout(t); }
};

// Uses Pexels if PEXELS_API_KEY is set, otherwise Unsplash (UNSPLASH_ACCESS_KEY).
export const photosEnabled = () => !!(env('PEXELS_API_KEY') || env('UNSPLASH_ACCESS_KEY'));

export async function findPhoto(query, page = 1) {
  if (!query) return null;
  const q = `${query} food`.slice(0, 100);
  try {
    if (env('PEXELS_API_KEY')) {
      const res = await timed(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=1&page=${page}&orientation=landscape`, { Authorization: env('PEXELS_API_KEY') });
      if (!res.ok) return null;
      const p = (await res.json()).photos?.[0];
      if (!p) return page > 1 ? findPhoto(query, 1) : null;
      return { url: p.src?.large || p.src?.medium, thumb: p.src?.small || p.src?.tiny, credit: p.photographer, link: p.url, provider: 'Pexels', query, page };
    }
    if (env('UNSPLASH_ACCESS_KEY')) {
      const auth = { Authorization: `Client-ID ${env('UNSPLASH_ACCESS_KEY')}`, 'Accept-Version': 'v1' };
      const res = await timed(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=1&page=${page}&orientation=landscape&content_filter=high`, auth);
      if (!res.ok) return null;
      const p = (await res.json()).results?.[0];
      if (!p) return page > 1 ? findPhoto(query, 1) : null;
      // Unsplash asks apps to register a "download" when a photo is used.
      if (p.links?.download_location) timed(p.links.download_location, auth).catch(() => {});
      const utm = 'utm_source=wilder_transforms&utm_medium=referral';
      return { url: p.urls?.regular, thumb: p.urls?.small, credit: p.user?.name, link: `${p.links?.html}?${utm}`, provider: 'Unsplash', query, page };
    }
    return null;
  } catch { return null; }
}

// Look up many photos, 4 at a time.
export async function findPhotos(items) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await findPhoto(items[k].query, items[k].page || 1); } };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return out;
}

// Attach a photo to every meal in a plan that doesn't have one yet.
export async function addPhotosToPlan(data) {
  if (!photosEnabled() || !data?.day_templates) return data;
  const meals = data.day_templates.flatMap((t) => t.meals || []).filter((m) => !m.photo);
  const photos = await findPhotos(meals.map((m) => ({ query: m.photo_query || m.title })));
  meals.forEach((m, k) => { if (photos[k]) m.photo = photos[k]; });
  return data;
}
