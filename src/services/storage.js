/**
 * Storage — S3 / MinIO 对象存储封装
 *
 * 设计目标:
 * - 本地用 MinIO 容器 (docker run -p 9000:9000 minio/minio server /data)
 * - 未来无缝切到真实 AWS S3 / 阿里云 OSS(都是 S3 协议)
 * - 上传成片后返回带时效签名的下载 URL(默认 7 天)
 * - 支持按 brand_id / date 分桶路径
 *
 * 环境变量:
 *   ZDE_S3_ENDPOINT       默认 http://localhost:9000
 *   ZDE_S3_REGION         默认 us-east-1
 *   ZDE_S3_ACCESS_KEY     默认 minioadmin
 *   ZDE_S3_SECRET_KEY     默认 minioadmin123
 *   ZDE_S3_BUCKET         默认 echocut-output
 *   ZDE_S3_FORCE_PATH     默认 '1' (MinIO 必须 path-style)
 *   ZDE_S3_URL_TTL_SEC    默认 604800 (7 天)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    S3Client,
    PutObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand,
    ListObjectsV2Command,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getConfig() {
    return {
        endpoint: process.env.ZDE_S3_ENDPOINT || 'http://localhost:9000',
        region: process.env.ZDE_S3_REGION || 'us-east-1',
        accessKeyId: process.env.ZDE_S3_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.ZDE_S3_SECRET_KEY || 'minioadmin123',
        bucket: process.env.ZDE_S3_BUCKET || 'echocut-output',
        forcePathStyle: (process.env.ZDE_S3_FORCE_PATH || '1') === '1',
        urlTtlSec: Number(process.env.ZDE_S3_URL_TTL_SEC || 7 * 24 * 3600)
    };
}

function createClient() {
    const cfg = getConfig();
    return new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey
        },
        forcePathStyle: cfg.forcePathStyle
    });
}

async function ensureBucket(client, bucket) {
    try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
        // 404 / NoSuchBucket / NotFound → 创建
        const status = err?.$metadata?.httpStatusCode;
        const name = err?.name || '';
        if (status === 404 || /NotFound|NoSuchBucket/i.test(name)) {
            await client.send(new CreateBucketCommand({ Bucket: bucket }));
        } else {
            throw err;
        }
    }
}

/**
 * 上传本地文件到 S3,返回预签名 URL
 *
 * @param {object} opts
 * @param {string} opts.filePath 本地文件绝对路径
 * @param {string} [opts.brandId] 用于拼 key 路径
 * @param {string} [opts.key]     自定义 key;不传则自动 <brandId>/<yyyy-mm-dd>/<basename>
 * @param {string} [opts.contentType] 默认根据扩展名推断
 * @returns {Promise<{key, url, bucket, size}>}
 */
async function uploadFile(opts) {
    const {
        filePath,
        brandId = 'default',
        key: customKey = '',
        contentType = guessContentType(filePath)
    } = opts || {};
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`[storage] 文件不存在: ${filePath}`);
    }
    const cfg = getConfig();
    const client = createClient();
    await ensureBucket(client, cfg.bucket);

    const today = new Date().toISOString().slice(0, 10);
    const key = customKey || `${brandId}/${today}/${Date.now()}-${path.basename(filePath)}`;
    const body = fs.readFileSync(filePath);

    await client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType
    }));

    const urlCmd = new (require('@aws-sdk/client-s3').GetObjectCommand)({
        Bucket: cfg.bucket,
        Key: key
    });
    const url = await getSignedUrl(client, urlCmd, { expiresIn: cfg.urlTtlSec });

    return {
        bucket: cfg.bucket,
        key,
        url,
        size: body.length,
        ttlSec: cfg.urlTtlSec
    };
}

/**
 * 列出 bucket 下的文件(可选按 prefix)
 */
async function listFiles(prefix = '') {
    const cfg = getConfig();
    const client = createClient();
    await ensureBucket(client, cfg.bucket);
    const res = await client.send(new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: prefix
    }));
    return (res.Contents || []).map((obj) => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified
    }));
}

/**
 * 按年龄(天)删除过期文件 — 滚动过期
 */
async function purgeOlderThan(days = 7) {
    const cfg = getConfig();
    const client = createClient();
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
    const files = await listFiles('');
    const expired = files.filter((f) => new Date(f.lastModified).getTime() < cutoffMs);
    let deleted = 0;
    for (const f of expired) {
        try {
            await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: f.key }));
            deleted += 1;
        } catch (err) {
            console.warn(`[storage] 删除 ${f.key} 失败: ${err.message}`);
        }
    }
    return { deleted, totalScanned: files.length };
}

function guessContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.txt': 'text/plain'
    };
    return map[ext] || 'application/octet-stream';
}

module.exports = {
    uploadFile,
    listFiles,
    purgeOlderThan,
    ensureBucket,
    createClient,
    getConfig
};
