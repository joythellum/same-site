# Same · setup (one time, about 20 minutes)

The site has four parts:

- `index.html` + `img/` — the landing page
- `order.html` — the "Send your media" page (pay first, then we work)
- `netlify/functions/upload.mjs` — the upload pipe (files go straight from the client's browser into your storage)
- `netlify/functions/checkout.mjs` — the payment (Stripe Checkout: card, Apple Pay, Google Pay)

## 0. Go live, in order (30 minutes, about €10)

**A. Hosting, free (Netlify)**
1. app.netlify.com → Sign up with your Google account.
2. On the Sites page, drag `same-room-netlify.zip` onto the page. Wait 1 minute. Your site is live at `something-random.netlify.app`.
3. Site configuration → Change site name → `samestudio`. Now it's `samestudio.netlify.app`.

**B. Domain, about €10 a year (Cloudflare)**
1. dash.cloudflare.com → Sign up (free plan).
2. Domain Registration → Register Domains → search `samestudio.co` → buy it (Cloudflare sells at cost, no markup, no upsells). Turn auto-renew on.
3. Still in Cloudflare → your domain → DNS → Add record:
   - Type `CNAME`, Name `www`, Target `samestudio.netlify.app`, Proxy **off** (grey cloud).
   - Type `CNAME`, Name `@`, Target `samestudio.netlify.app`, Proxy **off**. (Cloudflare flattens this for you.)
4. Netlify → Domain management → Add a domain → `samestudio.co` → Add domain alias `www.samestudio.co` → set `www.samestudio.co` as primary. Wait a few minutes; Netlify gives you the HTTPS lock for free.

**C. Email, free (hello@samestudio.co)**
1. Cloudflare → your domain → Email → Email Routing → Enable.
2. Create address `hello` → send to `joythellum@gmail.com`. Confirm the email Gmail gets. Done: mail to hello@samestudio.co lands in your Gmail.
3. To answer *from* hello@samestudio.co: Gmail → Settings → Accounts → "Send mail as" → add it (Cloudflare's guide: Email Routing → "Send email from your address").

**D. Keep going with sections 2, 3, 4, 4b below** (storage, payments, the ready page). Each one is independent: the site is already live before you do them.

## 1. Deploy on Netlify

1. Go to app.netlify.com → Add new site → Deploy manually.
2. Drag this whole folder (not just index.html) onto the page.
3. Netlify builds it and gives you a link like `something.netlify.app`.

Orders land in Netlify → Forms → `order`. To get them by email: Site configuration → Forms → Form notifications → Add notification → Email → hello@samestudio.co.

## 2. Make the storage (Cloudflare R2)

1. Create a free account at dash.cloudflare.com.
2. Left menu → R2 Object Storage → Create bucket → name it `same-uploads`. Leave everything else as is.
3. Open the bucket → Settings → CORS policy → Edit → paste this (change the two site links to yours):

```json
[
  {
    "AllowedOrigins": ["https://YOUR-SITE.netlify.app", "https://www.YOUR-DOMAIN.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Back in R2 → Manage R2 API Tokens → Create API token → Permissions: **Object Read & Write** → Specify bucket: `same-uploads` → Create.
5. Copy these three things (you only see the secret once):
   - Account ID
   - Access Key ID
   - Secret Access Key

## 3. Give Netlify the keys

Netlify → your site → Site configuration → Environment variables → Add a variable, four times:

| Key | Value |
|---|---|
| `R2_ACCOUNT_ID` | your Account ID |
| `R2_ACCESS_KEY_ID` | the Access Key ID |
| `R2_SECRET_ACCESS_KEY` | the Secret Access Key |
| `R2_BUCKET` | `same-uploads` |

Then Deploys → Trigger deploy → Deploy site (so the function picks up the keys).

## 4. Payments (Stripe)

1. Make an account at stripe.com (you need your ID and your bank account number, IBAN, so the money lands in your bank).
2. Stripe → Developers → API keys → copy the **Secret key** (starts with `sk_live_`). For a test run first, copy the test one (`sk_test_`).
3. Netlify → Environment variables → add `STRIPE_SECRET_KEY` = that key. Trigger deploy again.
4. Stripe → Settings → Payment methods → turn on Apple Pay and Google Pay (free). Set Settings → Public details → name "Same", support email hello@samestudio.co, so the receipt and the card statement say "Same".
5. Stripe → Settings → Customer emails → turn on "Successful payments" so the client gets a receipt by email too.

How the money flows: client pays on the Stripe page → money sits in your Stripe balance → Stripe sends it to your bank every day on a rolling basis (first payout takes about 7 days, then every day after).

Fees (Spain / EU account, 2026): about **1.5% + €0.25** for EU cards, **2.5% + €0.25** for UK cards, **3.25% + €0.25** for cards from outside Europe, plus **2%** when the card pays in a currency other than your payout currency. On a $350 order from a US card that is about $12 to $13. No monthly fee, no setup fee.

Test cards (test mode only): `4242 4242 4242 4242`, any future date, any CVC.

## 4b. "Your photos are ready" (no login for the client)

How it works: when someone sends an order, their browser keeps one secret order key. No account, no password.
They close the tab. When they open the site again, a small pill at the top says **We're on it · ready by 11:40**, then **Your photos are ready**. Tapping it opens `ready.html`: the gallery, **Download all** (one zip), a private link and a QR code to open the same order on another phone, and a button to get a buzz on the phone the moment it's ready.

Your side is `done.html` (not linked from the site). Open it, paste your admin secret once, pick the order, drop the finished files, press **Mark as ready and buzz the phone**.

Add these environment variables in Netlify (Site configuration → Environment variables):

| Key | Value |
|---|---|
| `ADMIN_SECRET` | a long password only you know (the done page asks for it once per browser) |
| `VAPID_PUBLIC_KEY` | see below |
| `VAPID_PRIVATE_KEY` | see below |
| `VAPID_SUBJECT` | `mailto:hello@samestudio.co` |

The two VAPID keys are what makes push alerts work. Make them once, on any computer with Node:

```
npx web-push generate-vapid-keys
```

Copy the public and private key into Netlify. Then Deploys → Trigger deploy.

Push alerts need the site on https (Netlify gives you that) and, on iPhone, the page added to the Home Screen (Share → Add to Home Screen). The ready page tells the client this.

Without these variables everything still works, except the buzz: the client just opens the site and sees the pill.

No pipe behind the page at all (the preview, or a folder opened by hand)? Then the pages run a **demo clock**: a test order is "ready" 2 minutes after it's sent, and the ready page shows sample photos from the site. `done.html` can flip a demo order to ready right away.

Where things live in the bucket: `orders/<key>.json` (the order), `delivered/<key>/…` (the finished files). The CORS policy above already allows GET, which **Download all** needs.

## 5. Test it

Open `your-site.netlify.app/order.html`, drop a photo and a big video, fill name, email and place, tap Pay. Pay with the test card. You should get:

- a Netlify Forms email with the order number, the plan, the name, email, place, and a list of files with download links (links work for 7 days)
- a Stripe email saying you got paid, with the same order number
- the files in Cloudflare → R2 → `same-uploads`, in a folder named by date

## If someone pays but the order email never comes

Stripe keeps every payment with the order number and the place name in Dashboard → Payments. Netlify keeps every order in Forms → `order`. Match them by order number (looks like `SM-261105-AB12`).

## What it costs

- Netlify: free (100 orders a month on the free plan).
- Stripe: no monthly fee, only the fee per payment (above).
- Cloudflare R2: first 10 GB stored each month free, then about $0.015 per GB per month. Downloading is free.

## If an upload ever fails

The page retries each piece 3 times on its own. If it still fails, the page tells the client to email hello@samestudio.co. Nothing is lost.
