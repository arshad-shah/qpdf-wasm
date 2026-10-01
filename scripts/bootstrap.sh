#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .toolchain
mkdir -p .toolchain/tmp
export TMPDIR="$PWD/.toolchain/tmp"
if [ ! -d .toolchain/emsdk/.git ]; then
  git clone https://github.com/emscripten-core/emsdk.git .toolchain/emsdk
fi
git -C .toolchain/emsdk checkout e566f7bdcc7735f44037911c24b87a58a3c93145
.toolchain/emsdk/emsdk install 4.0.10
.toolchain/emsdk/emsdk activate 4.0.10
