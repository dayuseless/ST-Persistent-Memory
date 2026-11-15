/**
 * ST-Persistent-Memory 跨平台规范化打包脚本 (pack-zip.mjs)
 * 严格遵循 POSIX 正斜杠 '/' 规范打包 ZIP，确保 Linux / macOS 解压不损坏目录结构
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const parentDir = path.dirname(repoRoot);
const folderName = path.basename(repoRoot);

// 读取当前版本
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version || '0.1.44';

// 目标 ZIP 输出路径
const defaultOutDir = 'D:\\学习';
const outDir = fs.existsSync(defaultOutDir) ? defaultOutDir : repoRoot;
const outZipPath = path.join(outDir, `ST-Persistent-Memory-v${version}.zip`);

console.log(`[Pack] 正在打包 ${folderName} (v${version}) -> ${outZipPath}...`);

if (fs.existsSync(outZipPath)) {
    fs.unlinkSync(outZipPath);
}

// 使用跨平台 tar 命令行打包为 zip，原生保证内部条目为 POSIX 正斜杠 '/'
const cmd = `tar -a -cf "${outZipPath}" -C "${parentDir}" --exclude=".git" --exclude=".git/*" --exclude="*.zip" "${folderName}"`;
execSync(cmd, { stdio: 'inherit' });

// 校验归档内部路径规范性
const listOutput = execSync(`tar -tf "${outZipPath}"`, { encoding: 'utf8' });
const entries = listOutput.split(/\r?\n/).filter(Boolean);
const backslashEntries = entries.filter(e => e.includes('\\'));

if (backslashEntries.length > 0) {
    console.error(`[Pack 错误] 检测到 ${backslashEntries.length} 个包含反斜杠的非 POSIX 路径！`);
    process.exit(1);
}

// 计算 SHA-256 哈希值
const fileBuffer = fs.readFileSync(outZipPath);
const hashSum = crypto.createHash('sha256');
hashSum.update(fileBuffer);
const sha256 = hashSum.digest('hex');

// 同步写入 .sha256 校验文件
const sha256FilePath = `${outZipPath}.sha256`;
fs.writeFileSync(sha256FilePath, `${sha256} *ST-Persistent-Memory-v${version}.zip\n`, 'utf8');

console.log(`[Pack 成功] 归档生成完成！`);
console.log(`  - 文件路径: ${outZipPath}`);
console.log(`  - 校验文件: ${sha256FilePath}`);
console.log(`  - 文件大小: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
console.log(`  - 包含条目: ${entries.length} 个 (全部为 POSIX 正斜杠 '/')`);
console.log(`  - SHA-256 : ${sha256}`);
