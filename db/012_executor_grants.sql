-- Executor role needs to enumerate families to set its RLS context per family; nothing else widens.
grant select on families to executor_user;
grant select on entities to executor_user;
grant select on action_executions to executor_user;   -- attempt numbering
