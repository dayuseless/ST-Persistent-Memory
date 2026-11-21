/**
 * ST-Persistent-Memory 跨平台规范化打包脚本 (pack-zip.mjs, v0.1.49)
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

// MS-DOS 格式日期时间转换
function dateToDosDateTime(date) {
    const d = date ? new Date(date) : new Date();
    const year = d.getFullYear();
    const dosYear = year < 1980 ? 0 : year - 1980;
    const dosDate = ((dosYear & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
    return { dosDate: dosDate >>> 0, dosTime: dosTime >>> 0 };
}

// 递归扫描目录条目 (改用 lstatSync 防御符号链接逃逸，P2 修复)
export function scanEntries(dirPath, baseZipPath) {
    const entries = [];
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        if (item === '.git' || item === 'node_modules' || item.endsWith('.zip') || item.endsWith('.sha256')) {
            continue;
        }

        const fullPath = path.join(dirPath, item);
        const stat = fs.lstatSync(fullPath);
        const zipRelPath = baseZipPath ? `${baseZipPath}/${item}` : item;

        // P2 防护：明确拒绝或跳过符号链接，避免仓库出现链接时打包非受信外部文件
        if (stat.isSymbolicLink()) {
            console.warn(`[Pack 忽略] 检测到符号链接，主动跳过以防外部越界引用: ${fullPath}`);
            continue;
        }

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

// 标准 IEEE 802.3 CRC-32 预计算查找表 (用于 zlib.crc32 不存在时的跨环境安全回退，P2-04)
export const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c >>> 0;
}

/**
 * 计算 Buffer 的 CRC-32 校验和 (P2-04 修复)
 * @param {Buffer|string} buf 
 * @param {boolean} forceFallback 是否强制使用纯 JS 查表算法
 * @returns {number} 32 位无符号整数
 */
export function calculateCrc32(buf, forceFallback = false) {
    if (!forceFallback && typeof zlib.crc32 === 'function') {
        return zlib.crc32(buf) >>> 0;
    }
    let crc = 0xFFFFFFFF;
    const target = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
    for (let i = 0; i < target.length; i++) {
        crc = CRC32_TABLE[(crc ^ target[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 经典 PKWARE ZIP 规范容量与偏移量物理上限 (P2 边界安全防护)
export const MAX_CLASSIC_ZIP_ENTRIES = 65535;
export const MAX_CLASSIC_ZIP_SIZE = 0xFFFFFFFF; // 4 GiB - 1 字节 (4294967295)

// 纯 Node.js 标准 PKWARE ZIP 规范归档生成器
export function buildStandardZip(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('[Pack 错误] entries 必须为数组');
    }
    if (entries.length > MAX_CLASSIC_ZIP_ENTRIES) {
        throw new Error(`[Pack 错误] 归档条目总数 (${entries.length}) 超出经典 ZIP 格式上限 (${MAX_CLASSIC_ZIP_ENTRIES})，拒绝生成损坏归档`);
    }

    const localHeaders = [];
    const cdHeaders = [];
    let offset = 0;

    for (const entry of entries) {
        // 强制所有路径统一为 POSIX 正斜杠 '/'
        const normalizedName = entry.name.replace(/\\/g, '/');
        const nameBuf = Buffer.from(normalizedName, 'utf8');
        const dataBuf = entry.data || Buffer.alloc(0);
        const isDir = Boolean(entry.isDir || normalizedName.endsWith('/'));

        if (dataBuf.length > MAX_CLASSIC_ZIP_SIZE) {
            throw new Error(`[Pack 错误] 单文件 "${normalizedName}" 原始大小 (${dataBuf.length}) 超出经典 ZIP 4 GiB 上限`);
        }

        const compressedBuf = isDir ? Buffer.alloc(0) : zlib.deflateRawSync(dataBuf);
        if (compressedBuf.length > MAX_CLASSIC_ZIP_SIZE) {
            throw new Error(`[Pack 错误] 单文件 "${normalizedName}" 压缩后大小 (${compressedBuf.length}) 超出经典 ZIP 4 GiB 上限`);
        }

        if (offset > MAX_CLASSIC_ZIP_SIZE) {
            throw new Error(`[Pack 错误] 归档内部局部头偏移量 (${offset}) 超出经典 ZIP 4 GiB 上限`);
        }

        const crc = isDir ? 0 : calculateCrc32(dataBuf);
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

    if (offset > MAX_CLASSIC_ZIP_SIZE) {
        throw new Error(`[Pack 错误] 中央目录起始偏移量 (${offset}) 超出经典 ZIP 4 GiB 上限`);
    }
    if (cdSize > MAX_CLASSIC_ZIP_SIZE) {
        throw new Error(`[Pack 错误] 中央目录总大小 (${cdSize}) 超出经典 ZIP 4 GiB 上限`);
    }

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

export function runPack(customOutDir = null) {
    // 读取当前版本
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const version = pkg.version || '0.1.49';

    // 目标 ZIP 输出路径
    const defaultOutDir = 'D:\\学习';
    const outDir = customOutDir || (fs.existsSync(defaultOutDir) ? defaultOutDir : repoRoot);
    const outZipPath = path.join(outDir, `ST-Persistent-Memory-v${version}.zip`);

    console.log(`[Pack] 正在打包 ${folderName} (v${version}) -> ${outZipPath}...`);

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

    // 3. Python zipfile 工业级解包验证 (若可用，P2-04 修复)
    let pythonAvailable = false;
    try {
        execSync('python --version', { stdio: 'ignore' });
        pythonAvailable = true;
    } catch {}

    if (pythonAvailable) {
        try {
            const pyCheck = execSync(`python -m zipfile -t "${outZipPath}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            console.log(`[Pack 校验] Python zipfile 完整性测试通过: ${pyCheck.trim() || 'Done testing'}`);
        } catch (pyErr) {
            console.error(`[Pack 错误] Python zipfile 校验失败 (压缩包损坏或校验和不匹配):`, pyErr.stderr || pyErr.message);
            process.exit(1);
        }
    } else {
        console.log(`[Pack 校验] 未检测到 Python 环境，跳过 python -m zipfile -t 深度校验`);
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

    return { outZipPath, sha256FilePath, sha256, zipBuffer, entriesCount: rawEntries.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
    runPack();
}


