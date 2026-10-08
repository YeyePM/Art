// 把还没落地的画作图下载到本机，并把图像辨识题的 image_path 接上
//   node app/api/scripts/backfill-images.js
//
// 适用场景：M5 之前生成的图像辨识题（image_path 为空）需要补图；
// 或某次下载时网络不通，之后重跑一次即可。**幂等**：已有缓存不重复下载。
import { backfillArtworkImages } from '../src/services/artworkCache.js';
import { countImageQuestionsMissingPath } from '../src/db/questions.js';
import { IMAGES_DIR } from '../src/config.js';

async function main() {
  console.log('');
  console.log('回填画作图片 → 本机缓存');
  console.log(`目录：${IMAGES_DIR}`);
  console.log('-'.repeat(72));

  const before = countImageQuestionsMissingPath();
  const out = await backfillArtworkImages();
  const after = countImageQuestionsMissingPath();

  console.log(`画作共 ${out.total} 件：新缓存 ${out.cached.length} 件，失败 ${out.failed.length} 件`);
  if (out.failed.length) {
    console.log(`失败的画作 id（多为没有 external_id，或下载时网络不通）：${out.failed.join(', ')}`);
  }
  console.log(`图像辨识题还缺图：${before} → ${after}`);
  console.log('');
  console.log(after === 0 ? '完成：图像辨识题的图都已在本地。' : '仍有缺图——重跑一次通常就好；一直缺的多半是画作没有 external_id。');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});