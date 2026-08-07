-- TWL checkout v4 — record what was actually collected at booking time.
--
-- Purely additive: three nullable/defaulted columns on public.bookings. No existing
-- column changes meaning, no RLS change, no data rewrite. Existing rows keep their
-- values and pick up the defaults.
--
-- Why new columns instead of overloading deposit_cents:
--   price_cents    stays the FULL service price (unchanged)
--   deposit_cents  stays the deposit the service *requires* (unchanged)
--   amount_charged_cents  is what the card was actually charged today, tip included
--   tip_cents             is the tip portion of that charge
--   paid_in_full          is true when the customer settled the whole service up front
--
-- Overloading deposit_cents would have silently changed the meaning of a column that
-- already has a row in it and is referenced by the offline-conversion work.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS amount_charged_cents integer,
  ADD COLUMN IF NOT EXISTS tip_cents            integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_in_full         boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bookings.amount_charged_cents IS
  'Total actually charged to the card at booking (base + tip). Base is the deposit, or the full service price when paid_in_full.';
COMMENT ON COLUMN public.bookings.tip_cents IS
  'Tip portion of amount_charged_cents. Sent to Square as tip_money so it appears in Square tip reporting.';
COMMENT ON COLUMN public.bookings.paid_in_full IS
  'True when the customer paid the whole service price up front rather than just the deposit.';

-- Backfill the one pre-existing row so amount_charged_cents is never silently NULL
-- for bookings taken before this change: those were deposit-only, no tip.
UPDATE public.bookings
   SET amount_charged_cents = deposit_cents
 WHERE amount_charged_cents IS NULL;
