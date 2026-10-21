// SPDX-License-Identifier: MIT
// Compile the original Relay bridge plus a pinned, MIT-licensed CPU recognizer.
// Run on Linux with CMake and a C/C++ toolchain; no model is installed here.
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { listeningLinuxSource } from '../server/local-listening-artifacts.mjs';
if (
  process.platform !== 'linux' ||
  !['arm64', 'x64'].includes(process.arch) ||
  !process.argv[2] ||
  !process.argv[3]
)
  throw Error('On Linux ARM64/x64, supply the pinned source archive and an output directory.');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = resolve(process.argv[2]),
  bytes = await readFile(archive);
if (bytes.length !== listeningLinuxSource.bytes || hash(bytes) !== listeningLinuxSource.sha256)
  throw Error('The recognition source archive does not match the pinned release.');
const temp = await mkdtemp(join(tmpdir(), 'relay-listening-build-'));
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
try {
  const source = join(temp, 'source'),
    build = join(temp, 'build');
  await mkdir(source);
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
  run('cmake', [
    '-S',
    source,
    '-B',
    build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
    `-DCMAKE_C_FLAGS=-ffile-prefix-map=${temp}=/relay-listening-build`,
    `-DCMAKE_CXX_FLAGS=-ffile-prefix-map=${temp}=/relay-listening-build`,
    '-DWHISPER_BUILD_EXAMPLES=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DGGML_NATIVE=OFF',
    '-DGGML_OPENMP=OFF',
    '-DGGML_BACKEND_DL=OFF',
    '-DGGML_LLAMAFILE=OFF',
    ...(process.arch === 'arm64'
      ? ['-DGGML_CPU_ARM_ARCH=armv8-a']
      : ['-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF']),
  ]);
  run('cmake', ['--build', build, '--config', 'Release', '-j', '4']);
  const output = resolve(process.argv[3], 'linux-' + process.arch);
  await mkdir(output, { recursive: true });
  const object = join(temp, 'transcribe.o');
  run('cc', [
    '-O2',
    `-ffile-prefix-map=${temp}=/relay-listening-build`,
    '-DRELAY_STATIC_WHISPER',
    '-I',
    join(source, 'include'),
    '-I',
    join(source, 'ggml/include'),
    '-c',
    'native/audio/transcribe.c',
    '-o',
    object,
  ]);
  const libraries = [];
  async function walk(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const p = join(path, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/^lib(whisper|ggml.*)\.a$/.test(e.name)) libraries.push(p);
    }
  }
  await walk(build);
  if (libraries.length < 4 || !libraries.some((p) => p.endsWith('/libwhisper.a')))
    throw Error('The build is missing recognition libraries.');
  const executable = join(output, 'transcribe');
  run('c++', [
    object,
    '-Wl,--start-group',
    ...libraries.sort(),
    '-Wl,--end-group',
    '-pthread',
    '-ldl',
    '-lm',
    '-o',
    executable,
  ]);
  run('strip', [executable]);
  const binary = await readFile(executable);
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        version: listeningLinuxSource.version,
        platform: 'linux',
        arch: process.arch,
        sourceSha256: listeningLinuxSource.sha256,
        helperBytes: binary.length,
        helperSha256: hash(binary),
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(join(output, 'LICENSE'), await readFile(join(source, 'LICENSE')));
  console.log(
    JSON.stringify({
      output,
      helperBytes: binary.length,
      sha256: hash(binary),
      version: listeningLinuxSource.version,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
