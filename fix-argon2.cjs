// Makes `import 'argon2'` use the prebuilt @node-rs/argon2 (no C++ compiler needed).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'node_modules', 'argon2');
fs.writeFileSync(path.join(dir, 'shim.cjs'), "module.exports = require('@node-rs/argon2');\n");

const pkgPath = path.join(dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.main = 'shim.cjs';
delete pkg.exports;
delete pkg.module;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

console.log('argon2 shim installed');