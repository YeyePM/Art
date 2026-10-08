// 建表脚本：npm run init:db
// 幂等——重复执行不会报错，也不会清掉已有数据。
import { getDb, DB_FILE, DATA_DIR, IMAGES_DIR } from './index.js';

const db = getDb();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log(`数据库文件：${DB_FILE}`);
console.log(`数据目录  ：${DATA_DIR}`);
console.log(`图片缓存  ：${IMAGES_DIR}`);
console.log(`已建表 ${tables.length} 张：`);
for (const name of tables) console.log(`  - ${name}`);