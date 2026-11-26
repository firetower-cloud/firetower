-- One list of links an entry names itself, replacing `console` and `guide`.
--
-- Those two were Google's shape read as a schema: Google splits creating an
-- OAuth client across a Cloud console and a twelve-step guide, so there were
-- two columns named after those two pages. A vendor with one page left one
-- null; a vendor with three — create the app, configure the scopes, fetch the
-- credentials — could not say so at all. And the interface spoke Google's
-- vocabulary at everybody: a button that said "Console".
--
-- Nothing in the person's job is a console. Their job is to come back with a
-- client id and a secret, and they need somewhere to go to get one. How many
-- pages that takes, and what the vendor calls them, is the vendor's business
-- and now the entry's to say.
--
-- `[{"label": "Google Cloud console", "url": "https://…"}, …]`
alter table connectors         add column setup jsonb;
alter table marketplace_entries add column setup jsonb;
alter table connectors          drop column console, drop column guide;
alter table marketplace_entries drop column console, drop column guide;
