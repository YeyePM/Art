// 唯一能"把画下载到本机"的地方（与博物馆图床打交道）
// 依据：specs/04 第八节、docs/02 七-2 —— 图片一律本地缓存，禁止外链直显。
//
// 命名规则：`<来源库>-<外部 id>.jpg`。Met 的 objectID 稳定，同一件画永远同一个文件名，
// 所以"文件在不在"就是"缓存命中没命中"，不需要额外记一张表。
import fs from 'node:fs';
import path from 'node:path';
import { IMAGES_DIR } from '../config.js';

const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';
const TIMEOUT_MS = 20000;

/** 本地缓存文件名：来源库 + 外部 id。externalId 缺失就无从命名（返回 null） */
export function cachedFilename(sourceLibrary, externalId) {
  if (externalId == null) return null;
  const lib = String(sourceLibrary || 'unknown').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'unknown';
  const id = String(externalId).replace(/[^a-z0-9]/gi, '');
  if (!id) return null;
  return `${lib}-${id}.jpg`;
}

/** 已经落盘的本地文件名；没有缓存返回 null */
export function localImageName({ sourceLibrary, externalId } = {}) {
  const name = cachedFilename(sourceLibrary, externalId);
  if (!name) return null;
  return fs.existsSync(path.join(IMAGES_DIR, name)) ? name : null;
}

/**
 * 把一件作品的图下载到 data/images/，返回本地文件名。
 * - 已有缓存：直接返回，不联网；
 * - 下载失败：返回 null，**不抛错**——出题 / 每周一批不该被一张图卡死（界面显示无图即可）。
 *
 * @param {{sourceLibrary?:string, externalId?:string|number, imageUrl?:string}} artwork
 * @returns {Promise<string|null>}
 */
export async function cacheArtworkImage(artwork = {}) {
  const existing = localImageName(artwork);
  if (existing) return existing;

  const name = cachedFilename(artwork.sourceLibrary, artwork.externalId);
  if (!name) return null;

  try {
    const url = artwork.imageUrl || (await resolveImageUrl(artwork));
    if (!url) return null;

    const bytes = await fetchBinary(url);
    if (!bytes || bytes.length === 0) return null;

    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGES_DIR, name), bytes);
    return name;
  } catch {
    return null;
  }
}

/** 元数据里没带图地址时，按 externalId 回博物馆取一次（目前只接通 Met） */
async function resolveImageUrl({ sourceLibrary, externalId } = {}) {
  if (externalId == null) return null;
  if (String(sourceLibrary || 'met') !== 'met') return null;

  const object = await getJson(`${MET_API}/objects/${externalId}`);
  return object?.primaryImageSmall || object?.primaryImage || null;
}

async function fetchBinary(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}