from pathlib import Path
import argparse, shutil, subprocess

parser=argparse.ArgumentParser(description='Stage KC System and invoke the official Hana App packer.')
parser.add_argument('--creator', required=True, type=Path, help='Directory of the installed official hana-app-creator skill')
parser.add_argument('--publisher', default='SUDA133')
args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
source=root/'app'
build=root/'build'/'kc-system'
build.mkdir(parents=True, exist_ok=True)
# Refuse a stale build rather than silently carrying extra runtime data into an archive.
if any(build.iterdir()):
    raise SystemExit('build/kc-system must be empty. Move the prior build aside before packaging.')
shutil.copytree(source, build, dirs_exist_ok=True)
subprocess.run(['node', str(args.creator/'scripts'/'pack_app.mjs'), '--dir', str(build), '--publisher', args.publisher, '--out', str(root/'dist')], check=True)
