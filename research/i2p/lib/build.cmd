@echo off
rem Usage: build.cmd <i2pd-src> <deps (vcpkg installed\x64-windows-static)> <node-api-headers dir> <out dir>
rem Run from a folder you can write to; needs MSVC (same toolset vcpkg used), Ninja and CMake on PATH.
call "%VCVARS%" || exit /b 1
lib /nologo /def:%~dp0napi.def /machine:x64 /out:%4\napi.lib || exit /b 1
cmake -S %~dp0 -B %4 -G Ninja -DCMAKE_BUILD_TYPE=Release -DI2PD_SRC=%1 -DDEPS=%2 -DNODE_INC=%3 -DNODE_LIB=%4\napi.lib || exit /b 1
cmake --build %4
