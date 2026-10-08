// 标签体系（出题均衡的依据）——纯常量与归类逻辑，不碰数据库
// 依据：docs/02-技术方案.md 第六节 4 · specs/04-核心规则.md 第四节

export const TAG_CATEGORIES = ['中外', '时期', '流派', '作者', '作品', '技法'];

// 中外
export const ORIGIN_CN = '中国美术史';
export const ORIGIN_FOREIGN = '外国美术史';
const ORIGIN_TAGS = {
  [ORIGIN_CN]: 'cn',
  [ORIGIN_FOREIGN]: 'foreign'
};

// 时期：只在一个美术史范围内出现的，可以拿来判中外
const CN_ONLY_PERIODS = ['商周', '秦汉', '魏晋南北朝', '隋唐', '宋', '元', '明', '清', '近现代'];
const FOREIGN_ONLY_PERIODS = ['文艺复兴', '巴洛克', '洛可可', '新古典', '浪漫主义', '印象', '后印象'];
// 中外都有的时期，不能用来判中外（否则会把中国近现代题误判成外国题）
const AMBIGUOUS_PERIODS = ['史前', '写实', '现代', '当代'];

export const PERIODS = [...CN_ONLY_PERIODS, ...FOREIGN_ONLY_PERIODS, ...AMBIGUOUS_PERIODS];

// 流派 / 门类
const CN_SCHOOLS = ['文人画', '院体', '青绿山水', '水墨', '工笔', '写意', '没骨'];
const FOREIGN_SCHOOLS = [
  '印象派', '新印象派', '立体主义', '野兽派', '表现主义',
  '超现实主义', '抽象表现主义', '荷兰画派', '佛罗伦萨画派', '威尼斯画派'
];
export const SCHOOLS = [...CN_SCHOOLS, ...FOREIGN_SCHOOLS];

const CN_KEYWORDS = [...CN_ONLY_PERIODS, ...CN_SCHOOLS, ORIGIN_CN];
const FOREIGN_KEYWORDS = [...FOREIGN_ONLY_PERIODS, ...FOREIGN_SCHOOLS, ORIGIN_FOREIGN];

/**
 * 判断一道题属于中国还是外国美术史。
 * 拿不准就返回 null —— 宁可不算进"中外混合"，也不要瞎归类。
 * @param {string[]} tags
 * @returns {'cn' | 'foreign' | null}
 */
export function inferOrigin(tags = []) {
  for (const tag of tags) {
    if (ORIGIN_TAGS[tag]) return ORIGIN_TAGS[tag];
  }
  for (const tag of tags) {
    if (CN_KEYWORDS.includes(tag)) return 'cn';
  }
  for (const tag of tags) {
    if (FOREIGN_KEYWORDS.includes(tag)) return 'foreign';
  }
  return null;
}

/**
 * 推断标签属于哪一类（写进 tags 表用）。
 * 推断不出就返回 null，由调用方决定兜底。
 * @param {string} name
 * @returns {'中外'|'时期'|'流派'|null}
 */
export function categoryOf(name) {
  if (Object.keys(ORIGIN_TAGS).includes(name)) return '中外';
  if (PERIODS.includes(name)) return '时期';
  if (SCHOOLS.includes(name)) return '流派';
  return null;
}

/** 标签是不是一个时期 */
export function isPeriod(name) {
  return PERIODS.includes(name);
}