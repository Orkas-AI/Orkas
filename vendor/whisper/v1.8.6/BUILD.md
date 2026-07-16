# Vendored whisper.cpp macOS CLI

The two Mach-O files in this directory are the target-native `whisper-cli`
executables used by Orkas on macOS. They were built from the immutable
whisper.cpp `v1.8.6` source archive:

- source: `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.8.6.tar.gz`
- source SHA-256: `f8e632016ceae556f3132a16c7f704be1e7715595041f474fa81a2b64c1abf7c`
- CMake: `4.3.3` macOS universal archive, SHA-256
  `5221a13450c7a0219a2a0d1b6c9085eb06489721fafd8488ccebc1584175d2fb`
- Apple SDK deployment target: macOS 12.0, matching the Electron application
- shared libraries: disabled
- OpenMP, BLAS, and Accelerate: disabled
- Metal: enabled with the Metal library embedded in the executable
- native host tuning: disabled so the binary only uses the declared target
  architecture baseline

Common configuration flags:

```text
-DCMAKE_BUILD_TYPE=Release
-DBUILD_SHARED_LIBS=OFF
-DWHISPER_BUILD_TESTS=OFF
-DWHISPER_BUILD_EXAMPLES=ON
-DWHISPER_BUILD_SERVER=OFF
-DGGML_OPENMP=OFF
-DGGML_NATIVE=OFF
-DGGML_ACCELERATE=OFF
-DGGML_BLAS=OFF
-DGGML_METAL=ON
-DGGML_METAL_EMBED_LIBRARY=ON
-DGGML_METAL_MACOSX_VERSION_MIN=12.0
```

Each target additionally used `-DCMAKE_OSX_ARCHITECTURES=arm64` or
`-DCMAKE_OSX_ARCHITECTURES=x86_64`. The exact output size and SHA-256 are part
of `bin/runtime-gate.cjs`; changing the source, toolchain, flags, or binary
requires updating that contract and its tests in the same change.
