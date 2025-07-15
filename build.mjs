import { execSync } from 'child_process';
import { rmSync, mkdirSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';
import cpr from 'cpr';

console.log('Starting build process...');

// 1. Clean up previous build
const distDir = 'dist';
try {
    rmSync(distDir, { recursive: true, force: true });
    console.log('Cleaned up dist directory.');
} catch (error) {
    console.log('Dist directory does not exist, skipping cleanup.');
}
mkdirSync(distDir);
console.log('Created dist directory.');

// 2. Compile Rust code
try {
    console.log('Compiling Rust code...');
    execSync('cargo build --release', { stdio: 'inherit' });
    console.log('Rust code compiled successfully.');
} catch (error) {
    console.error('Failed to compile Rust code:', error);
    process.exit(1);
}

// 3. Copy native library
const libName = 'libgeofront';
let libFileName;
switch (platform()) {
    case 'darwin':
        libFileName = `${libName}.dylib`;
        break;
    case 'win32':
        libFileName = `${libName}.dll`;
        break;
    default:
        libFileName = `${libName}.so`;
        break;
}

const srcLibPath = join('target', 'release', libFileName);
const destLibPath = join(distDir, libFileName);

try {
    cpr(srcLibPath, destLibPath, { overwrite: true }, (err) => {
        if (err) {
            throw err;
        }
        console.log(`Copied ${libFileName} to ${distDir}`);
    });
} catch (error) {
    console.error(`Failed to copy native library:`, error);
    process.exit(1);
}


// 4. Copy TypeScript source files
try {
    cpr('src', join(distDir, 'src'), { overwrite: true }, (err) => {
        if (err) {
            throw err;
        }
        console.log(`Copied src files to ${distDir}`);
    });
} catch (error) {
    console.error('Failed to copy TypeScript files:', error);
    process.exit(1);
}

console.log('Build process completed successfully!');