import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import './sources.mjs';
const win = process.platform === 'win32';
const sdk = resolve('.toolchain/emsdk');
const cmake = win ? resolve('.toolchain/cmake-3.31.6-windows-x86_64/bin/cmake.exe') : 'cmake';
const ninja = win ? resolve('.toolchain/ninja/ninja.exe') : 'ninja';
const python = win ? resolve('.toolchain/emsdk/python/3.13.3_64bit/python.exe') : 'python3';
await mkdir('.toolchain/tmp', { recursive: true });
const temp = resolve('.toolchain/tmp');
const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, EMSDK: sdk, EMSDK_PYTHON: python, EM_CONFIG: `${sdk}/.emscripten`, EM_CACHE: `${sdk}/upstream/emscripten/cache`, PATH: `${win ? resolve('.toolchain/emsdk/python/3.13.3_64bit') + ';' : ''}${process.env.PATH}` };
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status}`);
}
const prefix = resolve('vendor/install').replaceAll('\\', '/');
const toolchain = `${sdk}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake`.replaceAll('\\', '/');
// Emscripten treats SHARED as STATIC; avoid zlib's two targets producing libz.a.
const zlibCmake = 'vendor/zlib-1.3.1/CMakeLists.txt';
await writeFile(zlibCmake, (await readFile(zlibCmake, 'utf8')).replace('set_target_properties(zlib zlibstatic PROPERTIES OUTPUT_NAME z)', 'set_target_properties(zlibstatic PROPERTIES OUTPUT_NAME z)\n   set_target_properties(zlib PROPERTIES OUTPUT_NAME z-unused)'));
function configure(name, source, options) {
  run(cmake, ['-S', source, '-B', `vendor/build-${name}`, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`, `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_BUILD_TYPE=Release', ...options]);
}
configure('zlib', 'vendor/zlib-1.3.1', ['-DZLIB_BUILD_EXAMPLES=OFF']);
run(cmake, ['--build', 'vendor/build-zlib', '--target', 'install', '-j', '4']);
configure('jpeg', 'vendor/libjpeg-turbo-3.1.0', ['-DENABLE_SHARED=OFF', '-DENABLE_STATIC=ON', '-DWITH_SIMD=OFF', '-DWITH_TURBOJPEG=OFF']);
run(cmake, ['--build', 'vendor/build-jpeg', '--target', 'install', '-j', '4']);
configure('qpdf', 'vendor/qpdf-12.2.0', [`-DCMAKE_PREFIX_PATH=${prefix}`, `-DZLIB_LIB_PATH=${prefix}/lib/libz.a`, `-DZLIB_H_PATH=${prefix}/include`, `-DLIBJPEG_LIB_PATH=${prefix}/lib/libjpeg.a`, `-DLIBJPEG_H_PATH=${prefix}/include`, '-DPKG_CONFIG_EXECUTABLE=IGNORE', '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_STATIC_LIBS=ON', '-DBUILD_DOC=OFF', '-DUSE_IMPLICIT_CRYPTO=OFF', '-DREQUIRE_CRYPTO_NATIVE=ON', '-DDEFAULT_CRYPTO=native', '-DCMAKE_CXX_FLAGS=-fexceptions']);
run(cmake, ['--build', 'vendor/build-qpdf', '--target', 'libqpdf', '-j', '4']);
await mkdir('dist', { recursive: true });
run(python, [`${sdk}/upstream/emscripten/em++.py`, '-O3', '-fexceptions', 'vendor/qpdf-12.2.0/qpdf/qpdf.cc', '-Ivendor/qpdf-12.2.0/include', '-Ivendor/build-qpdf/include', 'vendor/build-qpdf/libqpdf/libqpdf.a', `${prefix}/lib/libjpeg.a`, `${prefix}/lib/libz.a`, '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sALLOW_MEMORY_GROWTH=1', '-sFORCE_FILESYSTEM=1', '-sENVIRONMENT=web,worker,node', '-sINVOKE_RUN=0', '-sEXIT_RUNTIME=1', '-sEXPORTED_RUNTIME_METHODS=FS,callMain', '-sSTACK_SIZE=5242880', '-o', 'dist/qpdf.js']);
await copyFile('src/qpdf.d.ts', 'dist/qpdf.d.ts');
