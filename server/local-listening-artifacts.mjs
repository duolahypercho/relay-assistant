// SPDX-License-Identifier: MIT
// Optional third-party dependencies; original Relay code verifies these before use.
export const listeningLinuxSource = Object.freeze({
  version: '1.9.2',
  commit: '306c88f4d1286aec1bf96e544632897886af5501',
  url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/306c88f4d1286aec1bf96e544632897886af5501',
  bytes: 9627120,
  sha256: 'f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df',
});
export const listeningRelease = Object.freeze({
  version: '1.9.2-base',
  name: 'Whisper Base',
  details: 'https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2',
  modelDetails: 'https://huggingface.co/ggerganov/whisper.cpp',
  libraryEntry:
    'build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework/Versions/A/whisper',
  libraryBytes: 5891952,
  librarySha256: 'a4ab6c57b7f3182a0da39e1874a927a92eed36eb81a620dfa76a8ebb99e8069b',
  artifacts: [
    {
      name: 'whisper.zip',
      bytes: 53575921,
      sha256: 'af74fed13ea7f2d5ca2a39d9f58ec177713fafd7cab63aef4e27b79f3ceca80b',
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-v1.9.2-xcframework.zip',
    },
    {
      name: 'model.bin',
      bytes: 147951465,
      sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin',
    },
  ],
});
