---
name: S3 + CloudFront safe deploy order for Vite SPAs
description: Using aws s3 sync --delete before CloudFront invalidation completes causes MIME type errors; the correct three-step order prevents this.
---

**Rule:** Never run `aws s3 sync --delete` before `aws cloudfront wait invalidation-completed` completes.

**Why:** Vite generates content-hashed asset filenames (e.g. `assets/index-C4ib8eU3.css`). Each build produces new hashes. When `--delete` removes old files while CloudFront edge nodes still cache the old `index.html` (which references old hashes), those edges serve HTML pointing to assets that no longer exist in S3. CloudFront's S3 "not found" fallback is the configured default root object — `index.html` — so the browser receives an HTML document instead of CSS/JS and rejects it:

```
The stylesheet … was not loaded because its MIME type, "text/html", is not "text/css"
Loading module … was blocked because of a disallowed MIME type ("text/html")
```

The invalidation window is typically 30–90 seconds and affects all 300+ CloudFront edge locations.

**Correct order:**
```bash
# 1. Upload new assets — keep old files alive (no --delete yet)
aws s3 sync dist/public/ s3://<bucket>/ --region us-east-1

# 2. Invalidate and WAIT — blocks until all edges are clean
INVID=$(aws cloudfront create-invalidation \
  --distribution-id <dist-id> --paths "/*" --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id <dist-id> --id "$INVID"

# 3. Now safe to delete old hashed files
aws s3 sync dist/public/ s3://<bucket>/ --delete --region us-east-1
```

Old Vite assets don't conflict with new ones (different hashes), so keeping them alive during steps 1–2 is harmless and costs a few hundred KB at most.

This is documented in DEPLOYMENT.md Step 3 and in the "Known Pitfalls" section of replit.md.
