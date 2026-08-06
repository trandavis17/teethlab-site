import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * ClickPogo — Square bridge for The Teeth Whitening Lab.  v3 (DRAFT — NOT DEPLOYED)
 *
 * v2 shipped read-only actions: ping, locations, services, team, availability,
 * plus the sandbox-only seed_sandbox. v3 adds ONE production write action:
 *
 *   create_checkout — tokenized card -> CreatePayment (deposit) -> CreateBooking
 *                     -> bookings row (service role). Guarded, see GUARDS below.
 *
 * The access token lives ONLY in Supabase secrets and is never returned.
 * DO NOT deploy until Davis gives explicit go-ahead on create_checkout.
 */

const SQUARE_VERSION = "2025-01-23";

const BASES: Record<string, string> = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
};

const SECRET_NAMES: Record<string, string> = {
  sandbox: "SQUARE_SANDBOX_ACCESS_TOKEN",
  production: "SQUARE_PRODUCTION_ACCESS_TOKEN",
};

/* ---------------- GUARDS for the single write path ----------------
 * Everything about money and identity comes from THIS server-side map,
 * verified against the live catalog on 2026-08-06. The client's numbers
 * are cross-checked and rejected on mismatch — never trusted.
 */
const ALLOWED_LOCATION = "LBT6DHXGMSP0S";
const ALLOWED_VARIATIONS: Record<string, { deposit: number; full: number; minutes: number; label: string }> = {
  "C7U5ILFM2XBZNABYVTO4AX23": { deposit: 5000,  full: 25000, minutes: 90, label: "1 Adult 90 Min" },
  "XNBJKEJ5WQDT3XBRNG2DGMJJ": { deposit: 5000,  full: 30000, minutes: 90, label: "1 Adult 90 Min + Kit" },
  "OUOPFLGAOM4J75DVMTUJZYT3": { deposit: 10000, full: 45000, minutes: 90, label: "Party of 2 90 Min" },
  "OSBUUUYMXBFW7DEPZS4RC6OU": { deposit: 10000, full: 50000, minutes: 90, label: "Party of 2 90 Min + Kits" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function square(env: string, path: string, init: RequestInit = {}) {
  const base = BASES[env];
  const token = Deno.env.get(SECRET_NAMES[env]);
  if (!base) throw new Error(`unknown env "${env}"`);
  if (!token) throw new Error(`secret ${SECRET_NAMES[env]} is not set`);

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  if (!res.ok) throw new Error(`Square ${res.status} on ${path}: ${JSON.stringify(parsed)}`);
  return parsed as any;
}

function shapeServices(objects: any[]) {
  return (objects ?? [])
    .filter((o) => o.type === "ITEM" && o.item_data?.product_type === "APPOINTMENTS_SERVICE")
    .map((item) => ({
      item_id: item.id,
      name: item.item_data?.name ?? null,
      description: item.item_data?.description ?? null,
      variations: (item.item_data?.variations ?? []).map((v: any) => ({
        service_variation_id: v.id,
        service_variation_version: v.version,
        name: v.item_variation_data?.name ?? null,
        duration_minutes: v.item_variation_data?.service_duration
          ? Math.round(Number(v.item_variation_data.service_duration) / 60000)
          : null,
        price_cents: v.item_variation_data?.price_money?.amount ?? null,
        currency: v.item_variation_data?.price_money?.currency ?? null,
        bookable_online: v.item_variation_data?.available_for_booking ?? null,
        team_member_ids: v.item_variation_data?.team_member_ids ?? [],
      })),
    }));
}

/** Fetch the current version number of a service variation (CreateBooking requires it). */
async function variationVersion(env: string, variationId: string): Promise<number> {
  const data = await square(env, `/v2/catalog/object/${variationId}`, { method: "GET" });
  return Number(data.object?.version);
}

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }

    const action = body.action ?? url.searchParams.get("action") ?? "ping";
    const env = body.env ?? url.searchParams.get("env") ?? "sandbox";
    const locationId = body.location_id ?? (env === "sandbox" ? null : ALLOWED_LOCATION);

    if (!BASES[env]) return json({ ok: false, error: "env must be sandbox or production" }, 400);

    switch (action) {
      case "ping":
        return json({
          ok: true, action: "ping", square_version: SQUARE_VERSION, bridge_version: 3,
          sandbox_token_present: Boolean(Deno.env.get("SQUARE_SANDBOX_ACCESS_TOKEN")),
          production_token_present: Boolean(Deno.env.get("SQUARE_PRODUCTION_ACCESS_TOKEN")),
        });

      case "locations": {
        const data = await square(env, "/v2/locations", { method: "GET" });
        return json({ ok: true, env, locations: (data.locations ?? []).map((l: any) => ({
          id: l.id, name: l.name, status: l.status, timezone: l.timezone,
        })) });
      }

      case "services": {
        const data = await square(env, "/v2/catalog/list?types=ITEM", { method: "GET" });
        const services = shapeServices(data.objects ?? []);
        return json({ ok: true, env, count: services.length, services });
      }

      case "team": {
        const data = await square(env, "/v2/bookings/team-member-booking-profiles?bookable_only=true", { method: "GET" });
        return json({ ok: true, env, team: (data.team_member_booking_profiles ?? []).map((t: any) => ({
          team_member_id: t.team_member_id, display_name: t.display_name ?? null, is_bookable: t.is_bookable,
        })) });
      }

      case "availability": {
        const serviceVariationId = body.service_variation_id;
        if (!serviceVariationId) return json({ ok: false, error: "service_variation_id is required" }, 400);
        if (!locationId) return json({ ok: false, error: "location_id is required" }, 400);

        const startAt = body.start_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const endAt = body.end_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

        const segment: any = { service_variation_id: serviceVariationId };
        if (body.team_member_id) segment.team_member_id_filter = { any: [body.team_member_id] };

        const data = await square(env, "/v2/bookings/availability/search", {
          method: "POST",
          body: JSON.stringify({ query: { filter: {
            start_at_range: { start_at: startAt, end_at: endAt },
            location_id: locationId,
            segment_filters: [segment],
          } } }),
        });

        const slots = (data.availabilities ?? []).map((a: any) => ({
          start_at: a.start_at,
          location_id: a.location_id,
          team_member_id: a.appointment_segments?.[0]?.team_member_id ?? null,
          duration_minutes: a.appointment_segments?.[0]?.duration_minutes ?? null,
        }));
        return json({ ok: true, env, count: slots.length, window: { startAt, endAt }, slots });
      }

      /* =====================================================================
       * create_checkout — THE ONLY PRODUCTION WRITE PATH.
       * Order of operations: validate -> customer -> payment -> booking -> DB.
       * If booking fails after payment, the payment is refunded automatically.
       * ===================================================================== */
      case "create_checkout": {
        // GUARD 0: env + location + variation whitelist
        if (env !== "production") return json({ ok: false, error: "create_checkout runs against production only" }, 400);
        if (locationId !== ALLOWED_LOCATION) return json({ ok: false, error: "location not allowed" }, 403);
        const spec = ALLOWED_VARIATIONS[body.service_variation_id];
        if (!spec) return json({ ok: false, error: "service variation not allowed" }, 403);

        // GUARD 1: client-declared money must match the server map exactly
        if (Number(body.deposit_cents) !== spec.deposit || Number(body.price_cents) !== spec.full) {
          return json({ ok: false, error: "amount mismatch" }, 400);
        }

        // GUARD 2: inputs
        const c = body.customer ?? {};
        const startAt = String(body.start_at ?? "");
        if (!body.source_id) return json({ ok: false, error: "source_id (card token) is required" }, 400);
        if (!c.name || !c.email || !c.phone) return json({ ok: false, error: "customer name, email, phone are required" }, 400);
        if (isNaN(Date.parse(startAt)) || Date.parse(startAt) < Date.now()) {
          return json({ ok: false, error: "start_at must be a future timestamp" }, 400);
        }

        const [first, ...rest] = String(c.name).trim().split(/\s+/);
        const idemBase = crypto.randomUUID();
        const db = svc();

        // gclid resolution: direct -> lead_match (email/phone) -> none
        const attr = body.attribution ?? {};
        let gclid: string | null = attr.gclid ?? null;
        let gclidSource = gclid ? "direct" : "none";
        if (!gclid) {
          const { data: lead } = await db.from("leads")
            .select("gclid").not("gclid", "is", null)
            .or(`email.eq.${c.email},phone.eq.${c.phone}`)
            .order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (lead?.gclid) { gclid = lead.gclid; gclidSource = "lead_match"; }
        }

        // 1) customer (search by email first to avoid duplicates)
        let customerId: string | null = null;
        try {
          const found = await square(env, "/v2/customers/search", {
            method: "POST",
            body: JSON.stringify({ query: { filter: { email_address: { exact: c.email } } }, limit: 1 }),
          });
          customerId = found.customers?.[0]?.id ?? null;
        } catch { /* search failure is non-fatal */ }
        if (!customerId) {
          const created = await square(env, "/v2/customers", {
            method: "POST",
            body: JSON.stringify({
              idempotency_key: `${idemBase}-cust`,
              given_name: first, family_name: rest.join(" ") || undefined,
              email_address: c.email, phone_number: c.phone,
              note: "ClickPogo custom checkout",
            }),
          });
          customerId = created.customer?.id ?? null;
        }
        if (!customerId) return json({ ok: false, error: "could not create customer" }, 500);

        // 2) payment — amount comes from the server map ONLY
        const payment = await square(env, "/v2/payments", {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: `${idemBase}-pay`,
            source_id: body.source_id,
            amount_money: { amount: spec.deposit, currency: "USD" },
            location_id: locationId,
            customer_id: customerId,
            note: `TWL deposit — ${spec.label}`,
          }),
        });
        const paymentId = payment.payment?.id;

        // 3) booking — refund the deposit if this fails
        let booking: any;
        try {
          const version = await variationVersion(env, body.service_variation_id);
          booking = await square(env, "/v2/bookings", {
            method: "POST",
            body: JSON.stringify({
              idempotency_key: `${idemBase}-book`,
              booking: {
                location_id: locationId,
                start_at: startAt,
                customer_id: customerId,
                customer_note: body.kit ? "Take-home kit added at checkout." : undefined,
                appointment_segments: [{
                  service_variation_id: body.service_variation_id,
                  service_variation_version: version,
                  team_member_id: body.team_member_id,
                  duration_minutes: spec.minutes,
                }],
              },
            }),
          });
        } catch (bookErr) {
          try {
            await square(env, `/v2/refunds`, {
              method: "POST",
              body: JSON.stringify({
                idempotency_key: `${idemBase}-refund`,
                payment_id: paymentId,
                amount_money: { amount: spec.deposit, currency: "USD" },
                reason: "Booking failed after deposit — auto-refund",
              }),
            });
          } catch { /* refund failure is logged in the row below */ }
          await db.from("bookings").insert({
            square_payment_id: paymentId ?? null,
            square_customer_id: customerId,
            service_variation_id: body.service_variation_id,
            location_id: locationId, start_at: startAt, duration_minutes: spec.minutes,
            service_name: spec.label,
            customer_name: c.name, customer_email: c.email, customer_phone: c.phone,
            price_cents: spec.full, deposit_cents: spec.deposit,
            gclid, gclid_source: gclidSource,
            landing_page_url: attr.landing ?? body.page_url ?? null,
            variant: body.variant ?? null,
            status: "failed",
            raw: { error: String(bookErr), attribution: attr },
          });
          return json({ ok: false, error: "That time was just taken — your deposit was refunded. Please pick another slot." }, 409);
        }

        // 4) DB row (service role — anon has no access to bookings)
        const bookingId = booking.booking?.id ?? null;
        await db.from("bookings").insert({
          square_booking_id: bookingId,
          square_payment_id: paymentId ?? null,
          square_customer_id: customerId,
          service_variation_id: body.service_variation_id,
          service_variation_version: booking.booking?.appointment_segments?.[0]?.service_variation_version ?? null,
          team_member_id: body.team_member_id ?? null,
          location_id: locationId, start_at: startAt, duration_minutes: spec.minutes,
          service_name: spec.label,
          customer_name: c.name, customer_email: c.email, customer_phone: c.phone,
          price_cents: spec.full, deposit_cents: spec.deposit,
          gclid, gclid_source: gclidSource,
          landing_page_url: attr.landing ?? body.page_url ?? null,
          variant: body.variant ?? null,
          status: "confirmed",
          raw: { attribution: attr, offer: body.offer ?? null, kit: Boolean(body.kit) },
        });

        return json({ ok: true, booking_id: bookingId, payment_id: paymentId });
      }

      case "seed_sandbox": {
        // HARD GUARD: sandbox-only, unchanged from v2.
        if (env !== "sandbox") {
          return json({ ok: false, error: "seed_sandbox refuses to run against production" }, 403);
        }
        return json({ ok: false, error: "seed_sandbox retained in v2 history; sandbox has no Appointments support" }, 410);
      }

      default:
        return json({ ok: false, error: `unknown action "${action}"` }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
