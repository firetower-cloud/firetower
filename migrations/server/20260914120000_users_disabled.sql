-- A user an administrator has switched off: kept, so what they made is still
-- theirs, but unable to sign in. Their sessions are ended when it is set.
alter table users add column disabled boolean not null default false;
