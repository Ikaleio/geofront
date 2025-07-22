import { execSync } from 'child_process';
import { rmSync, mkdirSync, copyFileSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';

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
const crateName = 'geofront';
let libFileName;
switch (platform()) {
    case 'darwin':
        libFileName = `lib${crateName}.dylib`;
        break;
    case 'win32':
        libFileName = `${crateName}.dll`;
        break;
    default:
        libFileName = `lib${crateName}.so`;
        break;
}

const srcLibPath = join('target', 'release', libFileName);
const destLibPath = join(distDir, libFileName);

try {
    copyFileSync(srcLibPath, destLibPath);
    console.log(`Copied ${libFileName} to ${distDir}`);
} catch (error) {
    console.error(`Failed to copy native library:`, error);
    process.exit(1);
}

// 4. Bundle TypeScript source files with Bun
console.log('Bundling TypeScript files with Bun...');
const result = await Bun.build({
    entrypoints: ['src/geofront.ts'],
    outdir: './dist',
    target: 'bun',
    splitting: true,
    sourcemap: 'external',
    minify: true,
});

if (!result.success) {
    console.error('Bun build failed:');
    for (const message of result.logs) {
        console.error(message);
    }
    process.exit(1);
}

console.log('Bun build completed successfully!');

// 5. Generate TypeScript declaration files
try {
    console.log('Generating TypeScript declaration files...');
    execSync('bunx tsc', { stdio: 'inherit' });
    console.log('TypeScript declaration files generated successfully.');
} catch (error) {
    console.error('Failed to generate TypeScript declaration files:', error);
    process.exit(1);
}

console.log('Build process completed successfully!');