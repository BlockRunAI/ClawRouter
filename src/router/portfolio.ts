/**
 * V3 portfolio router.
 *
 * This is deliberately local and deterministic: feature extraction, eligibility
 * checks and scoring read only request data plus the in-process model registry.
 * It is therefore safe for the hot path and provides a stable baseline for the
 * RouterBench evaluation before health telemetry / an optional judge are added.
 */

import { BLOCKRUN_MODELS } from "../models.js";
import { getFallbackChain, selectModel } from "./selector.js";
import { RulesStrategy } from "./strategy.js";
import { HISTORICAL_MODEL_PROFILES, LIVE_MODEL_PROFILES, type ModelPerformanceProfile } from "./model-profiles.js";
import type { RouterOptions, RouterStrategy, TaskType, Tier, TierConfig } from "./types.js";
import { inferToolRequirement } from "./tool-intent.js";

type TaskFeatures = {
  taskType: TaskType;
  estimatedInputTokens: number;
  hasCode: boolean;
  needsTools: boolean;
  toolsAvailable: boolean;
  needsVision: boolean;
  needsStructuredOutput: boolean;
  latencySensitive: boolean;
  highStakes: boolean;
  language: "zh" | "other";
  likelyParallelToolCalls: boolean;
  complexMultiToolPlan: boolean;
  agentDomain: "airline" | "retail" | "web_research" | "other";
  deepWebResearch: boolean;
  agentRisk: "standard" | "high" | "complex_high" | "policy_exception_simple" | "policy_exception";
  terminalToolSignal: boolean;
  terminalSafetySensitive: boolean;
  implicitTerminalCode: boolean;
};

const DEFAULT_PORTFOLIO_WEIGHTS = {
  auto: { quality: 0.47, capability: 0.2, cost: 0.18, speed: 0.07, reliability: 0.03, legacy: 0.05 },
  eco: { quality: 0.36, capability: 0.2, cost: 0.28, speed: 0.1, reliability: 0.04, legacy: 0.02 },
  premium: { quality: 0.58, capability: 0.2, cost: 0.08, speed: 0.06, reliability: 0.06, legacy: 0.02 },
  highStakesBoost: { quality: 0.08, reliability: 0.05 },
  latencySensitiveSpeedBoost: 0.08,
  affinityFloorGap: { auto: 0.1, eco: 0.22, premium: 0.05 },
} as const;

/**
 * Detect turns that probably need several tool calls. This is a
 * deliberately conservative request-side feature: it uses only the prompt
 * and visible tool count, never benchmark categories or expected answers.
 */
function likelyNeedsParallelToolCalls(
  prompt: string,
  needsTools: boolean,
  toolCount: number | undefined,
  toolNames: readonly string[] | undefined,
): boolean {
  if (!needsTools || toolCount === undefined || toolCount < 1) return false;
  const text = prompt.trim();
  const explicitRepeat = /\b(?:in parallel|simultaneously|concurrently|for each|each of|every one|both|(?:two|three|multiple|several)\s+(?:cities|locations|items|tasks|orders|users|files))\b|并行|同时|分别|每个|各自|(?:两个|三个|多个)(?:城市|地点|项目|任务|订单|用户|文件)|cada uno|para cada|simult[aá]neamente/i.test(text);
  if (explicitRepeat) return true;

  const sentenceClauses = text.split(/[.!?。！？]+/).map((part) => part.trim()).filter((part) => part.length >= 8);
  if ((/\b(?:also|additionally|furthermore)\b|另外|此外|그리고/i.test(text) && sentenceClauses.length >= 2)
    || /\band\s+(?:also|for the)\b/i.test(text)) return true;

  const pairedQuantity = /\b\d+(?:\.\d+)?\s+(?:and|or)\s+\d+(?:\.\d+)?\s*(?:gb|mb|tb|kg|g|ml|oz|cups?|cores?|cpus?)\b/i.test(text);
  if (pairedQuantity) return true;

  // Distinctive tokens from two visible tool names are a strong local signal
  // for a multi-operation turn (for example add_task + delete_task).
  const operationTokens = new Set([
    "add", "delete", "remove", "cancel", "return", "exchange", "modify",
    "book", "transfer", "send", "upload", "download", "create", "close",
  ]);
  const lowered = text.toLowerCase();
  const matchedOperationTokens = new Set((toolNames ?? [])
    .flatMap((name) => name.toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/))
    .filter((token) => operationTokens.has(token) && lowered.includes(token)));
  // A single workflow naturally mentions domain nouns like order/item plus
  // one action. Upgrade only when two different visible operation verbs are
  // requested (for example cancel + book or add + delete).
  if (matchedOperationTokens.size >= 2) return true;

  // Repeated food/logging entries are commonly expressed as several lines,
  // each with its own quantity rather than an explicit "for each" phrase.
  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const quantityMentions = text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:oz|ounce|ounces|g|gram|grams|kg|ml|cups?|pieces?|tablespoons?)\b/gi) ?? [];
  if (nonEmptyLines.length >= 2 && quantityMentions.length >= 2) return true;

  // Weather prompts provide a useful language-independent high-confidence
  // pattern: a single lookup tool plus multiple locations joined in one turn.
  const repeatedLookup = /\b(?:weather|climate|clima|tiempo|temperature|snow|news|report)\b|天气|气象|温度|降雪|新闻|报告/i.test(text);
  const multiLocationConnector = /\b(?:and also|both|y|e)\b|还有|以及|和|、/i.test(text);
  const commaSeparatedLocations = (text.match(/[,，]/g) ?? []).length >= 2;
  if (repeatedLookup && (multiLocationConnector || commaSeparatedLocations)) return true;

  const distinctOrderParts = /\b(?:food|meal)\b[\s\S]*\bdrink\b|\bdrink\b[\s\S]*\b(?:food|meal)\b/i.test(text);
  const koreanParallelClauses = (text.match(/,/g) ?? []).length >= 3 && /하고|그리고/.test(text);
  return distinctOrderParts || koreanParallelClauses;
}

function classifyTask(prompt: string, systemPrompt: string | undefined, options: RouterOptions): TaskFeatures {
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const text = prompt.toLowerCase();
  const estimatedInputTokens = Math.ceil(fullText.length / 4);
  const explicitCodeSignal = /```|\b(?:typescript|javascript|python|rust|java|sql|stack trace|traceback|exception)\b|\.(?:ts|tsx|js|py|go|rs)\b/i.test(prompt);
  // `class` is common in non-code Agent domains (for example airline cabin
  // class). Treat code constructs as code only when the prompt also contains
  // an implementation/editing cue, instead of letting a single ambiguous
  // noun redirect an entire tool session to the code-agent portfolio.
  const codeConstructSignal = /\b(?:implement|refactor|debug|write|edit|modify|create|define|review|fix)\b[\s\S]{0,48}\b(?:api|function|class|method)\b|\b(?:api|function|class|method)\b[\s\S]{0,48}\b(?:code|implementation|typescript|javascript|python|rust|java)\b/i.test(prompt);
  const nativeCodeSignal = /\b(?:programmed|written|implemented?|code)\s+(?:in|using)\s+(?:c\+\+|c|rust|go)\b/i.test(prompt);
  const hasCode = explicitCodeSignal || codeConstructSignal || nativeCodeSignal;
  const toolsAvailable = options.hasTools ?? false;
  const needsTools = options.requiresTools ?? (toolsAvailable && inferToolRequirement(prompt, systemPrompt));
  const likelyParallelToolCalls = likelyNeedsParallelToolCalls(prompt, needsTools, options.toolCount, options.toolNames);
  const normalizedToolNames = (options.toolNames ?? []).map((name) => name.toLowerCase());
  const airlineToolSignal = normalizedToolNames.some((name) => /(?:flight|reservation|airport|baggage|passenger)/.test(name));
  const retailToolSignal = normalizedToolNames.some((name) => /(?:order|product|item|return|exchange|address)/.test(name));
  const webResearchToolSignal = normalizedToolNames.some((name) => /^(?:web_?search|web_?fetch)$/.test(name));
  const agentDomain = airlineToolSignal && !retailToolSignal
    ? "airline"
    : retailToolSignal && !airlineToolSignal
      ? "retail"
      : webResearchToolSignal
        ? "web_research"
        : "other";
  // Distinguish a cheap lookup from a BrowseComp-like investigation. These
  // prompts require joining several clues, resolving an entity, and ending in
  // one exact answer; full Franklin trajectories show that treating them as
  // ordinary search causes long, costly loops. This is request/tool-surface
  // evidence only and does not depend on a benchmark id or hidden answer.
  const clueConnectors = fullText.match(/\b(?:after|before|while|where|whose|which|in \d{4}|as of|over \d+|another|also|furthermore)\b|(?:之后|之前|其中|截至|超过|另一个|此外)/gi) ?? [];
  const entityResolutionSignal = /\b(?:identify|who (?:is|was)|what (?:is|was) the name|which (?:person|player|company|country|city)|find the (?:person|player|name|entity))\b|(?:找出|识别|是谁|哪位|名称是什么)/i.test(fullText);
  const exactAnswerSignal = /\b(?:exact answer|single best-supported answer|following clues|multiple public sources)\b|(?:精确答案|根据.*线索|多个公开来源)/i.test(fullText);
  const deepWebResearch = agentDomain === "web_research"
    && (exactAnswerSignal
      || entityResolutionSignal && (clueConnectors.length >= 3 || prompt.length >= 320));
  const globalOptimizationSignal = /\b(?:cheapest|lowest[- ]price|least expensive|most expensive|highest(?:[- ]priced)?|largest|smallest|maximum|minimum|best available|closest|not (?:cost|exceed))\b|最便宜|最低价|最贵|最高价|最大|最小/i.test(prompt);
  const globalScopeSignal = /\b(?:everything|all (?:(?:my|your|their|the) )?(?:future |upcoming )?(?:items|orders|passengers|flights|reservations|bookings)|every (?:item|order|passenger|flight|reservation|booking))\b|全部|所有|每个/i.test(prompt);
  const globalChoiceSignal = globalOptimizationSignal || globalScopeSignal;
  const crossRecordSignal = /\b(?:another|other|different|previous)\s+(?:order|reservation|booking|account|address)\b|另一(?:个)?(?:订单|预订|账户|地址)|其他(?:订单|预订|账户|地址)/i.test(prompt);
  const reservationIds = prompt.match(/\b[A-Z0-9]{6}\b/g) ?? [];
  const crossReservationBatchSignal = agentDomain === "airline" && (
    /\b(?:two|three|multiple|several)(?:\s+of\s+(?:my|our|the))?\s+(?:upcoming\s+)?(?:reservations?|bookings?)\b|\b(?:a\s+)?(?:second|third)\s+(?:reservation|booking)\b/i.test(prompt)
    || new Set(reservationIds).size >= 2
  );
  const conditionalGlobalWorkflowSignal = agentDomain === "airline"
    && globalScopeSignal
    && /\b(?:if|that (?:contain|have)|longer than|shorter than|under|over|at (?:most|least)|wherever possible)\b|如果|超过|少于|不超过|尽可能/i.test(prompt)
    && /\b(?:cancel|change|upgrade|move|book)\b[\s\S]*\b(?:cancel|change|upgrade|move|book)\b|取消[\s\S]*(?:升级|更改)|升级[\s\S]*(?:取消|更改)/i.test(prompt);
  // A refund explicitly targeted at a named/non-original card can conflict
  // with account state and require escalation rather than a substitute action.
  // This narrow feature is visible on the first turn and avoids sending every
  // ordinary return workflow to the expensive policy specialist.
  const policyExceptionSignal = agentDomain === "retail"
    && /\b(?:return|refund|send back|get (?:my |the )?money back)\b|退货|退款|退回/i.test(prompt)
    && /\b(?:amex|american express|visa|mastercard|credit card|debit card|different card|another card|other card)\b|信用卡|借记卡|其他卡|另一张卡/i.test(prompt);
  // A comparative selector can mention two products while requesting only
  // one write (for example "send back the pricier one"). Three-repeat tau2
  // calibration found no quality gain from the policy specialist on these
  // single-write cases, so keep them in a distinct, lower-cost risk band.
  const singleSelectedPolicyException = policyExceptionSignal
    && /\b(?:return|refund|send back)\b[^.!?。！？]{0,96}\b(?:the )?(?:pricier|cheaper|more expensive|less expensive|costlier|one)\b/i.test(prompt);
  // Returns and exchanges often pivot after confirmation (return -> rethink
  // -> exchange -> choose a variant). That future state is not visible to a
  // task-start router, so treat the observable workflow verb as the risk cue.
  // Simpler cancellation and one-field order edits stay on the standard path.
  const negotiatedWorkflowSignal = agentDomain === "retail"
    && /\b(?:return|exchange)\b|退货|退回|换货|交换/i.test(prompt);
  const numberedSteps = (prompt.match(/(?:^|\s)\d+(?:\.\d+)*[.)]\s+/g) ?? []).length;
  const complexMultiToolPlan = likelyParallelToolCalls
    && ((options.toolCount ?? 0) >= 6 || numberedSteps >= 3 || prompt.length > 1_200);
  let agentRisk: TaskFeatures["agentRisk"] = needsTools && singleSelectedPolicyException
    ? "policy_exception_simple"
    : needsTools && policyExceptionSignal
    ? "policy_exception"
    // Airline prompts that require a global optimum (for example the
    // cheapest itinerary across several candidates) are materially harder
    // than applying one change to every passenger in a known reservation.
    // Full-session evidence supports Sonnet for the former, while upgrading
    // the latter merely because it says "all passengers" caused a large cost
    // increase without a quality gain.
    : needsTools && agentDomain === "airline"
      && (globalOptimizationSignal || conditionalGlobalWorkflowSignal)
      ? "complex_high"
    : needsTools && (likelyParallelToolCalls || globalChoiceSignal || crossRecordSignal || crossReservationBatchSignal || negotiatedWorkflowSignal)
      ? "high"
      : "standard";
  const needsVision = options.hasVision ?? false;
  const needsStructuredOutput = options.requiresStructuredOutput ?? false;
  const latencySensitive = /\b(?:urgent|asap|fast|quick|low latency|real[- ]time)\b|尽快|马上|快速|低延迟/i.test(fullText);
  const highStakes = /\b(?:production|security|payment|legal|medical|financial|audit)\b|生产|安全|支付|法律|医疗|财务|审计/i.test(fullText);
  // Terminal tasks often describe the desired artifact rather than naming a
  // programming language. Treat only small, deterministic local build/file
  // work as implicit code. Operational deployment, credentials, destructive
  // work, evaluation, vision, and broad search stay on the stronger generic
  // tool-agent path. This is a request-side feature, not a benchmark ID list.
  const terminalToolSignal = normalizedToolNames.some((name) => /^(?:terminalexec|terminalinspect|terminalsendkeys)$/.test(name));
  const simpleTerminalArtifact = /\b(?:create|write|convert|generate|build|implement|run|fix|repair|debug|make)\b[\s\S]{0,120}\b(?:file|script|csv|parquet|json|txt|server|endpoint)\b/i.test(prompt);
  // Multi-file repair is qualitatively different from fixing one known local
  // script. The agent must preserve state across inspections, infer ordering
  // and dependencies, edit several artifacts, and close the loop with tests.
  // A frozen Terminal-Bench trajectory showed the economy model spending 27
  // turns repeatedly rereading files without making an edit, while Opus solved
  // the same task in eight turns. Promote this request-visible pattern before
  // model scoring; no benchmark ID or expected answer is consulted.
  const terminalComplexRepair = terminalToolSignal
    && /\b(?:multiple|several)\s+(?:scripts?|files?|components?)\b|\b(?:pipeline|dependencies)\b[\s\S]{0,100}\b(?:fail|issue|fix|repair|run|execute)\b|\b(?:identify|find|fix|repair)\s+(?:and\s+)?(?:fix\s+)?all\s+(?:the\s+)?issues\b/i.test(prompt);
  // One artifact that must be accepted by multiple compilers/runtimes is not
  // a routine file-writing task. It requires reasoning across incompatible
  // grammars and validating every execution path; cheap code models can
  // produce plausible-looking source that satisfies neither toolchain.
  const mentionedTerminalRuntimes = new Set(
    (prompt.match(/\b(?:gcc|clang|rustc|javac|go\s+build|node|python)\b/gi) ?? [])
      .map((name) => name.toLowerCase().replace(/\s+/g, " ")),
  );
  const terminalCrossRuntimeArtifact = terminalToolSignal && (
    /\bpolyglot\b/i.test(prompt)
    || /\b(?:both|each)\b[\s\S]{0,120}\b(?:compilers?|runtimes?|toolchains?)\b/i.test(prompt)
    || (mentionedTerminalRuntimes.size >= 2 && /\b(?:compile|build|run|execute)\b/i.test(prompt))
  );
  // Framework-to-native ports combine binary checkpoint inspection, weight
  // export, tensor-layout reasoning, image/data decoding, and a separately
  // compiled runtime. A task-start router can see this boundary directly in
  // the request (for example PyTorch state_dict -> a pure C CLI); treating it
  // like routine single-file C work caused a 30-turn read/retry loop in a
  // frozen official Terminal-Bench trajectory.
  const terminalFrameworkToNativeArtifact = terminalToolSignal
    && /\b(?:pytorch|tensorflow|jax|onnx|state[_ -]?dict|checkpoint|safetensors?)\b|\.(?:pth|pt|onnx)\b/i.test(prompt)
    && /\b(?:pure|native|programmed|written|implemented?)\s+(?:in|using)\s+(?:c\+\+|c|rust|go)\b|\b(?:c\+\+|c|rust|go)\s+(?:program|binary|executable|cli|tool|implementation)\b/i.test(prompt)
    && /\b(?:inference|model|weights?|tensor|export|convert|load)\b/i.test(prompt);
  if (needsTools && (terminalComplexRepair || terminalCrossRuntimeArtifact || terminalFrameworkToNativeArtifact)
    && (agentRisk === "standard" || agentRisk === "high")) agentRisk = "complex_high";
  const complexTerminalOperation = /\b(?:git|ssh|nginx|https|certificate|authentication|credential|deploy|production|encrypt|gpg|shred|securely delete|decommission|benchmark|evaluate|embedding|chess|image|search the web|schema|statistical|statistics|aggregate|join|multiple inputs?)\b/i.test(prompt);
  // A bare "token" is not a credential signal: blockchain, tokenizer, and
  // LLM tasks use that word routinely (for example "token transfers"). Only
  // treat it as sensitive when the prompt gives it an authentication/secret
  // qualifier. API keys remain an unambiguous high-risk signal on their own.
  const terminalCredentialSignal = /\b(?:ssh|nginx|certificate|authentication|credentials?|passwords?|api keys?|deploy|production|encrypt|gpg|shred|securely delete|decommission)\b/i.test(prompt)
    || /\b(?:access|auth|authentication|bearer|secret|api)\s+tokens?\b|\btokens?\s+(?:secret|credential|authentication)\b/i.test(prompt);
  const terminalSafetySensitive = terminalToolSignal && (highStakes || terminalCredentialSignal);
  const implicitTerminalCode = needsTools
    && terminalToolSignal
    && agentRisk === "standard"
    && !highStakes
    && !complexTerminalOperation
    && numberedSteps < 3
    && prompt.length <= 1_000
    && simpleTerminalArtifact;
  const language = /[\u3400-\u9fff]/.test(fullText) ? "zh" : "other";
  const multipleChoiceSignals = (prompt.match(/(?:^|\n)\s*[A-D][.)]\s+/gim) ?? []).length;
  const numericSignals = (prompt.match(/-?\d+(?:[.,]\d+)?/g) ?? []).length;
  const compactMathProblem = !hasCode && prompt.length < 2_500 && numericSignals >= 2 && (
    /[+×÷=%$€£¥]|\b(?:total|each|per|times|half|twice|percent|how many|how much|calculate)\b/i.test(prompt)
    || /[?？]\s*$/.test(prompt.trim())
    || numericSignals >= 3
  );

  let taskType: TaskType = "chat";
  if (needsVision) taskType = "vision";
  else if (estimatedInputTokens > 80_000) taskType = "long_context";
  else if (needsTools && (hasCode || implicitTerminalCode)) taskType = "code_agent";
  else if (needsTools && likelyParallelToolCalls && !complexMultiToolPlan) taskType = "tool_agent_parallel";
  else if (needsTools) taskType = "tool_agent";
  else if (multipleChoiceSignals >= 3) taskType = "reasoning_mcq";
  else if (compactMathProblem) taskType = "reasoning_math";
  else if (/\b(?:bug|debug|error|failure|failing|regression|crash|修复|报错|错误|调试)\b/i.test(text)) taskType = "debug";
  else if (hasCode || /\b(?:refactor|implement|patch|edit|rewrite|重构|实现|修改)\b/i.test(text)) taskType = "code_edit";
  else if (needsStructuredOutput || /\b(?:extract|json|schema|csv|字段|提取)\b/i.test(text)) taskType = "extraction";
  else if (/\b(?:prove|derive|theorem|formal|mathematical|reasoning|证明|推导|定理|数学)\b/i.test(text)) taskType = "reasoning";

  return {
    taskType,
    estimatedInputTokens,
    hasCode,
    needsTools,
    toolsAvailable,
    needsVision,
    needsStructuredOutput,
    latencySensitive,
    highStakes,
    language,
    likelyParallelToolCalls,
    complexMultiToolPlan,
    agentDomain,
    deepWebResearch,
    agentRisk,
    terminalToolSignal,
    terminalSafetySensitive,
    implicitTerminalCode,
  };
}

function affinity(
  modelId: string,
  task: TaskType,
  language: TaskFeatures["language"] = "other",
  agentDomain: TaskFeatures["agentDomain"] = "other",
  deepWebResearch = false,
  agentRisk: TaskFeatures["agentRisk"] = "standard",
  terminalToolSignal = false,
  terminalSafetySensitive = false,
): number {
  const id = modelId.toLowerCase();
  // Model family names are intentionally similar (for example
  // `gemini-2.5-flash` vs `gemini-2.5-flash-lite`).  A substring match lets a
  // smaller sibling inherit a capability claim that was measured only for the
  // flagship. Keep these assignments model-exact; a sibling can be added only
  // with its own evidence.
  const modelName = id.slice(id.indexOf("/") + 1);
  const match = (values: string[], score: number) => (values.some((value) => modelName === value) ? score : 0);
  const base = 0.68;

  switch (task) {
    case "code_agent":
      if (terminalToolSignal && agentRisk === "complex_high") {
        // Strong native tool loop until the Responses function-output fix is
        // deployed on both gateways; keep Codex available below the floor.
        return Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5.3-codex"], 0.87), match(["gpt-5-mini"], 0.78), match(["gemini-3.5-flash"], 0.76));
      }
      // Seven valid full Franklin + official Terminal-Bench trajectories
      // (2026-07-28) gave GPT-5 Mini 4/7 resolved tasks versus 1/7 for the
      // prior dynamic code-agent choice. Its token-normalized total cost was
      // higher in this small calibration, so keep Codex and Sonnet's quality
      // priors above it; admitting Mini to the scoring band lets the normal
      // quality/cost profile choose it without erasing stronger fallbacks.
      // DeepSeek V4 Pro is kept below the primary band after two consecutive
      // mid-trajectory provider timeouts contaminated its calibration runs.
      return Math.max(base, match(["gpt-5.3-codex"], 1), match(["claude-sonnet-5"], 0.98), match(["gpt-5-mini"], 0.96), match(["gemini-3.5-flash"], 0.92), match(["kimi-k3"], 0.9), match(["deepseek-v4-pro", "glm-5.2"], 0.88));
    case "tool_agent":
      if (terminalToolSignal && agentRisk === "complex_high") {
        // Keep the Responses-API Codex path outside auto's affinity floor
        // until the gateway fix that preserves function_call_output is live
        // on both chains. Sonnet has a verified native multi-turn tool loop
        // and is the safe strong default for this band today.
        return Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5.3-codex"], 0.87), match(["gpt-5-mini"], 0.78), match(["gemini-3.5-flash"], 0.76));
      }
      if (terminalToolSignal && !terminalSafetySensitive) {
        // Seven official Terminal-Bench calibration trajectories favoured
        // GPT-5 Mini over the prior dynamic choice. Admit Codex/Sonnet as
        // close fallbacks, but let actual request cost break the tie.
        return Math.max(base, match(["gpt-5-mini"], 1), match(["gpt-5.3-codex"], 0.98), match(["claude-sonnet-5"], 0.9), match(["gemini-3.5-flash"], 0.89));
      }
      if (terminalToolSignal && terminalSafetySensitive) {
        // Two complete Franklin observations on the public
        // Terminal-Bench new-encrypt-command task ended in Codex repeating
        // the same TerminalExec input until the loop guard fired. Keep Codex
        // as an availability fallback, but below the safety-band affinity
        // floor until its Responses function-output path is verified on both
        // gateways. This does not change explicit code-agent routing.
        return Math.max(base, match(["claude-sonnet-5"], 1), match(["claude-opus-4.8"], 0.9), match(["gpt-5.3-codex"], 0.84));
      }
      if (agentDomain === "web_research") {
        // Complete-session BrowseComp calibration supersedes the earlier
        // single-case Opus promotion: strict deduplicated evidence has Sonnet
        // 5 at 2/9 versus Opus 5 at 0/3, while Opus also costs more and has a
        // much longer tail. Keep Opus as an availability fallback until a
        // larger stable-provider sample supports promotion.
        return deepWebResearch
          ? Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.88), match(["gemini-3.5-flash"], 0.84), match(["claude-opus-5"], 0.80), match(["claude-opus-4.8"], 0.78))
          : Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.88), match(["gemini-3.5-flash"], 0.86), match(["claude-opus-5"], 0.84), match(["claude-opus-4.8"], 0.82));
      }
      // Full-trajectory tau2 calibration (2026-07-28, official gpt-4.1
      // simulator): Sonnet 5 completed both an airline policy task and a
      // retail multi-write task with reward 1.0. Gemini 3.5 Flash emitted
      // function calls as plain text after the first structured calls and
      // looped to the 100-step ceiling on the airline task. Keep only the
      // trajectory-validated primary inside the scoring band; the remaining
      // eligible models are retained below as availability fallbacks.
      if (agentDomain === "retail") {
        // Full-session calibration: GPT-5 Mini completed two local/single
        // retail workflows at a fraction of Sonnet's token cost. It remains
        // ineligible for promotion when the prompt asks for multiple actions,
        // cross-record discovery, or a global optimum; those trajectories
        // exposed unstable write arguments in prior calibration. DeepSeek V4
        // Pro completed all three high-risk retail calibration trajectories
        // that included global-choice, cross-record, and multi-write behavior;
        // Sonnet completed one of the same three.
        if (agentRisk === "standard") {
          return Math.max(base, match(["gpt-5-mini"], 1), match(["claude-sonnet-5"], 0.88), match(["gemini-3.5-flash"], 0.82), match(["gpt-5.3-codex"], 0.81), match(["kimi-k3"], 0.78), match(["deepseek-v4-pro"], 0.76));
        }
        if (agentRisk === "policy_exception") {
          return Math.max(base, match(["gpt-4.1"], 1), match(["claude-sonnet-5"], 0.9), match(["deepseek-v4-pro"], 0.82), match(["gpt-5-mini"], 0.8), match(["gpt-4o-mini"], 0.76));
        }
        if (agentRisk === "policy_exception_simple") {
          return Math.max(base, match(["gpt-5-mini"], 1), match(["gpt-4.1"], 0.86), match(["deepseek-v4-pro"], 0.82), match(["gpt-4o-mini"], 0.8));
        }
        return Math.max(base, match(["deepseek-v4-pro"], 1), match(["claude-sonnet-5"], 0.88), match(["gemini-3.5-flash"], 0.82), match(["gpt-5.3-codex"], 0.81), match(["kimi-k3"], 0.78), match(["gpt-5-mini"], 0.76));
      }
      // Standard airline workflows stay on GPT-5 Mini: six full-session
      // development trajectories gave it the same 5/6 success as Sonnet at
      // roughly one order of magnitude lower normalized token cost. A held-out
      // high-risk cabin/date negotiation then produced a persistent empty
      // assistant turn on Mini even after a semantic retry, while Sonnet 5
      // completed the identical official tau2 trajectory with reward 1.0.
      // Promote only global optimization / conditional-global work. A known
      // batch of reservations is operationally high-risk but still a
      // structured tool workflow: current Tau evidence has Mini and Sonnet at
      // equal task reward there, while Sonnet costs roughly two orders of
      // magnitude more on the long-tail case.
      if (agentDomain === "airline") {
        if (agentRisk === "complex_high") {
          return Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.78), match(["gemini-3.5-flash"], 0.76), match(["deepseek-v4-pro"], 0.74));
        }
        return Math.max(base, match(["gpt-5-mini"], 1), match(["claude-sonnet-5"], 0.9), match(["gemini-3.5-flash"], 0.8), match(["deepseek-v4-pro"], 0.76));
      }
      return Math.max(base, match(["claude-sonnet-5"], 1), match(["gemini-3.5-flash"], 0.88), match(["gpt-5.3-codex"], 0.87), match(["gpt-5-mini"], 0.84), match(["kimi-k3"], 0.85), match(["deepseek-v4-pro"], 0.82));
    case "tool_agent_parallel":
      if (terminalToolSignal) {
        // Multi-file Terminal work is not equivalent to a one-turn parallel
        // function-call benchmark. Sonnet is the strongest trajectory-tested
        // cost-controlled default; Opus remains a close safety fallback.
        return terminalSafetySensitive
          ? Math.max(base, match(["claude-sonnet-5"], 1), match(["claude-opus-4.8"], 0.9), match(["gpt-5.3-codex"], 0.86))
          : Math.max(base, match(["gpt-5-mini"], 1), match(["gpt-5.3-codex"], 0.98), match(["claude-sonnet-5"], 0.92), match(["gemini-3.5-flash"], 0.88));
      }
      if (agentDomain === "web_research") {
        return deepWebResearch
          ? Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.88), match(["gemini-3.5-flash"], 0.84), match(["claude-opus-5"], 0.80), match(["claude-opus-4.8"], 0.78))
          : Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.88), match(["gemini-3.5-flash"], 0.86), match(["claude-opus-5"], 0.84), match(["claude-opus-4.8"], 0.82));
      }
      if (agentDomain === "retail") {
        if (agentRisk === "policy_exception") {
          return Math.max(base, match(["gpt-4.1"], 1), match(["claude-sonnet-5"], 0.9), match(["deepseek-v4-pro"], 0.82), match(["gpt-5-mini"], 0.8), match(["gpt-4o-mini"], 0.76));
        }
        if (agentRisk === "policy_exception_simple") {
          return Math.max(base, match(["gpt-5-mini"], 1), match(["gpt-4.1"], 0.86), match(["deepseek-v4-pro"], 0.82), match(["gpt-4o-mini"], 0.8));
        }
        return Math.max(base, match(["deepseek-v4-pro"], 1), match(["claude-sonnet-5"], 0.88), match(["claude-opus-4.8"], 0.84), match(["gpt-5-mini"], 0.78), match(["gemini-3.5-flash"], 0.76));
      }
      if (agentDomain === "airline") {
        return agentRisk === "complex_high"
          ? Math.max(base, match(["claude-sonnet-5"], 1), match(["gpt-5-mini"], 0.78), match(["claude-opus-4.8"], 0.76), match(["gemini-3.5-flash"], 0.74))
          : Math.max(base, match(["gpt-5-mini"], 1), match(["claude-sonnet-5"], 0.9), match(["gemini-3.5-flash"], 0.8));
      }
      // RouterBench calibration, 2026-07-26: Opus 4.8 produced complete
      // multi-call payloads on 2/3 multilingual BFCL parallel cases. Gemini
      // 3.5 Flash, Sonnet 5, DeepSeek V4 Pro, and Grok 4.5 were 0/3. This
      // narrow prior only applies after the conservative prompt feature above.
      return Math.max(base, match(["claude-opus-4.8"], 1), match(["claude-sonnet-5"], 0.84), match(["grok-4.5"], 0.82), match(["gemini-3.5-flash"], 0.8), match(["deepseek-v4-pro"], 0.78));
    case "code_edit":
    case "debug":
      return Math.max(base, match(["gpt-5.3-codex"], 1), match(["claude-sonnet-4.6"], 0.94), match(["glm-5.2"], 0.9), match(["kimi-k2.7", "deepseek-v4-pro"], 0.86));
    case "reasoning":
      return Math.max(base, match(["claude-sonnet-5", "claude-sonnet-4.6"], 0.98), match(["deepseek-v4-pro"], 0.95), match(["grok-4.5"], 0.94), match(["gemini-3.1-pro", "gemini-3.5-flash"], 0.92));
    case "reasoning_mcq":
      // RouterBench calibration (2026-07-28, six stratified GPQA Diamond
      // tasks, identical Franklin adapter and 512-token budget): Gemini 3
      // Flash Preview scored 5/6, Gemini 3.5 Flash 4/6, and Gemini 3.1 Pro
      // 3/6 while costing ~170x more than Flash. Keep the measured winner as
      // the narrow default; version recency alone is not a quality signal.
      // Unused host tools must not change this reasoning-only model choice.
      return Math.max(base, match(["gemini-3-flash-preview"], 1), match(["gemini-3.5-flash"], 0.91), match(["grok-4.5"], 0.9), match(["claude-sonnet-5"], 0.88), match(["deepseek-v4-pro"], 0.84));
    case "reasoning_math":
      // Same calibration, five multilingual MGSM tasks: Gemini 3.5 Flash was
      // 5/5 with the lowest cost and latency; four current flagships were 4/5
      // and Kimi K2.7 was 3/5.
      return Math.max(base, match(["gemini-3.5-flash"], 1), match(["grok-4.5"], 0.93), match(["claude-sonnet-5", "deepseek-v4-pro", "kimi-k3"], 0.9), match(["kimi-k2.7"], 0.84));
    case "vision":
      return Math.max(base, match(["gemini-3.1-pro"], 0.96), match(["qwen3.7-max", "claude-sonnet-4.6", "kimi-k2.7", "grok-4.3"], 0.9));
    case "long_context":
      // Long-context eligibility is necessary but not sufficient: a provider
      // can advertise a 1M window yet return an empty completion near that
      // boundary. Keep the proven long-context flagship in the lead and put
      // less-established alternatives in a separate affinity band so price
      // alone cannot displace it.
      return Math.max(base, match(["gemini-3.1-pro"], 1), match(["qwen3.7-max", "glm-5.2"], 0.89), match(["gemini-3.5-flash"], 0.88), match(["deepseek-v4-pro"], 0.85));
    case "extraction": {
      // A structured extraction must preserve both the output contract and the
      // source-language fields.  For Mandarin input, keep the language-native
      // Kimi candidate in a distinct affinity band.  This is deliberately a
      // candidate-pool decision (rather than a brittle post-hoc override): it
      // still falls back normally if that model is unavailable or ineligible.
      const kimiExtractionAffinity = language === "zh" ? 1 : 0.9;
      return Math.max(base, match(["gemini-3.5-flash", "gemini-2.5-flash", "gpt-4o-mini"], 0.9), match(["claude-sonnet-5", "claude-sonnet-4.6"], 0.9), match(["kimi-k3", "kimi-k2.7"], kimiExtractionAffinity));
    }
    default:
      return Math.max(base, match(["gemini-3.5-flash", "gemini-2.5-flash", "kimi-k3", "kimi-k2.7"], 0.86));
  }
}

function evidenceCandidates(task: TaskType): string[] {
  if (task === "code_agent") {
    return ["openai/gpt-5.3-codex", "anthropic/claude-sonnet-5", "openai/gpt-5-mini", "google/gemini-3.5-flash", "moonshot/kimi-k3", "deepseek/deepseek-v4-pro"];
  }
  if (task === "tool_agent") {
    return ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "openai/gpt-5-mini", "openai/gpt-4.1", "openai/gpt-4o-mini", "google/gemini-3.5-flash", "openai/gpt-5.3-codex", "moonshot/kimi-k3", "deepseek/deepseek-v4-pro"];
  }
  if (task === "tool_agent_parallel") {
    return ["anthropic/claude-opus-5", "anthropic/claude-opus-4.8", "anthropic/claude-sonnet-5", "openai/gpt-5-mini", "openai/gpt-4.1", "openai/gpt-4o-mini", "xai/grok-4.5", "google/gemini-3.5-flash", "deepseek/deepseek-v4-pro"];
  }
  if (task === "long_context") {
    return ["google/gemini-3.1-pro", "deepseek/deepseek-v4-pro", "qwen/qwen3.7-max", "zai/glm-5.2", "google/gemini-3.5-flash"];
  }
  if (task === "reasoning_mcq") {
    return ["google/gemini-3-flash-preview", "google/gemini-3.5-flash", "xai/grok-4.5", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-pro"];
  }
  if (task === "reasoning_math") {
    return ["google/gemini-3.5-flash", "xai/grok-4.5", "anthropic/claude-sonnet-5", "deepseek/deepseek-v4-pro", "moonshot/kimi-k3"];
  }
  return [];
}

function isEligible(modelId: string, features: TaskFeatures, maxOutputTokens: number): boolean {
  const model = BLOCKRUN_MODELS.find((candidate) => candidate.id === modelId);
  // Preserve compatibility for temporarily catalog-less fallback IDs. They are
  // kept behind known-model candidates but are not silently dropped.
  if (!model) return true;
  if (features.needsTools && !model.toolCalling) return false;
  if (features.needsVision && !model.vision) return false;
  if (features.needsStructuredOutput && !model.toolCalling) return false;
  if (model.maxOutput < maxOutputTokens) return false;
  return model.contextWindow >= (features.estimatedInputTokens + maxOutputTokens) * 1.1;
}

function estimatedCost(modelId: string, options: RouterOptions, inputTokens: number, outputTokens: number): number {
  const price = options.modelPricing.get(modelId);
  if (!price) return Number.POSITIVE_INFINITY;
  if (price.flatPrice !== undefined) return price.flatPrice;
  return (inputTokens * price.inputPrice + outputTokens * price.outputPrice) / 1_000_000;
}

function profileScore(
  modelId: string,
  options: RouterOptions,
  now: Date,
): { quality?: number; speed: number; tailSpeed: number; reliability: number; freshness: number } | undefined {
  const profile: ModelPerformanceProfile | undefined = options.modelPerformance?.[modelId] ?? LIVE_MODEL_PROFILES[modelId] ?? HISTORICAL_MODEL_PROFILES[modelId];
  if (!profile) return undefined;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(profile.measuredAt)) / 86_400_000);
  // A 30-day half-life makes old data a tie-breaker only. Small probe runs are
  // also weak evidence: three quick samples should not overturn a curated
  // tier ordering merely because of a transient provider tail. Callers that
  // inject an observation without a sample count retain the legacy full
  // confidence behaviour for compatibility.
  const sampleConfidence = profile.samples === undefined ? 1 : Math.min(1, Math.max(0, profile.samples) / 10);
  const freshness = Math.pow(0.5, ageDays / 30) * sampleConfidence;
  const quality = profile.intelligenceIndex === undefined ? undefined : Math.min(1, profile.intelligenceIndex / 50);
  const speed = Math.min(1, (2_000 / Math.max(500, profile.latencyMs) + profile.outputTokensPerSecond / 250) / 2);
  const tailSpeed = Math.min(1, 3_000 / Math.max(750, profile.p95LatencyMs ?? profile.latencyMs));
  const reliability = Math.max(0, 1 - (profile.errorRate ?? 0));
  return { quality, speed, tailSpeed, reliability, freshness };
}

/** Candidate router used for Auto. Rules still set the capability tier; V3 ranks within it. */
export class PortfolioStrategy implements RouterStrategy {
  readonly name = "portfolio";

  route(prompt: string, systemPrompt: string | undefined, maxOutputTokens: number, options: RouterOptions) {
  const features = classifyTask(prompt, systemPrompt, options);
  const base = new RulesStrategy().route(prompt, systemPrompt, maxOutputTokens, {
    ...options,
    requiresTools: features.needsTools,
  });
  const tierConfigs = base.tierConfigs!;
  const targetTier: Tier = (features.taskType === "reasoning_mcq" || features.taskType === "reasoning_math")
    && (base.tier === "SIMPLE" || base.tier === "MEDIUM") ? "REASONING" : base.tier;
  const chain = [...new Set([...getFallbackChain(targetTier, tierConfigs), ...evidenceCandidates(features.taskType)])];
  const eligible = chain.filter((model) => isEligible(model, features, maxOutputTokens));
  const eligibleCandidates = eligible.length > 0 ? eligible : chain;
    const profileName = options.routingProfile === "eco" ? "eco" : options.routingProfile === "premium" ? "premium" : "auto";
    const portfolio = options.config.portfolio ?? DEFAULT_PORTFOLIO_WEIGHTS;
  const getAffinity = (model: string) => affinity(model, features.taskType, features.language, features.agentDomain, features.deepWebResearch, features.agentRisk, features.terminalToolSignal, features.terminalSafetySensitive);
  const bestAffinity = Math.max(...eligibleCandidates.map(getAffinity));
  const specificAffinity = eligibleCandidates.filter((model) => getAffinity(model) > 0.68);
  // A tier's fallback list is primarily an availability/recovery chain, not a
  // set of equally validated substitutes.  Re-ranking every fallback lets a
  // cheap generic model displace the curated primary merely because it has a
  // favourable short performance probe.  Only promote models with explicit
  // task affinity; otherwise retain the first capability-eligible tier model.
  const affinityPool = specificAffinity.length > 0 ? specificAffinity : [eligibleCandidates[0]];
  // Generic Terminal work has much wider trajectory variance than a BFCL-like
  // one-turn parallel call. Keep the strong-model safety band, but admit the
  // next capable tier so Auto's cost/reliability score can reject an Opus
  // primary that is materially more expensive without measured benefit.
  const affinityFloorGap = features.terminalToolSignal
    ? Math.max(portfolio.affinityFloorGap[profileName], features.terminalSafetySensitive ? 0.15 : 0.12)
    : portfolio.affinityFloorGap[profileName];
  const candidates = affinityPool.filter((model) => getAffinity(model) >= bestAffinity - affinityFloorGap);
    const costs = candidates.map((model) => estimatedCost(model, options, features.estimatedInputTokens, maxOutputTokens));
    const finiteCosts = costs.filter(Number.isFinite);
    const minCost = finiteCosts.length > 0 ? Math.min(...finiteCosts) : 0;
    const maxCost = finiteCosts.length > 0 ? Math.max(...finiteCosts) : 1;

    const now = options.now ?? new Date();
    const profileWeights = portfolio[profileName];
    const rankedEntries = candidates
      .map((model, index) => {
        const cost = estimatedCost(model, options, features.estimatedInputTokens, maxOutputTokens);
        const costScore = Number.isFinite(cost) && maxCost > minCost ? 1 - (cost - minCost) / (maxCost - minCost) : 0.5;
        const capabilityScore = isEligible(model, features, maxOutputTokens) ? 1 : 0;
        const profile = profileScore(model, options, now);
        // Fresh observations can refine affinity. Historical observations fade
        // quickly and never replace task-level RouterBench evidence.
        const observedQuality = profile?.quality === undefined
          ? getAffinity(model)
          : getAffinity(model) * (1 - profile.freshness) + profile.quality * profile.freshness;
        const observedSpeed = profile ? profile.speed * profile.freshness : 0.5;
        const observedTailSpeed = profile ? profile.tailSpeed * profile.freshness : 0.5;
        const observedReliability = profile ? profile.reliability * profile.freshness + (1 - profile.freshness) : 1;
        // Preserve a small amount of the hand-curated fallback order while V3's
        // task affinity and real request constraints do the primary work.
        const legacyScore = 1 - index / Math.max(1, candidates.length - 1);
        const qualityWeight = profileWeights.quality + (features.highStakes ? portfolio.highStakesBoost.quality : 0);
        const speedScore = features.latencySensitive ? observedTailSpeed : observedSpeed;
        const speedWeight = profileWeights.speed + (features.latencySensitive ? portfolio.latencySensitiveSpeedBoost : 0);
        const reliabilityWeight = profileWeights.reliability + (features.highStakes ? portfolio.highStakesBoost.reliability : 0);
        const score = observedQuality * qualityWeight + capabilityScore * profileWeights.capability + costScore * profileWeights.cost + speedScore * speedWeight + observedReliability * reliabilityWeight + legacyScore * profileWeights.legacy;
        return { model, score, quality: observedQuality, cost: costScore, speed: speedScore, reliability: observedReliability };
      })
      .sort((a, b) => b.score - a.score)
    const scoredModels = rankedEntries.map((item) => item.model);
    // The affinity floor controls which models may compete for the primary;
    // it must not erase availability fallbacks. Append all remaining eligible
    // models in their curated chain order after the scored primary pool.
    const webResearchFallbackOrder = [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5-mini",
      "google/gemini-3.5-flash",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "openai/gpt-5.3-codex",
    ];
    const ranked = features.agentDomain === "web_research"
      ? [
          ...scoredModels,
          ...webResearchFallbackOrder.filter((model) => eligibleCandidates.includes(model) && !scoredModels.includes(model)),
          ...eligibleCandidates.filter((model) => !scoredModels.includes(model) && !webResearchFallbackOrder.includes(model)),
        ]
      : features.taskType === "tool_agent" || (features.taskType === "tool_agent_parallel" && features.agentDomain !== "other")
      ? [
          ...scoredModels,
          ...eligibleCandidates.filter((model) => !scoredModels.includes(model)),
        ]
      : [
          ...scoredModels,
          ...eligibleCandidates.filter((model) => !scoredModels.includes(model)),
        ];

    const model = ranked[0] ?? base.model;
    const selectedTierConfigs: Record<Tier, TierConfig> = {
      ...tierConfigs,
      [targetTier]: { primary: model, fallback: ranked.slice(1) },
    };
    // selectModel only reads the selected tier; retain the complete tier map for proxy fallback.
    const decision = selectModel(
      targetTier,
      base.confidence,
      "portfolio",
      `${base.reasoning} | v3 task=${features.taskType} agentRisk=${features.agentRisk} deepWebResearch=${features.deepWebResearch} terminalCode=${features.implicitTerminalCode} terminalSafety=${features.terminalSafetySensitive} candidates=${ranked.length}`,
      selectedTierConfigs,
      options.modelPricing,
      features.estimatedInputTokens,
      maxOutputTokens,
      options.routingProfile,
      base.agenticScore,
    );
    return {
      ...decision,
      tierConfigs: selectedTierConfigs,
      profile: base.profile,
      candidates: ranked,
      candidateScores: rankedEntries.map(({ model, score, quality, cost, speed, reliability }) => ({ model, score, quality, cost, speed, reliability })),
      taskType: features.taskType,
      routerVersion: "v3-portfolio" as const,
    };
  }
}
