import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");
const runtimeDir = path.join(root, "src-tauri", "desktop-runtime");
const runtimeStaticDir = path.join(runtimeDir, ".next", "static");
const runtimePublicDir = path.join(runtimeDir, "public");
const bundledNodePath = path.join(root, "src-tauri", "bin", "node.exe");
const sourceNodePath = process.env.NODE_BINARY_PATH || "C:/Program Files/nodejs/node.exe";

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function resetDirectory(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

ensureExists(standaloneDir, "Next standalone output");
ensureExists(staticDir, "Next static output");
ensureExists(publicDir, "Public assets");
ensureExists(sourceNodePath, "Node runtime");

resetDirectory(runtimeDir);
copyDirectory(standaloneDir, runtimeDir);
copyDirectory(staticDir, runtimeStaticDir);
copyDirectory(publicDir, runtimePublicDir);
copyFile(sourceNodePath, bundledNodePath);

console.log(`Prepared desktop runtime at: ${runtimeDir}`);
console.log(`Bundled Node executable: ${bundledNodePath}`);
