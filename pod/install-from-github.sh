#!/bin/bash
# Usage: bash install-from-github.sh https://github.com/OWNER/REPO [branch]
set -euo pipefail
repo="${1:?Pass https://github.com/OWNER/REPO}"
branch="${2:-main}"
repo="${repo%/}";repo="${repo%.git}"
if [[ ! "$repo" =~ ^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then echo 'Invalid GitHub repository URL';exit 1;fi
owner="${BASH_REMATCH[1]}";name="${BASH_REMATCH[2]}"
if [[ ! "$branch" =~ ^[A-Za-z0-9_.-]+$ ]];then echo 'Invalid branch';exit 1;fi
curl -fL --retry 3 "https://codeload.github.com/$owner/$name/tar.gz/refs/heads/$branch" -o /workspace/krea-studio-source.tar.gz
python3 - <<'PY'
import pathlib,tarfile
target=pathlib.Path('/workspace/krea-studio');target.mkdir(exist_ok=True)
with tarfile.open('/workspace/krea-studio-source.tar.gz') as archive:
 for member in archive.getmembers():
  parts=pathlib.PurePosixPath(member.name).parts[1:]
  if not parts:continue
  if any(x in ('.','..') for x in parts) or member.issym() or member.islnk():raise SystemExit('Unsafe archive')
  dest=target.joinpath(*parts)
  if not dest.resolve().is_relative_to(target.resolve()):raise SystemExit('Unsafe path')
  if member.isdir():dest.mkdir(exist_ok=True,parents=True)
  elif member.isfile():
   dest.parent.mkdir(exist_ok=True,parents=True)
   with archive.extractfile(member) as f:dest.write_bytes(f.read())
PY
bash /workspace/krea-studio/pod/install.sh
