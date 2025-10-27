
## Deploy the Supabase Edge Function (enrichment-worker)

This project includes a Supabase Edge Function at `supabase/functions/enrichment-worker/index.ts` that dequeues lead-enrichment jobs and processes them in batches.

### Prerequisites
- Supabase CLI installed (`brew install supabase/tap/supabase` or see the Supabase docs)
- Logged in: `supabase login`
- Linked to your project: `supabase link --project-ref <YOUR_PROJECT_REF>`

### Configure function secrets
Set the required environment variables as Edge Function secrets. Replace placeholders with your values:

```bash
supabase functions secrets set \
  SUPABASE_URL="https://<YOUR_PROJECT_REF>.supabase.co" \
  SERVICE_ROLE_KEY="<YOUR_SERVICE_ROLE_KEY>" \
  OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>" \
  QUEUE_CONCURRENCY="10" \
  QUEUE_VT_SECONDS="120" \
  INTERNAL_PARALLEL="1"
```

Notes:
- `SERVICE_ROLE_KEY` is required because the function performs privileged RPC calls. Store it only as a function secret.
- `QUEUE_CONCURRENCY`, `QUEUE_VT_SECONDS`, and `INTERNAL_PARALLEL` are optional tuning knobs.

### Deploy the function

```bash
supabase functions deploy enrichment-worker --no-verify-jwt
```

`--no-verify-jwt` disables JWT verification for this function so it can be invoked by the scheduler without a token.

### Test the function

Invoke once to process a batch immediately:

```bash
supabase functions invoke enrichment-worker --no-verify-jwt
```

Or via HTTP (replace `<YOUR_PROJECT_REF>`):

```bash
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/enrichment-worker"
```

### Schedule automatic runs

Use the Supabase Dashboard to add a schedule:
- Open Project → Edge Functions → `enrichment-worker` → Schedules → Add schedule
- Choose a cron expression (e.g., `*/5 * * * *` to run every 5 minutes)

The function is idempotent per-claim: each run dequeues up to `min(QUEUE_CONCURRENCY, INTERNAL_PARALLEL)` jobs and acknowledges them when done.

### Database requirements

Ensure the following Postgres RPCs exist in your database (migrations should provide these):
- `dequeue_and_claim_lead_enrichment(cnt int, vt_seconds int)`
- `ack_lead_enrichment(mid int)`

### Security
- Do not commit secrets to version control. Use function secrets only.
- Because JWT verification is disabled, avoid exposing the function URL publicly; rely on the scheduler or private invocation.