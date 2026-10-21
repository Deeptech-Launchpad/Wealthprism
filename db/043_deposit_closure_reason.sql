-- Every early closure now records why it was done (the person closing it must say), not only the bank-exception cases.
alter table deposits add column if not exists closure_reason text;
-- closures recorded before this had no reason asked; keep an exception's reason as the reason
update deposits set closure_reason = closure_exception_reason where closure_reason is null and closure_exception_reason is not null;
