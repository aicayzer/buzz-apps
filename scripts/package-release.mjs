import { createHash } from 'node:crypto';
import { log } from 'node:console';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
mkdirSync('release', { recursive: true });
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', 'release'], {
    encoding: 'utf8',
  }),
);
const name = packed[0].filename;
writeFileSync(
  'release/SHA256SUMS',
  `${createHash('sha256')
    .update(readFileSync(`release/${name}`))
    .digest('hex')}  ${name}\n`,
);
log(`release/${name}`);
