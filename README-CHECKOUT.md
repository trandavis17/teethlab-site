# TWL Custom Checkout — branch `checkout` (preview build)

Built 2026-08-06 by ClickPogo (Claude session with Davis). Replaces the Square-hosted
booking page with a 3-click checkout at `/book/`. Square stays backend-only.

## What's in this branch

| File | Status | What it does |
|---|---|---|
| `book/index.html` | NEW | The 3-click checkout. Live Square availability via `square-bridge`. Payments **disabled** (`CFG.CHECKOUT_LIVE=false`) — amber preview ribbon shows. |
| `index.html` | EDITED | All main booking CTAs → `/book/?offer=…` with per-position `utm_content`. GCLID/UTM capture (`twl_attr` cookie, 90d) + sticky 50/50 `twl_variant` cookie. Lead inserts now include `gclid` + `variant`. "Forever White" row removed per offer consolidation. |
| `supabase/functions/square-bridge/index.ts` | NEW (repo copy, **NOT deployed**) | v3 draft: adds the single guarded write action `create_checkout` (deposit payment → booking → bookings row, auto-refund if booking fails). Deploy only after Davis's explicit go-ahead. |
| `middleware.js.vnext` | NEW (inactive) | Edge-middleware A/B rewrite, for when a real `/b` variant exists. Rename to `middleware.js` + test on a preview first. |

## Verified live facts baked into config (2026-08-06)

- Location: `LBT6DHXGMSP0S` · Square app ID: `sq0idp-JyfU-XukbVVd6r568ODldg`
- 1 Adult 90 min — $250 full, $50 deposit — variation `C7U5ILFM2XBZNABYVTO4AX23`
- 1 Adult + Kit — $300 full, $50 deposit — `XNBJKEJ5WQDT3XBRNG2DGMJJ`
- Party of 2 — $450 full, $100 deposit — `OUOPFLGAOM4J75DVMTUJZYT3`
- Party of 2 + Kits — $500 full, $100 deposit — `OSBUUUYMXBFW7DEPZS4RC6OU`
- 2.5-hour block: does **not** exist in the catalog yet (all services are 60/90 min). Angel to create; checkout reads durations from the catalog so no code change needed.

## Go-live checklist (in order)

1. Davis reviews preview with Angel.
2. Davis gives explicit go-ahead → deploy `square-bridge` v3.
3. One controlled real test booking ($50, refunded) with Angel aware.
4. Flip `CFG.CHECKOUT_LIVE=true` in `book/index.html` (removes preview ribbon).
5. Create the "Booking confirmed" conversion action in Google Ads, paste its label
   into `CFG.CONV_BOOKED`, demote the old "Begin Booking — Square click" action to Secondary.
6. Merge `checkout` → `main`.

## Known items / decisions parked

- Teenager ($225/60min), Model/Influencer, Follow-Up still link to Square's hosted page
  (not part of the 2-offer consolidation; decide later whether to add or drop).
- Meta pixel: none exists on the site. Event calls are stubbed behind `window.fbq` guards;
  add the pixel ID when Angel provides it.
- Offline conversion upload (true Google Ads API path writing `conversion_uploaded_at`)
  needs a Google Ads developer token + OAuth — separate task. On-page `booking_confirmed`
  conversion covers attribution meanwhile.
- Pre-existing (also on live prod): 9px horizontal overflow at 375px viewport on the
  landing page, invisible to users (`body{overflow-x:hidden}`). Not introduced by this branch.
- QA: Playwright at 375/390/414/820/1440/1920 — zero JS errors, zero user-visible overflow,
  full preview flow (offer → slot → tokenize → preview-done) passing at all widths.
