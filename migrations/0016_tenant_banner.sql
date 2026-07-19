-- Homepage banner: creators upload a banner image at creation; stored in KV, flagged here.
ALTER TABLE tenants ADD COLUMN banner TEXT;   -- '1' when a banner image exists in KV (banner:<tid>)
