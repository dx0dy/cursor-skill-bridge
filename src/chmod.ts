export interface ChmodPayload {
  scriptPath: string;
  listPath: string;
  statusPath: string;
  script: string;
  listText: string;
  paths: string[];
  rejected: string[];
}

const TEMP_PATH = /^\/tmp\/cursor-skill-bridge-[a-f0-9]+\.(?:sh|txt|status|status\.err|home)$/;

export function isBridgeTempPath(value: string): boolean {
  return TEMP_PATH.test(value);
}

export function buildChmodPayload(candidates: string[], containerHome: string, nonce: string): ChmodPayload {
  const home = containerHome.replace(/\/+$/, '');
  const paths: string[] = [];
  const rejected: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.includes('\n') || candidate.includes('\0')) {
      rejected.push(`newline: ${candidate.split('\n')[0] ?? ''}`);
      continue;
    }
    if (candidate !== home && !candidate.startsWith(`${home}/`)) {
      rejected.push(candidate);
      continue;
    }
    paths.push(candidate);
  }
  const scriptPath = `/tmp/cursor-skill-bridge-${nonce}.sh`;
  const listPath = `/tmp/cursor-skill-bridge-${nonce}.txt`;
  const statusPath = `/tmp/cursor-skill-bridge-${nonce}.status`;
  const script = `#!/bin/sh
home=$1
list=${listPath}
status=${statusPath}
err=${statusPath}.err
: > "$err"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    "$home"|"$home"/*)
      chmod a+x -- "$file" || echo "$file" >> "$err"
      ;;
    *)
      echo "$file" >> "$err"
      ;;
  esac
done < "$list"
if [ -s "$err" ]; then
  echo fail > "$status"
  exit 1
fi
echo ok > "$status"
`;
  return {
    scriptPath,
    listPath,
    statusPath,
    script,
    listText: paths.length ? `${paths.join('\n')}\n` : '',
    paths,
    rejected,
  };
}
