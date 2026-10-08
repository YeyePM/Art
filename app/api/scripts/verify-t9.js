// T9 验收：图片抓取与本地缓存（GET /api/images/{filename} + 回填 questions.image_path）
//   node app/api/scripts/verify-t9.js
//
// **不花钱**（不调 AI），只联一次博物馆图床把图下下来。
// 自己插一件临时画 + 一道临时图像辨识题，跑完连作答 / 队列 / 题一并删；
// 唯一会留在磁盘上的是 data/images/met-437881.jpg（这是真正有用的缓存，若要清掉可手动删）。
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { IMAGES_DIR } from '../src/config.js';
import { cachedFilename, localImageName, cacheArtworkImage } from '../src/images/imageStore.js';
import { insertQuestions } from '../src/db/questions.js';
import { cacheArtworkAndLink } from '../src/services/artworkCache.js';

// 大都会公有领域作品（维米尔《持水壶的年轻女子》），图床地址稳定
const SAMPLE = { sourceLibrary: 'met', externalId: 437881 };
const SAMPLE_FILE = 'met-437881.jpg';
const TAG = '【T9自检】';

const line = (text = '') => console.log(text);
const rule = () => line('-'.repeat(88));

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

function maxId(table) {
  return getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
}

function cleanup(marks) {
  const db = getDb();

  // 外键顺序：子表先删（answers / review_queue / question_tags 都引用 questions）
  db.prepare('DELETE FROM review_queue WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM answers WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM question_tags WHERE question_id > ?').run(marks.questions);
  db.prepare('DELETE FROM questions WHERE id > ?').run(marks.questions);

  db.prepare('DELETE FROM artwork_notes WHERE artwork_id > ?').run(marks.artworks);
  db.prepare('DELETE FROM artworks WHERE id > ?').run(marks.artworks);
}

async function main() {
  line('');
  line('T9 验收 · 图片抓取与本地缓存');
  line(`图片缓存目录：${IMAGES_DIR}`);
  line('本脚本不调 AI；只会往 data/images/ 下 1 张公有领域作品图，并临时插 1 道自检题。');
  rule();

  const marks = {
    questions: maxId('questions'),
    artworks: maxId('artworks')
  };

  // ---------- ① 文件命名（决定"文件在不在"就是"缓存命中没命中"） ----------
  const name = cachedFilename('met', 437881);
  line(`① 命名规则：cachedFilename('met', 437881) → ${name}`);
  check('命名规则正确', name === SAMPLE_FILE, name);
  check('externalId 缺失时无从命名', cachedFilename('met', null) === null, String(cachedFilename('met', null)));
  line('');

  // ---------- ② 真下载一张图到本机 ----------
  const existedBefore = fs.existsSync(path.join(IMAGES_DIR, SAMPLE_FILE));
  line(`② 下载一张公有领域作品图${existedBefore ? '（本机已有缓存，直接复用）' : ''}…`);
  const downloaded = await cacheArtworkImage(SAMPLE);
  const filePath = path.join(IMAGES_DIR, downloaded ?? SAMPLE_FILE);
  const size = downloaded && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  line(`   → ${downloaded ?? '（下载失败）'}　${size} 字节`);
  check('图已落盘到 data/images/', Boolean(downloaded) && fs.existsSync(filePath), downloaded ?? 'null');
  check('文件不是空的', size > 1000, `${size} 字节`);
  check('缓存命中判定跟着文件走', localImageName(SAMPLE) === downloaded, String(localImageName(SAMPLE)));
  line('');

  // ---------- ③ 图 → 题：一件画的图接上它的图像辨识题 ----------
  const db = getDb();
  const artworkId = Number(
    db
      .prepare(`
        INSERT INTO artworks (title, artist, period, school, local_path, source_library, external_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(`${TAG}临时画作`, '自检', '—', null, null, 'met', String(SAMPLE.externalId)).lastInsertRowid
  );

  const { inserted } = insertQuestions([
    {
      type: 'image',
      stem: `${TAG}临时图像辨识题`,
      options: ['A 甲', 'B 乙', 'C 丙', 'D 丁'],
      answer: 'A',
      explanation: `${TAG}自检用，跑完即删。`,
      difficulty: '基础',
      tags: [],
      source: 'manual',
      artwork_id: artworkId
    }
  ]);
  const questionId = inserted[0];

  const linked = await cacheArtworkAndLink(artworkId, SAMPLE);
  const questionRow = db.prepare('SELECT image_path, artwork_id FROM questions WHERE id = ?').get(questionId);
  const artworkRow = db.prepare('SELECT local_path FROM artworks WHERE id = ?').get(artworkId);

  line('③ 一件画下载后，自动接上它的图像辨识题');
  line(`   画 id=${artworkId}　题 id=${questionId}　→ image_path=${questionRow?.image_path ?? '（空）'}`);
  check('画作记下了本地文件名', artworkRow?.local_path === SAMPLE_FILE, String(artworkRow?.local_path));
  check('图像辨识题的 image_path 被回填', questionRow?.image_path === SAMPLE_FILE, String(questionRow?.image_path));
  check('回填函数返回文件名', linked === SAMPLE_FILE, String(linked));
  line('');

  // ---------- ④ 起真实服务，把图当静态资源取回来 ----------
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  line('④ 用真实 HTTP 取图（这条就是前端 <img src> 走的路）');
  const okRes = await fetch(`${base}/api/images/${SAMPLE_FILE}`);
  const bytes = Buffer.from(await okRes.arrayBuffer());
  line(`   GET /api/images/${SAMPLE_FILE} → HTTP ${okRes.status}　${bytes.length} 字节　${okRes.headers.get('content-type')}`);
  check('取图返回 200', okRes.status === 200, `HTTP ${okRes.status}`);
  check('返回的是图片类型', /image\//.test(okRes.headers.get('content-type') ?? ''), String(okRes.headers.get('content-type')));
  check('取回的字节数与磁盘一致', bytes.length === size, `${bytes.length} / ${size}`);

  const missRes = await fetch(`${base}/api/images/nope-not-here.jpg`);
  line(`   GET /api/images/nope-not-here.jpg → HTTP ${missRes.status}（不存在的图）`);
  check('不存在的图返回 404', missRes.status === 404, `HTTP ${missRes.status}`);

  const travRes = await fetch(`${base}/api/images/..%2f..%2fpackage.json`);
  line(`   GET /api/images/..%2f..%2fpackage.json → HTTP ${travRes.status}（路径穿越尝试）`);
  check('路径穿越被挡住（不是 200）', travRes.status !== 200, `HTTP ${travRes.status}`);
  line('');

  server.close();

  // ---------- ⑤ 清理 ----------
  cleanup(marks);
  // 缓存图：只有在"没有别的画还指着它"时才删，别误伤真实数据
  let keptFile = true;
  if (!existedBefore) {
    const stillUsed = getDb().prepare('SELECT count(*) AS c FROM artworks WHERE local_path = ?').get(SAMPLE_FILE).c;
    if (stillUsed === 0) {
      try {
        fs.unlinkSync(path.join(IMAGES_DIR, SAMPLE_FILE));
        keptFile = false;
      } catch {
        /* 删不掉也无所谓，它就是一张有用的缓存 */
      }
    }
  }

  const leftover = {
    题库: getDb().prepare('SELECT count(*) AS c FROM questions WHERE id > ?').get(marks.questions).c,
    画作: getDb().prepare('SELECT count(*) AS c FROM artworks WHERE id > ?').get(marks.artworks).c
  };
  line(`⑤ 清理临时数据：题库残留 ${leftover.题库}　画作残留 ${leftover.画作}`);
  line(`   缓存图 ${SAMPLE_FILE}：${keptFile ? '保留（有用，可用作离线演示）' : '已删除'}`);
  check('临时题已清理', leftover.题库 === 0, String(leftover.题库));
  check('临时画作已清理', leftover.画作 === 0, String(leftover.画作));
  line('');

  // ---------- 汇总 ----------
  rule();
  line('自检');
  rule();
  for (const [name_, ok, detail] of checks) {
    line(`${ok ? 'PASS' : 'FAIL'}  ${name_}${detail ? `　　${detail}` : ''}`);
  }

  const failed = checks.filter(([, ok]) => !ok);
  rule();
  line(`通过 ${checks.length - failed.length} / ${checks.length}`);
  line('');
  line('图片一律落在 data/images/，通过 /api/images/{文件名} 提供——不依赖外链，断开外网照样看得到。');
  line('');

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});