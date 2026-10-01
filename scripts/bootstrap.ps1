$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force .toolchain | Out-Null
function Download($Url, $Path) {
  if (!(Test-Path $Path)) {
    & curl.exe -fL --retry 3 $Url -o $Path
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
  }
}
Download 'https://www.python.org/ftp/python/3.13.3/python-3.13.3-embed-amd64.zip' '.toolchain/python.zip'
Expand-Archive .toolchain/python.zip .toolchain/python -Force
Download 'https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-windows-x86_64.zip' '.toolchain/cmake.zip'
Expand-Archive .toolchain/cmake.zip .toolchain -Force
Download 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip' '.toolchain/ninja.zip'
Expand-Archive .toolchain/ninja.zip .toolchain/ninja -Force
if (!(Test-Path .toolchain/emsdk/.git)) {
  git clone https://github.com/emscripten-core/emsdk.git .toolchain/emsdk
  if ($LASTEXITCODE -ne 0) { throw 'emsdk clone failed' }
}
git -C .toolchain/emsdk checkout e566f7bdcc7735f44037911c24b87a58a3c93145
if ($LASTEXITCODE -ne 0) { throw 'emsdk checkout failed' }
& .toolchain/python/python.exe .toolchain/emsdk/emsdk.py install 4.0.10
if ($LASTEXITCODE -ne 0) { throw 'emsdk install failed' }
& .toolchain/emsdk/python/3.13.3_64bit/python.exe .toolchain/emsdk/emsdk.py activate 4.0.10
if ($LASTEXITCODE -ne 0) { throw 'emsdk activation failed' }
