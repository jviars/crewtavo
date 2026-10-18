-- The web address policy (20261019000100_web_address.sql) checks the row's company the per-row
-- way; rewrite it like the others (see 20261018000990_policy_lookups.sql).
select private.fold_member_checks();
