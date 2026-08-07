/**
 * Whether the request actually requires an external action/tool, as distinct
 * from merely being sent by a host that exposes tools on every turn.
 *
 * The detector intentionally looks for action+target pairs. A generic factual
 * or multiple-choice question must stay false even when the host attaches a
 * large tool schema; otherwise every Franklin/OpenClaw turn is over-routed as
 * an agent task and models may browse or mutate state unnecessarily.
 */
export function inferToolRequirement(
  prompt: string,
  _systemPrompt?: string,
  toolChoice?: unknown,
): boolean {
  // OpenAI-compatible clients can state this requirement directly. Treat that
  // protocol signal as authoritative instead of trying to infer it from prose.
  if (toolChoice === "none") return false;
  if (toolChoice === "required") return true;
  if (
    typeof toolChoice === "object" &&
    toolChoice !== null &&
    (toolChoice as { type?: unknown }).type === "function"
  ) {
    return true;
  }

  // System prompts commonly describe every tool a host exposes. They are not
  // evidence that the user asked to perform an action on this turn. Explicit
  // host requirements should use tool_choice/requiresTools instead.
  const text = prompt;
  const explicitTool =
    /\b(?:use|call|invoke)\s+(?:the\s+)?[\w.-]+\s+(?:tool|function|api)\b|\btool[_ -]?call\b|使用.{0,20}(?:工具|函数|接口)|调用.{0,20}(?:工具|函数|接口)/i;
  const codeEnvironment =
    /\b(?:run|execute)\s+(?:the\s+)?(?:tests?|command|script|build|linter)|\b(?:edit|modify|patch|create|write|save|delete|rename|move|inspect|read)\b.{0,60}\b(?:file|repository|repo|codebase|directory|folder)\b|\b(?:terminal|shell|bash|zsh|pytest|npm test|pnpm test|git\s+(?:status|diff|commit)|docker)\b|(?:运行|执行).{0,20}(?:测试|命令|脚本|构建)|(?:修改|编辑|修复|创建|读取|检查|保存).{0,30}(?:文件|仓库|代码库|目录)/i;
  const webAction =
    /\b(?:browse|search|look up|fetch|open)\b.{0,80}\b(?:web|website|url|online|documentation|docs|news|weather|price)\b|(?:浏览|搜索|查询|打开).{0,30}(?:网页|网站|链接|文档|新闻|天气|价格)/i;
  const statefulAction =
    /\b(?:refund|cancel|book|reserve|purchase|buy|return|exchange|transfer|update|change)\b.{0,80}\b(?:order|booking|reservation|account|address|payment|subscription|ticket|flight|item)\b|(?:退款|取消|预订|购买|退货|换货|转账|更新|修改).{0,30}(?:订单|预订|账户|地址|付款|订阅|票|航班|商品)/i;
  return (
    explicitTool.test(text) ||
    codeEnvironment.test(text) ||
    webAction.test(text) ||
    statefulAction.test(text)
  );
}
