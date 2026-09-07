-- How a workspace competes for a machine two of them want at once.
--
-- Beside `size`, and stored the same way, because they are the two halves of
-- one question: the size is how much a workspace may have at most, and this is
-- who yields when both want the same core in the same moment.
--
-- `Equal` for every workspace that already exists, which is what they have all
-- been doing — nothing has been dividing anything until now, so every one of
-- them was taking its turn by default.
alter table workspaces add column share text not null default 'Equal';
