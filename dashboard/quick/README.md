# Quick Apply UI (scaffold — not implemented yet)

This directory is a placeholder for the future **Quick Apply** user interface.
No code lives here yet; nothing in this directory is served by the product.

## Intended migration (documented, not implemented)

- The future Quick Apply UI (this directory) becomes the **default** Dashboard
  experience.
- The current Dashboard (`dashboard/public/` served by `dashboard/server.mjs`)
  is temporarily kept and served as the **Advanced** view (see
  `dashboard/advanced/`).
- Both views reuse the **existing** backend and domain modules
  (`dashboard/server.mjs`, `scripts/lib/`, `application_executor/`). No second
  backend, no second state machine, and no second data store will be created.

See [docs/product/QUICK_APPLY_TARGET_PRODUCT.md](../../docs/product/QUICK_APPLY_TARGET_PRODUCT.md)
and [docs/product/QUICK_APPLY_IMPLEMENTATION_PLAN.md](../../docs/product/QUICK_APPLY_IMPLEMENTATION_PLAN.md)
for the product definition and implementation plan.
