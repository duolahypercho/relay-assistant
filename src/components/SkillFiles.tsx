import { skillFileText, skillBytes } from '../../shared/skill-package.mjs';
type SkillFile = { path: string; base64: string };
export default function SkillFiles({
  files,
  onChange,
}: {
  files: SkillFile[];
  onChange?: (files: SkillFile[]) => void;
}) {
  if (!files.length) return null;
  return (
    <details className="skill-package-files skill-method">
      <summary aria-label={`${files.length} supporting ${files.length === 1 ? 'file' : 'files'}`}>
        {`${files.length} supporting ${files.length === 1 ? 'file' : 'files'}`}
      </summary>
      <p className="form-note">
        References, templates and scripts travel with this skill. Open a file to inspect it.
      </p>
      {files.map((file) => {
        const text = skillFileText(file);
        return (
          <details className="skill-method" key={file.path}>
            <summary
              aria-label={`${file.path} (${skillBytes(file.base64).length.toLocaleString()} bytes)`}
            >
              {file.path} <small>({skillBytes(file.base64).length.toLocaleString()} bytes)</small>
            </summary>
            {text === null ? (
              <p>Binary asset. Its original bytes are included in the package.</p>
            ) : (
              <pre className="skill-source-preview">{text}</pre>
            )}
            {onChange && (
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(files.filter((f) => f.path !== file.path))}
              >
                Remove {file.path}
              </button>
            )}
          </details>
        );
      })}
    </details>
  );
}
