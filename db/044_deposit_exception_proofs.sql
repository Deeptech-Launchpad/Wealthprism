-- Closing a locked deposit (tax-saver and similar) as a bank exception needs proof. The categories and the documents each one needs come from how banks and
-- the RBI handle these cases: the death of a holder (death certificate plus claimant / legal-heir papers, closed without penalty), a court order, the bank's own
-- written approval, a minor's guardian. Reference data, the same for every family. Each bank has its own checklist, so these are defaults, not a guarantee.
create table deposit_exception_categories (
  code text primary key,
  label text not null,
  description text not null,
  default_penalty_pct numeric(4,2),        -- null = leave the penalty as it is; 0 for a death, where RBI says no penalty applies
  sort integer not null default 0
);
create table deposit_exception_docs (
  category_code text not null references deposit_exception_categories(code),
  doc_code text not null,
  label text not null,
  required boolean not null default false,
  sort integer not null default 0,
  primary key (category_code, doc_code)
);
grant select on deposit_exception_categories, deposit_exception_docs to app_user;

insert into deposit_exception_categories (code, label, description, default_penalty_pct, sort) values
 ('death_sole',     'Death of the sole holder', 'The depositor has died. The nominee or legal heirs claim the deposit. RBI says a term deposit can be closed early on death without a penalty; the bank sets its own checklist, and larger or no-nominee claims may need a succession certificate or probate.', 0, 10),
 ('death_joint',    'Death of a joint holder (survivor mandate)', 'One of the joint holders has died and the account allows the survivor to operate it (either-or-survivor / former-or-survivor).', 0, 20),
 ('court_order',    'Court or legal order', 'A court or legal authority has ordered the deposit to be closed or paid out.', null, 30),
 ('bank_approval',  'Bank''s written approval', 'The bank has agreed in writing to close this deposit although its terms do not allow it.', null, 40),
 ('minor_guardian', 'Minor''s deposit — guardian closing it', 'The deposit is in a minor''s name and the guardian is closing it.', null, 50),
 ('other',          'Other (explain)', 'Any other case the bank has agreed to. Attach whatever supports it and explain it in the reason.', null, 90);

insert into deposit_exception_docs (category_code, doc_code, label, required, sort) values
 ('death_sole',  'death_certificate', 'Death certificate of the holder', true, 10),
 ('death_sole',  'claimant_id',       'Claimant''s ID and address proof (KYC)', true, 20),
 ('death_sole',  'heir_proof',        'Nominee proof or legal-heir document (legal-heir certificate, succession certificate, or will with probate)', true, 30),
 ('death_sole',  'indemnity_bond',    'Indemnity bond (if the bank asked for one)', false, 40),
 ('death_sole',  'bank_ack',          'Bank''s claim form or acknowledgement', false, 50),
 ('death_joint', 'death_certificate', 'Death certificate of the deceased holder', true, 10),
 ('death_joint', 'survivor_id',       'Surviving holder''s ID proof', true, 20),
 ('death_joint', 'bank_mandate',      'Bank''s confirmation of the survivor mandate', false, 30),
 ('court_order', 'order_copy',        'Copy of the court or legal order', true, 10),
 ('court_order', 'bank_ack',          'Bank''s acknowledgement', false, 20),
 ('bank_approval','bank_letter',      'The bank''s letter or email approving the closure', true, 10),
 ('bank_approval','request_letter',   'Your request letter to the bank', false, 20),
 ('minor_guardian','guardian_id',     'Guardian''s ID proof', true, 10),
 ('minor_guardian','guardian_order',  'Court order appointing the guardian (if any)', false, 20),
 ('minor_guardian','bank_form',       'Bank''s closure form', false, 30),
 ('other',       'supporting',        'At least one supporting document', true, 10);

alter table deposits add column if not exists closure_exception_category text references deposit_exception_categories(code);
