from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
destination = root / 'dist' / 'kc-system-1.0.0-source.zip'
destination.parent.mkdir(exist_ok=True)
roots = ['app', 'tests', 'scripts', 'docs']
files = [root / name for name in ['README.md', 'LICENSE', 'NOTICE', 'package.json', '.gitignore']]
for name in roots:
    files.extend(p for p in (root / name).rglob('*') if p.is_file())
for p in files:
    relative = p.relative_to(root)
    if p.is_symlink() or p.suffix in ('.jsonl', '.log', '.map', '.zip') or any(part.startswith('.fixture-') for part in relative.parts):
        raise RuntimeError('Unexpected source entry: ' + relative.as_posix())
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in sorted(files):
        archive.write(p, Path('hana-kc-system-1.0.0') / p.relative_to(root))
print(f'Source archive: {destination.name} ({len(files)} files)')
