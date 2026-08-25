# Advanced Dashboard (scaffold — not implemented yet)

This directory is a placeholder. When the Quick Apply UI ships, the current
Dashboard front-end (today in `dashboard/public/`) will be served from an
"Advanced" entry point so existing users keep full control of every product
area.

Until that migration happens, the product continues to serve
`dashboard/public/` exactly as before; this directory contains no served code.

Rules for the migration (see
[docs/product/QUICK_APPLY_IMPLEMENTATION_PLAN.md](../../docs/product/QUICK_APPLY_IMPLEMENTATION_PLAN.md)):

- Quick Apply becomes the default UI; the current Dashboard remains available
  as Advanced.
- Both are front-ends over the same `dashboard/server.mjs` API and the same
  domain modules — no second backend or state machine.
