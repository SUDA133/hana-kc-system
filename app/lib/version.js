// The installed package manifest is the only runtime version source.
import fs from 'node:fs';
const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
if(manifest.id!=='kc-system'||typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))throw new Error('Invalid KC package version');
export const APP_VERSION=manifest.version;
