## Approximate cost analysis

USD, `eu-central-1` published prices late 2025. Rounded; AWS prices drift.

### Scenario: the event itself (2 days of operation)

Assumes 500 spectators × ~100 hits each, with `version.json`-poll-then-refetch. Browser caching keeps actual S3 GET volume modest.

| Item | Quantity | Unit cost | Cost |
|---|---|---|---|
| S3 storage | <0.1 GB-mo | $0.023/GB-mo | **~$0.01** |
| S3 PUT requests (publishes + backups) | ~5,000 | $5/M | **$0.03** |
| S3 GET requests (poll + view refetches) | ~500,000 worst case | $0.40/M | **$0.20** |
| S3 data transfer out | ~10 GB | first 100 GB/mo free; then $0.09/GB | **$0** (free tier) / **$0.90** |
| **Total (within S3 free tier)** | | | **~$0.25** |
| **Total (no free tier)** | | | **~$1.15** |

No DNS, no certificates, no CloudFront, no domain.