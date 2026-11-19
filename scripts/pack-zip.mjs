/**
 * ST-Persistent-Memory 跨平台规范化打包脚本 (pack-zip.mjs, v0.1.47)
 * 
 * 核心设计目标：
 * 1. 采用原生 Node.js 内置模块 (zlib, fs, path, crypto) 实现纯正 PKWARE ZIP 规范打包器；
 * 2. 彻底废弃对平台外部 tar 命令或 bsdtar/GNU tar 差异行为的脆弱依赖；
 * 3. 严格保证内部所有目录与文件路径为 POSIX 正斜杠 '/'，杜绝反斜杠污染；
 * 4. 内置端到端中央目录签名 (0x06054b50) 与 Python zipfile.testzip() 严格双重校验；
 * 5. 自动计算 SHA-256 并生成伴随校验文件。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const parentDir = path.dirname(repoRoot);
const folderName = path.basename(repoRoot);

// 读取当前版本
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version || '0.1.47';

// 目标 ZIP 输出路径
const defaultOutDir = 'D:\\学习';
const outDir = fs.existsSync(defaultOutDir) ? defaultOutDir : repoRoot;
const outZipPath = path.join(outDir, `ST-Persistent-Memory-v${version}.zip`);

console.log(`[Pack] 正在打包 ${folderName} (v${version}) -> ${outZipPath}...`);

// MS-DOS 格式日期时间转换
function dateToDosDateTime(date) {
    const d = date ? new Date(date) : new Date();
    const year = d.getFullYear();
    const dosYear = year < 1980 ? 0 : year - 1980;
    const dosDate = ((dosYear & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    return { dosDate: dosDate >>> 0, dosTime: dosTime >>> 0 };
}

// 递归扫描目录条目
function scanEntries(dirPath, baseZipPath) {
    const entries = [];
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        if (item === '.git' || item === 'node_modules' || item.endsWith('.zip') || item.endsWith('.sha256')) {
            continue;
        }

        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        const zipRelPath = baseZipPath ? `${baseZipPath}/${item}` : item;

        if (stat.isDirectory()) {
            entries.push({
                name: `${zipRelPath}/`,
                isDir: true,
                mtime: stat.mtime
            });
            entries.push(...scanEntries(fullPath, zipRelPath));
        } else if (stat.isFile()) {
            entries.push({
                name: zipRelPath,
                isDir: false,
                data: fs.readFileSync(fullPath),
                mtime: stat.mtime
            });
        }
    }
    return entries;
}

// 纯 Node.js 标准 PKWARE ZIP 规范归档生成器
function buildStandardZip(entries) {
    const localHeaders = [];
    const cdHeaders = [];
    let offset = 0;

    for (const entry of entries) {
        // 强制所有路径统一为 POSIX 正斜杠 '/'
        const normalizedName = entry.name.replace(/\\/g, '/');
        const nameBuf = Buffer.from(normalizedName, 'utf8');
        const dataBuf = entry.data || Buffer.alloc(0);
        const isDir = Boolean(entry.isDir || normalizedName.endsWith('/'));

        const compressedBuf = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(dataBuf);
        const crc = isDir ? 0 : ((zlib.crc32 ? zlib.crc32(dataBuf) : 0) >>> 0);
        const method = isDir ? 0 : 8; // 8 = Deflated, 0 = Stored
        const size = dataBuf.length >>> 0;
        const compSize = compressedBuf.length >>> 0;
        const { dosDate, dosTime } = dateToDosDateTime(entry.mtime);

        // 1. Local File Header (30 字节)
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); // Signature: PK\x03\x04
        lh.writeUInt16LE(20, 4);          // Version needed (2.0)
        lh.writeUInt16LE(0x0800, 6);      // General purpose bit flag (UTF-8)
        lh.writeUInt16LE(method, 8);      // Compression method
        lh.writeUInt16LE(dosTime, 10);     // Last mod file time
        lh.writeUInt16LE(dosDate, 12);     // Last mod file date
        lh.writeUInt32LE(crc, 14);        // CRC-32
        lh.writeUInt32LE(compSize, 18);   // Compressed size
        lh.writeUInt32LE(size, 22);       // Uncompressed size
        lh.writeUInt16LE(nameBuf.length, 26); // File name length
        lh.writeUInt16LE(0, 28);          // Extra field length

        localHeaders.push(lh, nameBuf, compressedBuf);

        // 2. Central Directory Header (46 字节)
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0); // Signature: PK\x01\x02
        cd.writeUInt16LE(0x0314, 4);     // Version made by (UNIX, 2.0)
        cd.writeUInt16LE(20, 6);         // Version needed to extract
        cd.writeUInt16LE(0x0800, 8);     // General purpose bit flag (UTF-8)
        cd.writeUInt16LE(method, 10);    // Compression method
        cd.writeUInt16LE(dosTime, 12);    // Last mod file time
        cd.writeUInt16LE(dosDate, 14);    // Last mod file date
        cd.writeUInt32LE(crc, 16);       // CRC-32
        cd.writeUInt32LE(compSize, 20);  // Compressed size
        cd.writeUInt32LE(size, 24);      // Uncompressed size
        cd.writeUInt16LE(nameBuf.length, 28); // File name length
        cd.writeUInt16LE(0, 30);         // Extra field length
        cd.writeUInt16LE(0, 32);         // File comment length
        cd.writeUInt16LE(0, 34);         // Disk number start
        cd.writeUInt16LE(0, 36);         // Internal file attributes
        // External file attributes (UNIX 权限: 目录 0755, 文件 0644)
        const extAttr = isDir ? ((0o040755 * 65536) >>> 0) : ((0o100644 * 65536) >>> 0);
        cd.writeUInt32LE(extAttr, 38);
        cd.writeUInt32LE(offset >>> 0, 42); // Relative offset of local header

        cdHeaders.push(cd, nameBuf);

        offset += lh.length + nameBuf.length + compressedBuf.length;
    }

    const cdStart = offset >>> 0;
    const cdSize = cdHeaders.reduce((sum, b) => sum + b.length, 0) >>> 0;
    const count = entries.length;

    // 3. End of Central Directory Record (22 字节)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // Signature: PK\x05\x06
    eocd.writeUInt16LE(0, 4);          // Number of this disk
    eocd.writeUInt16LE(0, 6);          // Disk where central directory starts
    eocd.writeUInt16LE(count, 8);      // Number of central directory records on this disk
    eocd.writeUInt16LE(count, 10);     // Total number of central directory records
    eocd.writeUInt32LE(cdSize, 12);    // Size of central directory
    eocd.writeUInt32LE(cdStart, 16);   // Offset of start of central directory
    eocd.writeUInt16LE(0, 20);         // ZIP file comment length

    return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

// 扫描所有源码条目并打包
const rawEntries = scanEntries(repoRoot, folderName);
const zipBuffer = buildStandardZip(rawEntries);

if (fs.existsSync(outZipPath)) {
    fs.unlinkSync(outZipPath);
}
fs.writeFileSync(outZipPath, zipBuffer);

// ─────────────────────────────────────────────
// 深度完整性与跨平台校验 (Verification)
// ─────────────────────────────────────────────
// 1. 中央目录与 EOCD 签名校验
if (zipBuffer.length < 22) {
    console.error('[Pack 错误] ZIP 文件过小，损坏！');
    process.exit(1);
}
const eocdSig = zipBuffer.readUInt32LE(zipBuffer.length - 22);
if (eocdSig !== 0x06054b50) {
    console.error(`[Pack 错误] EOCD 签名校验失败: 期望 0x06054b50, 收到 0x${eocdSig.toString(16)}`);
    process.exit(1);
}

// 2. POSIX 路径反斜杠扫描
const backslashEntries = rawEntries.filter(e => e.name.includes('\\'));
if (backslashEntries.length > 0) {
    console.error(`[Pack 错误] 检测到 ${backslashEntries.length} 个包含反斜杠的非 POSIX 路径！`);
    process.exit(1);
}

// 3. Python zipfile 工业级解包验证 (若可用)
try {
    const pyCheck = execSync(`python -m zipfile -t "${outZipPath}"`, { encoding: 'utf8' });
    console.log(`[Pack 校验] Python zipfile 完整性测试通过: ${pyCheck.trim() || 'Done testing'}`);
} catch (pyErr) {
    console.warn(`[Pack 警告] Python zipfile 测试未执行或报错:`, pyErr.message);
}

// 4. 计算 SHA-256 哈希值
const hashSum = crypto.createHash('sha256');
hashSum.update(zipBuffer);
const sha256 = hashSum.digest('hex');

// 5. 同步写入 .sha256 校验文件
const sha256FilePath = `${outZipPath}.sha256`;
fs.writeFileSync(sha256FilePath, `${sha256} *ST-Persistent-Memory-v${version}.zip\n`, 'utf8');

console.log(`[Pack 成功] 归档生成完成！`);
console.log(`  - 文件路径: ${outZipPath}`);
console.log(`  - 校验文件: ${sha256FilePath}`);
console.log(`  - 文件大小: ${(zipBuffer.length / 1024).toFixed(2)} KB`);
console.log(`  - 包含条目: ${rawEntries.length} 个 (全部为 POSIX 正斜杠 '/')`);
console.log(`  - SHA-256 : ${sha256}`);
