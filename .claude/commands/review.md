Review the current branch's diff against main as a senior engineer on this project.

Check, in this order, and report findings with file:line references:
1. Separation of powers and RLS rules from CLAUDE.md — any write path that bypasses withFamily(), requireRole(), approvals or DB triggers.
2. Contract drift — routes whose request/response shapes differ from api/openapi.yaml.
3. Tax or money handling — numeric constants for tax rates, floating-point money, non-string money in JSON.
4. Migrations — edits to applied files, missing RLS policy or grants on new tables.
5. Tests — acceptance criteria of the ticket not covered by a test.
6. UI — deviation from the prototype's layout or tokens.
End with: merge / merge with fixes / do not merge, and the fixes as a checklist.
