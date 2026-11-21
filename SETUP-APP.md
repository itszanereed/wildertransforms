# Wilder Transforms App: Setup (Phase 1)

## What's in this update
- `app/` folder: the client app (lives at yoursite.vercel.app/app)
- `supabase/schema.sql`: database setup you paste into Supabase once
- `index.html`: website with a "Client Login" link added

## 1. Create your Supabase project
1. Go to supabase.com, sign up free, click **New project**.
2. Name it `wildertransforms`, make a database password (save it somewhere), pick the region closest to you, and click Create.

## 2. Set up the database
1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` in Notepad, copy everything, paste it in, and click **Run**.
3. You should see "Success. No rows returned."

## 3. Make logins use a 6-digit code
Codes work inside the home-screen app. Email links would open Safari instead.
1. Go to **Authentication** → **Emails** (or **Email Templates**) → **Magic Link**.
2. Subject: `Your Wilder Transforms login code`
3. Replace the body with:

```
<h2>Your login code</h2>
<p>Enter this code in the Wilder Transforms app:</p>
<h1 style="letter-spacing:6px">{{ .Token }}</h1>
<p>This code expires in 1 hour. If you didn't request it, ignore this email.</p>
```
4. Save.

## 4. Block random sign-ups
**Authentication** → **Sign In / Providers** (or **Providers → Email**): turn OFF **Allow new users to sign up**. You'll add clients yourself.

## 5. Connect the app to Supabase
1. **Project Settings** → **API** (or **Data API / API Keys**).
2. Copy the **Project URL** and the **anon / publishable** key.
3. Open `app/config.js` in Notepad and paste them in place of `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY`. Keep the quotes.
4. Save.

## 6. Upload to GitHub
Upload the `app` folder, the `supabase` folder, and `index.html`, then commit.
(If dragging folders fails, use Add file → Create new file and type `app/config.js` etc.)

## 7. Add a client (after they pay)
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter their email, any password (they won't use it), check **Auto Confirm User**, and click Create.
3. **Table Editor** → **profiles** → find their row:
   - `full_name`: their name
   - `tier`: `fitness` or `transformation`
   - `active`: `true`
4. Tell them: go to **yoursite.vercel.app/app** on their iPhone in Safari, log in with their email, then tap Share → **Add to Home Screen**.

**To cut off access** (stopped paying): set `active` to `false`. They'll see "access isn't active."

## Note on emails
Supabase's built-in email sender only allows a few emails per hour, which is fine for testing. Before you have more than a handful of clients, connect a free email service like Resend under **Authentication → SMTP Settings**.
