#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv_scrapling/bin/activate
python -c "import scrapling; print('scrapling installed')"
