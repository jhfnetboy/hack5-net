# Cloudflare Token Permissions

The token in `~/Dev/.env` must be able to manage Workers, D1, R2, and Email Sending for this project.

Minimum practical permissions:

- Account: Workers Scripts Edit
- Account: D1 Edit
- Account: R2 Edit
- Account: Email Sending Edit
- User/API token ability to create R2 S3 access keys, or provide `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` separately

The currently detected environment variable names include DNS, registrar, and tunnel tokens, but not a standard `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`. If deploy commands fail, add:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
```

or put those names into `~/Dev/.env` and load them before running `wrangler`.
