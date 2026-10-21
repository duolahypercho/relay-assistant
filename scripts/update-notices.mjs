// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';

const root = resolve('.');
const result = spawnSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], { encoding: 'utf8' });
if (result.error) throw result.error;
const nativeRuntimePackages = ['@capacitor/ios', '@capacitor/android', 'electron'];
const paths = [
  ...new Set([
    ...result.stdout.trim().split('\n'),
    ...nativeRuntimePackages.map((name) => resolve(root, 'node_modules', name)),
  ]),
].filter((path) => path.includes('/node_modules/'));
const notices = resolve(root, 'third-party-licenses');
await mkdir(notices, { recursive: true });
const entries = [];
for (const path of paths) {
  const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = (await readdir(path, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /^(license|licence|copying|ofl|notice)(\.|$)/i.test(entry.name),
  );
  const dir = pkg.name.replaceAll('/', '__').replaceAll('@', '') + '-' + pkg.version;
  await mkdir(join(notices, dir), { recursive: true });
  for (const file of files)
    await copyFile(join(path, file.name), join(notices, dir, basename(file.name)));
  entries.push({
    name: pkg.name,
    version: pkg.version,
    license:
      typeof pkg.license === 'string'
        ? pkg.license
        : JSON.stringify(pkg.license || pkg.licenses || 'See package'),
    files: files.map((file) => `third-party-licenses/${dir}/${file.name}`),
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));
const table = entries
  .map(
    (p) =>
      `| ${p.name} | ${p.version} | ${p.license} | ${p.files.map((file, i) => `[${i === 0 ? 'License' : 'Notice'}](${file})`).join(', ') || 'License identified by package metadata'} |`,
  )
  .join('\n');
await writeFile(
  join(root, 'THIRD_PARTY_NOTICES.md'),
  `# Third-party notices\n\nRelay's own code is MIT licensed. General-purpose dependencies retain their own licenses. This list is generated from the installed production dependency tree and native runtimes; copied license/notice files accompany it. Development tools are recorded in package-lock.json and retain their package licenses. Electron distributions also include their upstream Chromium notices.\n\nDM Sans and Manrope font files are supplied through Fontsource and licensed under the SIL Open Font License. Their full notices are included below. Phosphor icons are a general-purpose MIT library. No competitor mascot, logo, screenshot, artwork, or code is a Relay product dependency.\n\nThe optional computer image also installs Debian system packages independently of this npm list. Their package copyright/license records remain at \`/usr/share/doc/<package>/copyright\` inside the image, including xclip for owner-requested plain-text clipboard transfer, LibreOffice and python-docx for document editing, Poppler utilities, and the Carlito/Caladea fonts. These are separate general-purpose programs; building Relay does not relabel their licenses as MIT.\n\nThe optional local-AI installer downloads an official Ollama runtime separately from Relay. Ollama and its bundled components retain their upstream licenses; archive license/notice files remain in the private runtime folder. See [Ollama releases](https://github.com/ollama/ollama/releases) and [installation details](docs/LOCAL_MODEL_INSTALLATION.md). Relay does not relabel that runtime as its own source.\n\nThe optional private-computer installer downloads Colima, Lima, Docker CLI and Buildx as separate general-purpose programs. Their upstream licenses remain applicable; Lima includes its notices in the runtime archive, and additional notices are saved under third-party-licenses/optional-computer. See [private computer installation](docs/COMPUTER_INSTALLATION.md). Relay does not relabel these programs or Linux packages as its own MIT source.\n\nThe Linux application image includes only Docker CLI 29.8.2 from its pinned official image, for an optional mutually authenticated connection to a separate computer VM. It includes no Docker daemon or application-host socket. Docker CLI retains its Apache-2.0 license; see [the full notice](third-party-licenses/optional-computer/docker-cli-29.8.2-LICENSE) and [remote computer setup](docs/REMOTE_COMPUTER.md).\n\nLocal listening uses pinned whisper.cpp/ggml and Whisper Base weights under their upstream MIT licenses. The Mac setup downloads the runtime and model separately and uses Relay's original dynamically loaded bridge. The Linux server image includes that original bridge statically linked to the upstream CPU engine; its model downloads only when requested. Full notices are included at [whisper.cpp](third-party-licenses/optional-listening/whisper.cpp-LICENSE) and [Whisper](third-party-licenses/optional-listening/Whisper-LICENSE), and copied into each completed runtime installation. The Linux bundle also includes the upstream engine license. See [local listening](docs/LOCAL_LISTENING.md).\n\n| Package | Installed version | License | Full notice |\n| --- | --- | --- | --- |\n${table}\n`,
);
await writeFile(join(notices, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n');
console.log(
  `Recorded ${entries.length} production dependencies/native runtimes and their available license files.`,
);
