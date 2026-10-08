// 把 AI 侧的异常翻成"人话"（M6）
// 依据：specs/01-接口契约.md「一之五」——AI 挂了不该白屏或 500，
// 而要给一句看得懂的提示，并且下次打开能自动重试。
//
// 这里只认几类常见的失败，认不出就给一句通用话；code 留给前端区分。
export function describeAiFailure(err) {
  const message = String(err?.message ?? '');

  if (/没有配置\s*ZHIPU_API_KEY/.test(message)) {
    return {
      code: 'no_key',
      message: '还没有配置 AI Key（项目根目录 .env 里的 ZHIPU_API_KEY）。今天先看题库里现有的题，配好后重新打开这一页会自动补齐。'
    };
  }

  if (/超时/.test(message)) {
    return {
      code: 'timeout',
      message: 'AI 服务响应太慢（超时了）。今天先看题库里现有的题，稍后重新打开这一页会自动重试。'
    };
  }

  if (/内容审核/.test(message)) {
    return {
      code: 'moderation',
      message: 'AI 服务这次把请求挡回去了（内容审核），换个时间重开这一页会自动重试。'
    };
  }

  return {
    code: 'unavailable',
    message: 'AI 服务暂时用不了。今天先看题库里现有的题，稍后重新打开这一页会自动重试。'
  };
}