# Product roadmap

## Release Candidate

- Local Dashboard with seven product areas
- Explainable discovery, normalization, deduplication, filtering, and scoring
- Versioned Resume Library with hash review
- Local Resume Intelligence for DOCX and text-based PDF
- Candidate fact confirmation and versioned Answer Memory
- Application Completion and Confidence Engine
- Safe Application Package workflow
- Form Field Memory and localhost Mock ATS end-to-end demo
- Greenhouse and Lever adapter baselines
- Limited Workday detection and safe-field baseline

## Next

1. Improve PDF layout and font extraction with synthetic fixtures.
2. Add a first-run setup wizard without changing the canonical data stores.
3. Add privacy-preserving export/import for local user configuration.
4. Improve application history and blocker analytics.
5. Validate one supervised `fill_only` application at a time after explicit
   user authorization.

## Later

- Additional ATS adapters
- Optional OCR behind a clear local privacy boundary
- Configurable local retention and redaction policies
- Packaging improvements beyond the current lightweight Windows launcher

Automatic final submission is not on the default roadmap. Any future submit
capability must be opt-in, allowlisted, idempotent, auditable, and explicitly
approved for each irreversible action.
