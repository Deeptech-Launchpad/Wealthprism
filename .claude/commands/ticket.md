Implement ticket $ARGUMENTS end to end following the pattern in CLAUDE.md.

Steps:
1. Find the ticket in tickets/phases_0-2_tickets.md and quote its description and acceptance criteria. Identify the PRD section(s) it cites and read them.
2. List the files you will touch (contract, finance package, migration, routes, tests, web page, mobile screen) and confirm the plan with me before writing code.
3. Implement in that order. Write the test before the route.
4. Run: finance tests, API tests (against the local Postgres), web build, mobile typecheck. Fix everything that fails.
5. Summarise what was built, what the acceptance criteria now prove, and anything deferred, then propose the commit message "<KEY>: <summary>".
Do not push to main; create a branch named after the ticket key.
