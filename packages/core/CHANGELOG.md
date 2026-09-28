# provider-guard

## 0.1.0

### Minor Changes

- 05191ab: First release. `guard()` catches responses that bill text tokens but deliver nothing and retries them once on a different provider, in `generateText` and `streamText`. `exclude()` excludes one provider for one model. Every attempt is recorded as metadata only. `provider-guard report` summarizes provider health per model, and `provider-guard studio` opens a local dashboard.
