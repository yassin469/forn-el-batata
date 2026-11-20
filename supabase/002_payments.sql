-- =====================================================================
-- FORN EL BATATA: CARD PAYMENTS (run once, after setup.sql)
-- Paste into Supabase → SQL Editor → New query → Run.
-- =====================================================================

-- Remember Paymob's transaction number and when the order was paid.
alter table public.orders
  add column if not exists payment_ref text,
  add column if not exists paid_at timestamptz;
