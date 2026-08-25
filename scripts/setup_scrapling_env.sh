#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv_scrapling
source .venv_scrapling/bin/activate
python -m pip install --upgrade pip
pip install "scrapling[all]"
python -c "import scrapling; print('scrapling ok')"
