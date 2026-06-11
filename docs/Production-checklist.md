## Operational checklist (pre-event)

- [ ] Dress rehearsal with ~20 fake participants, all four group modes plus a knockout bracket.
- [ ] Kill Wi-Fi mid-edit — confirm app keeps working and flushes pending PUTs on reconnect.
- [ ] Verify recovery: pull latest backup from S3 to a fresh checkout, confirm app boots with the right data.
- [ ] Backup laptop ready: codebase + `~/.aws/credentials` + Node 20 installed.
- [ ] 4G/5G phone hotspot tested at the venue.
- [ ] Result-site URL renders correctly on a phone — most spectators will view on mobile. Browsers will show "not secure" — confirm the director is OK with that.
- [ ] QR code for the result-site URL printed and ready to display at the venue.
- [ ] `Cache-Control` headers verified on each published object (`curl -I`).
- [ ] IAM key has only `s3:PutObject`/`s3:DeleteObject`/`s3:ListBucket` on this one bucket.
- [ ] Recovery procedure printed on paper.
- [ ] `private/backups/` prefix verified non-public (`curl` returns 403).