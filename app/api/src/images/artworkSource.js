// 唯一能碰博物馆接口的地方（取元数据）
// 依据：specs/03-AI调用.md 第四节「事实纪律」——图像辨识题的作者 / 年代一律取博物馆元数据，
//       AI 只写风格依据与干扰项，把幻觉风险最大的一环交给权威数据。
//
// 这里只取「元数据 + 图床地址（imageUrl）」；把图下载到本机是 images/imageStore.js 的事，
// 两者同属 images/ 层——**唯一能碰外部图源的地方**。
//
// 为什么不能只取元数据、非得取真数据：每天要 2 件，写死的池子两天就重复，
// 重复 → 题干指纹相同 → 去重被挡 → 当日 10 题永远补不齐，会反复空跑 AI。
import { config } from '../config.js';

const API = 'https://collectionapi.metmuseum.org/public/collection/v1';
const SEARCH_API = 'https://collectionapi.metmuseum.org/public/collection/v1.1'; // v1 已于 2026-10-01 下线（410）
const TIMEOUT_MS = 12000;

// 检索条件分中外两组：随机挑一组 + 随机 offset，保证每天取到的作品不重样
const SEARCHES = {
  cn: [
    { q: 'hanging scroll', departmentId: 6 },
    { q: 'ink landscape', departmentId: 6 },
    { q: 'handscroll painting', departmentId: 6 },
    { q: 'bird and flower painting', departmentId: 6 }
  ],
  foreign: [
    { q: 'landscape painting', departmentId: 11 },
    { q: 'portrait', departmentId: 11 },
    { q: 'still life painting', departmentId: 11 },
    { q: 'genre painting', departmentId: 11 }
  ]
};

// 兜底池：网络不通时顶上，保证当天照样出得了题。
// 均为大都会公有领域作品，元数据已核对过官方接口。
export const FALLBACK_ARTWORKS = [
  {
    title: 'Landscape',
    artist: 'Zhang Ruitu（张瑞图）',
    period: 'early 17th century（明）',
    school: '明代文人画',
    sourceLibrary: 'met',
    externalId: 48968
  },
  {
    title: 'Young Woman with a Water Pitcher',
    artist: 'Johannes Vermeer',
    period: 'ca. 1662',
    school: '荷兰画派',
    sourceLibrary: 'met',
    externalId: 437881
  },
  {
    title: 'A Maid Asleep',
    artist: 'Johannes Vermeer',
    period: 'ca. 1656–57',
    school: '荷兰画派',
    sourceLibrary: 'met',
    externalId: 437878
  }
];

/**
 * 取当天出题要用的作品元数据。
 * 只要元数据齐全（有作者、有年代、有图、已进入公有领域）且没用过的作品；
 * 取不满就少给几件，绝不编造——缺的那部分交给 AI 出成别的题型。
 *
 * @param {{count?:number, usedExternalIds?:Iterable<string|number>, side?:'cn'|'foreign'}} params
 *   side：指定只取某一侧（每周一批要按批次轮换中外）；不传就按原有"两件以上先要一件中国的"规则
 * @returns {Promise<Array<{title,artist,period,school,sourceLibrary,externalId,imageUrl}>>}
 */
export async function fetchArtworksForToday({ count = 0, usedExternalIds = [], side } = {}) {
  const want = Math.max(0, Number(count) || 0);
  if (want === 0) return [];

  const used = new Set([...usedExternalIds].map(String));

  try {
    const got = [];
    if (side === 'cn' || side === 'foreign') {
      got.push(...(await pick(side, want, used)));
    } else {
      // 两件以上时先要一件中国的：中外交替那条规则需要两边都有得写
      if (want >= 2) got.push(...(await pick('cn', 1, used)));
      got.push(...(await pick('foreign', want - got.length, used)));
    }
    // 指定侧没取够时，用另一侧补，宁可中外不均也别空着
    if (got.length < want) got.push(...(await pick('foreign', want - got.length, used)));
    if (got.length >= want) return got.slice(0, want);
    if (got.length > 0) return got;
  } catch {
    // 博物馆接口不通不阻塞当天出题，落到兜底池
  }

  return FALLBACK_ARTWORKS.filter((item) => !used.has(String(item.externalId))).slice(0, want);
}

/** 从某一侧（cn / foreign）取 count 件没用过的可用作品 */
async function pick(side, count, used) {
  const out = [];
  if (count <= 0) return out;

  const candidates = SEARCHES[side];
  // 每次最多看 8 件、最多试 2 轮：博物馆接口有限流，每天只要 2 件，没必要扫太多
  for (let attempt = 0; attempt < 2 && out.length < count; attempt += 1) {
    const search = candidates[Math.floor(Math.random() * candidates.length)];
    const offset = Math.floor(Math.random() * 400);
    const url =
      `${SEARCH_API}/search?q=${encodeURIComponent(search.q)}` +
      `&departmentId=${search.departmentId}&isPublicDomain=true&hasImages=true` +
      `&limit=20&offset=${offset}`;

    const list = await getJson(url);
    for (const objectId of (list?.objectIDs ?? []).slice(0, 8)) {
      if (out.length >= count) break;
      if (used.has(String(objectId))) continue;

      let object;
      try {
        object = await getJson(`${API}/objects/${objectId}`);
      } catch {
        continue; // 单件取不到就跳过，不影响整批
      }
      if (!isUsable(object, side, used)) continue;

      used.add(String(object.objectID));
      out.push(toArtwork(object));
    }
  }

  return out;
}

/** 能不能拿来出题：元数据齐全 + 公有领域 + 有图 + 没被用过 + 中外对得上 */
function isUsable(object, side, used) {
  if (!object) return false;
  if (!object.isPublicDomain || !object.primaryImage) return false;
  if (!object.artistDisplayName || !object.objectDate) return false; // 作者或年代缺失的一律不要
  if (used.has(String(object.objectID))) return false;

  const chinese = isChinese(object);
  if (side === 'cn') return chinese;
  return !chinese;
}

/** 判一件作品是不是中国的 */
function isChinese(object) {
  const culture = String(object.culture ?? '');
  const nationality = String(object.artistNationality ?? '');

  // 亚洲部里日本、韩国占大头，先明确排掉。
  // 不能靠"名字里有汉字"来判——日文汉字和中文是同一个 Unicode 区段，
  // 实测会把《Tanuki》这种日本作品当成中国画取回来。
  if (/japan|korea|japanese|korean/i.test(culture) || /japan|korea|japanese|korean/i.test(nationality)) {
    return false;
  }
  return /china|chinese/i.test(culture) || /chinese/i.test(nationality);
}

function toArtwork(object) {
  return {
    title: object.title ?? null,
    artist: object.artistDisplayName,
    period: object.objectDate,
    // school 先留空：大都会给的是「部门」（Asian Art / European Paintings），
    // 在提示词里会被标成「流派」，是错的；流派不硬填，宁缺勿编。
    school: null,
    sourceLibrary: 'met',
    externalId: object.objectID,
    // 图床地址：M5 的 imageStore 拿它把图下载到本机（local_path）
    imageUrl: object.primaryImageSmall ?? object.primaryImage ?? null
  };
}

async function getJson(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    // 403 / 429 是博物馆在限流（实测短时间连打一百来次就会被挡）：歇一下再试一次，
    // 还不行就交给上层走兜底池，不要在这里死磕。
    if ((response.status === 403 || response.status === 429) && attempt === 1) {
      await sleep(1500);
      return await getJson(url, 2);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每天最多要几件（图像辨识题的当日上限，见 config.typeLimits） */
export function artworkDemandForToday(imageNeeded = 0) {
  return Math.min(Math.max(0, Number(imageNeeded) || 0), config.typeLimits.image);
}