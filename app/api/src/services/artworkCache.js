// 把画作的图下载到本机，并把结果回填到 artworks.local_path 与 questions.image_path
// 依据：specs/04 第八节（图片一律本地缓存）、T9 验收（断开外网刷新页面，画还能看到）
//
// 图片只落一份：`artworks.local_path` 是"这件画的图在哪"，`questions.image_path` 由它派生，
// 同一个画 id 下的图像辨识题共用同一张图。
import { getArtworkById, listArtworkIds, setArtworkLocalPath } from '../db/artworks.js';
import { setImagePathForArtwork } from '../db/questions.js';
import { cacheArtworkImage, localImageName } from '../images/imageStore.js';

/**
 * 确保一件画的图在本机，并把挂在这件画上的图像辨识题一起接上。
 * 已有缓存不联网；下载失败返回 null（**不抛错**，界面显示无图即可）。
 *
 * @param {number} artworkId
 * @param {object|null} artworkMeta 刚取到的新鲜元数据（带 imageUrl 时可省一次对象详情请求）
 * @returns {Promise<string|null>} 本地文件名
 */
export async function cacheArtworkAndLink(artworkId, artworkMeta = null) {
  const row = getArtworkById(artworkId);
  if (!row) return null;

  const meta = {
    sourceLibrary: artworkMeta?.sourceLibrary ?? row.source_library,
    externalId: artworkMeta?.externalId ?? row.external_id,
    imageUrl: artworkMeta?.imageUrl ?? null
  };

  const name = localImageName(meta) ?? (await cacheArtworkImage(meta));
  if (!name) return null;

  if (row.local_path !== name) setArtworkLocalPath(row.id, name);
  setImagePathForArtwork(row.id, name);

  return name;
}

/**
 * 回填全库：把还没落地的画作图都下载下来，并把 questions.image_path 接上。
 * 给开发期脚本（scripts/backfill-images.js）与自测用；日常出题只走 cacheArtworkAndLink。
 */
export async function backfillArtworkImages() {
  const out = { total: 0, cached: [], failed: [] };

  for (const id of listArtworkIds()) {
    out.total += 1;
    const name = await cacheArtworkAndLink(id);
    if (name) out.cached.push({ id, name });
    else out.failed.push(id);
  }

  return out;
}