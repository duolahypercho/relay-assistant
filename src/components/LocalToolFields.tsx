import { useState } from 'react';
import { X } from '@phosphor-icons/react';
export type LocalLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
  envKeys?: string[];
};
export default function LocalToolFields({
  launch,
  onChange,
  openComputer,
}: {
  launch: LocalLaunch;
  onChange: (launch: LocalLaunch) => void;
  openComputer: () => void;
}) {
  const [key, setKey] = useState('');
  function program(patch: Partial<LocalLaunch>) {
    onChange({
      ...launch,
      ...patch,
      env: Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== null)),
    });
  }
  return (
    <>
      <p className="field-help local-tool-notice">
        This program runs in Relay’s computer and can read or change its files as soon as it starts.
        Use code you trust. It has no direct internet access.
      </p>
      <label>
        Program
        <input
          value={launch.command}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="python3"
          onChange={(e) => program({ command: e.target.value })}
        />
      </label>
      <label>
        Arguments
        <textarea
          aria-label="Arguments"
          value={launch.args.join('\n')}
          rows={3}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="/workspace/tools/my-tool.py"
          onChange={(e) => program({ args: e.target.value ? e.target.value.split('\n') : [] })}
        />
      </label>
      <p className="field-help">
        One argument per line. The program and files must already be installed in Relay’s computer.
      </p>
      <details className="app-advanced">
        <summary>Folder and environment</summary>
        <label>
          Working folder
          <input
            value={launch.cwd}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => program({ cwd: e.target.value })}
          />
        </label>
        <p className="field-help">
          Environment values are encrypted on your Relay server. Saved values must be entered again
          if you change the program, arguments or folder.
        </p>
        {Object.entries(launch.env).map(([name, value]) => (
          <div className="local-tool-variable" key={name}>
            <label>
              {name}
              <input
                aria-label={`Value for ${name}`}
                type="password"
                autoComplete="new-password"
                value={value ?? ''}
                placeholder={value === null ? 'Saved value' : ''}
                onChange={(e) =>
                  onChange({ ...launch, env: { ...launch.env, [name]: e.target.value } })
                }
              />
            </label>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${name}`}
              onClick={() =>
                onChange({
                  ...launch,
                  env: Object.fromEntries(Object.entries(launch.env).filter(([k]) => k !== name)),
                })
              }
            >
              <X size={18} />
            </button>
          </div>
        ))}
        <div className="local-tool-variable">
          <label>
            Variable name
            <input
              value={key}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="API_KEY"
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={
              !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key) ||
              Object.hasOwn(launch.env, key) ||
              Object.keys(launch.env).length >= 32
            }
            onClick={() => {
              onChange({ ...launch, env: { ...launch.env, [key]: '' } });
              setKey('');
            }}
          >
            Add variable
          </button>
        </div>
      </details>
      <button type="button" className="text-button local-tool-computer" onClick={openComputer}>
        Open computer
      </button>
    </>
  );
}
