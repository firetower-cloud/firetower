-- One mailbox, one account, whatever the capitalisation.
--
-- `users.email` has been here since the first migration, nullable and unique
-- per organisation. What it was not is case-insensitive, so
-- `Kevin@westlabs.com` and `kevin@westlabs.com` could both exist: one inbox,
-- two accounts, and a support ticket nobody should have to answer. Addresses
-- are about to start mattering — they are required for anybody added from now
-- on, and one day something will be sent to them — so this is the moment to
-- settle it.
--
-- Nulls still do not collide, which is what lets the accounts made before
-- anybody was asked for one carry on with none. Nothing is invented for them:
-- a placeholder like `changeme@…` cannot be told apart from a real address that
-- bounces, and the first time this installation sends anything, "who have we
-- actually failed to reach" is precisely the question. The screens show them as
-- having none, with a prompt, so somebody fixes it before that day.
drop index users_by_email;
create unique index users_by_email on users (org_id, lower(email));
