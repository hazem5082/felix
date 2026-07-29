-- ============================================================
-- FILEX — Demo seed data
-- Run this AFTER 0001_init.sql, and AFTER you've created your
-- first CEO login (Supabase Dashboard > Authentication > Users >
-- Add User, with raw_user_meta_data: {"full_name":"...","role":"ceo"}).
-- This only seeds branches + a financing partner + overhead config —
-- vehicles/leads/deals are best created live through the app so you
-- see the real flow, but feel free to extend this file.
-- ============================================================

insert into branches (name, address) values
  ('Downtown Showroom', '123 Main St'),
  ('Airport Road Branch', '45 Airport Rd')
on conflict do nothing;

-- Seed a default overhead config for each branch (CEO can edit later)
insert into overhead_config (branch_id, monthly_opex_amount)
select id, 3000 from branches
on conflict (branch_id) do nothing;

-- Seed default commission tiers (mirrors the old app's default: 6000 * count)
insert into commission_tiers (tier_index, cumulative_amount)
select gs, gs * 6000
from generate_series(1, 10) gs
on conflict (tier_index) do nothing;

-- A sample financing partner, already active (contract file simulated as uploaded)
insert into financing_partners (bank_name, product_name, rate, term_months, min_down_payment, contract_file_url, status)
values ('First National Bank', 'Standard Auto Loan', 7.5, 48, 2000, 'https://example.com/sample-bank-contract.pdf', 'active')
on conflict do nothing;
