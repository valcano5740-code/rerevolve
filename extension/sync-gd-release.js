const fs = require('fs');
const path = require('path');

const pkg = require('./package.json');

const userProfile = process.env.USERPROFILE || process.env.HOME;
if (!userProfile) {
  console.warn('ReRevolve GD sync skipped: USERPROFILE/HOME is not set.');
  process.exit(0);
}

const fileName = `${pkg.name}-${pkg.version}.vsix`;
const source = path.join(__dirname, fileName);
const destinationDir = path.join(userProfile, 'Desktop', 'GD', 'Antigravity_Shared', 'ReRevolve');
const destination = path.join(destinationDir, fileName);

if (!fs.existsSync(source)) {
  console.warn(`ReRevolve GD sync skipped: ${fileName} not found.`);
  process.exit(0);
}

fs.mkdirSync(destinationDir, { recursive: true });
fs.copyFileSync(source, destination);

const size = fs.statSync(destination).size;
console.log(`ReRevolve GD sync complete: ${destination} (${size} bytes)`);