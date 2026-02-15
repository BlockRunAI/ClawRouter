/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 */

import type { RoutingConfig } from "./types.js";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "2.0",

  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3_600_000, // 1 hour
  },

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },

    // Multilingual keywords: English + Chinese (中文) + Japanese (日本語) + Russian (Русский) + German (Deutsch)
    codeKeywords: [
      // English
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      // Chinese
      "函数",
      "类",
      "导入",
      "定义",
      "查询",
      "异步",
      "等待",
      "常量",
      "变量",
      "返回",
      // Japanese
      "関数",
      "クラス",
      "インポート",
      "非同期",
      "定数",
      "変数",
      // Russian
      "функция",
      "класс",
      "импорт",
      "определ",
      "запрос",
      "асинхронный",
      "ожидать",
      "константа",
      "переменная",
      "вернуть",
      // German
      "funktion",
      "klasse",
      "importieren",
      "definieren",
      "abfrage",
      "asynchron",
      "erwarten",
      "konstante",
      "variable",
      "zurückgeben",
    ],
    reasoningKeywords: [
      // English
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      // Chinese
      "证明",
      "定理",
      "推导",
      "逐步",
      "思维链",
      "形式化",
      "数学",
      "逻辑",
      // Japanese
      "証明",
      "定理",
      "導出",
      "ステップバイステップ",
      "論理的",
      // Russian
      "доказать",
      "докажи",
      "доказательств",
      "теорема",
      "вывести",
      "шаг за шагом",
      "пошагово",
      "поэтапно",
      "цепочка рассуждений",
      "рассуждени",
      "формально",
      "математически",
      "логически",
      // German
      "beweisen",
      "beweis",
      "theorem",
      "ableiten",
      "schritt für schritt",
      "gedankenkette",
      "formal",
      "mathematisch",
      "logisch",
    ],
    simpleKeywords: [
      // English
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      // Chinese
      "什么是",
      "定义",
      "翻译",
      "你好",
      "是否",
      "首都",
      "多大",
      "谁是",
      "何时",
      // Japanese
      "とは",
      "定義",
      "翻訳",
      "こんにちは",
      "はいかいいえ",
      "首都",
      "誰",
      // Russian
      "что такое",
      "определение",
      "перевести",
      "переведи",
      "привет",
      "да или нет",
      "столица",
      "сколько лет",
      "кто такой",
      "когда",
      "объясни",
      // German
      "was ist",
      "definiere",
      "übersetze",
      "hallo",
      "ja oder nein",
      "hauptstadt",
      "wie alt",
      "wer ist",
      "wann",
      "erkläre",
    ],
    technicalKeywords: [
      // English
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      // Chinese
      "算法",
      "优化",
      "架构",
      "分布式",
      "微服务",
      "数据库",
      "基础设施",
      // Japanese
      "アルゴリズム",
      "最適化",
      "アーキテクチャ",
      "分散",
      "マイクロサービス",
      "データベース",
      // Russian
      "алгоритм",
      "оптимизировать",
      "оптимизаци",
      "оптимизируй",
      "архитектура",
      "распределённый",
      "микросервис",
      "база данных",
      "инфраструктура",
      // German
      "algorithmus",
      "optimieren",
      "architektur",
      "verteilt",
      "kubernetes",
      "mikroservice",
      "datenbank",
      "infrastruktur",
    ],
    creativeKeywords: [
      // English
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      // Chinese
      "故事",
      "诗",
      "创作",
      "头脑风暴",
      "创意",
      "想象",
      "写一个",
      // Japanese
      "物語",
      "詩",
      "作曲",
      "ブレインストーム",
      "創造的",
      "想像",
      // Russian
      "история",
      "рассказ",
      "стихотворение",
      "сочинить",
      "сочини",
      "мозговой штурм",
      "творческий",
      "представить",
      "придумай",
      "напиши",
      // German
      "geschichte",
      "gedicht",
      "komponieren",
      "brainstorming",
      "kreativ",
      "vorstellen",
      "schreibe",
      "erzählung",
    ],

    // New dimension keyword lists (multilingual)
    imperativeVerbs: [
      // English
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      // Chinese
      "构建",
      "创建",
      "实现",
      "设计",
      "开发",
      "生成",
      "部署",
      "配置",
      "设置",
      // Japanese
      "構築",
      "作成",
      "実装",
      "設計",
      "開発",
      "生成",
      "デプロイ",
      "設定",
      // Russian
      "построить",
      "построй",
      "создать",
      "создай",
      "реализовать",
      "реализуй",
      "спроектировать",
      "разработать",
      "разработай",
      "сконструировать",
      "сгенерировать",
      "сгенерируй",
      "развернуть",
      "разверни",
      "настроить",
      "настрой",
      // German
      "erstellen",
      "bauen",
      "implementieren",
      "entwerfen",
      "entwickeln",
      "konstruieren",
      "generieren",
      "bereitstellen",
      "konfigurieren",
      "einrichten",
    ],
    constraintIndicators: [
      // English
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      // Chinese
      "不超过",
      "至少",
      "最多",
      "在内",
      "最大",
      "最小",
      "限制",
      "预算",
      // Japanese
      "以下",
      "最大",
      "最小",
      "制限",
      "予算",
      // Russian
      "не более",
      "не менее",
      "как минимум",
      "в пределах",
      "максимум",
      "минимум",
      "ограничение",
      "бюджет",
      // German
      "höchstens",
      "mindestens",
      "innerhalb",
      "nicht mehr als",
      "maximal",
      "minimal",
      "grenze",
      "budget",
    ],
    outputFormatKeywords: [
      // English
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      // Chinese
      "表格",
      "格式化为",
      "结构化",
      // Japanese
      "テーブル",
      "フォーマット",
      "構造化",
      // Russian
      "таблица",
      "форматировать как",
      "структурированный",
      // German
      "tabelle",
      "formatieren als",
      "strukturiert",
    ],
    referenceKeywords: [
      // English
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      // Chinese
      "上面",
      "下面",
      "之前",
      "接下来",
      "文档",
      "代码",
      "附件",
      // Japanese
      "上記",
      "下記",
      "前の",
      "次の",
      "ドキュメント",
      "コード",
      // Russian
      "выше",
      "ниже",
      "предыдущий",
      "следующий",
      "документация",
      "код",
      "ранее",
      "вложение",
      // German
      "oben",
      "unten",
      "vorherige",
      "folgende",
      "dokumentation",
      "der code",
      "früher",
      "anhang",
    ],
    negationKeywords: [
      // English
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      // Chinese
      "不要",
      "避免",
      "从不",
      "没有",
      "除了",
      "排除",
      // Japanese
      "しないで",
      "避ける",
      "決して",
      "なしで",
      "除く",
      // Russian
      "не делай",
      "не надо",
      "нельзя",
      "избегать",
      "никогда",
      "без",
      "кроме",
      "исключить",
      "больше не",
      // German
      "nicht",
      "vermeide",
      "niemals",
      "ohne",
      "außer",
      "ausschließen",
      "nicht mehr",
    ],
    domainSpecificKeywords: [
      // English
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      // Chinese
      "量子",
      "光子学",
      "基因组学",
      "蛋白质组学",
      "拓扑",
      "同态",
      "零知识",
      "格密码",
      // Japanese
      "量子",
      "フォトニクス",
      "ゲノミクス",
      "トポロジカル",
      // Russian
      "квантовый",
      "фотоника",
      "геномика",
      "протеомика",
      "топологический",
      "гомоморфный",
      "с нулевым разглашением",
      "на основе решёток",
      // German
      "quanten",
      "photonik",
      "genomik",
      "proteomik",
      "topologisch",
      "homomorph",
      "zero-knowledge",
      "gitterbasiert",
    ],

    // Agentic task keywords - file ops, execution, multi-step, iterative work
    // Pruned: removed overly common words like "then", "first", "run", "test", "build"
    agenticTaskKeywords: [
      // English - File operations (clearly agentic)
      "read file",
      "read the file",
      "look at",
      "check the",
      "open the",
      "edit",
      "modify",
      "update the",
      "change the",
      "write to",
      "create file",
      // English - Execution (specific commands only)
      "execute",
      "deploy",
      "install",
      "npm",
      "pip",
      "compile",
      // English - Multi-step patterns (specific only)
      "after that",
      "and also",
      "once done",
      "step 1",
      "step 2",
      // English - Iterative work
      "fix",
      "debug",
      "until it works",
      "keep trying",
      "iterate",
      "make sure",
      "verify",
      "confirm",
      // Chinese (keep specific ones)
      "读取文件",
      "查看",
      "打开",
      "编辑",
      "修改",
      "更新",
      "创建",
      "执行",
      "部署",
      "安装",
      "第一步",
      "第二步",
      "修复",
      "调试",
      "直到",
      "确认",
      "验证",
    ],

    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02, // Reduced from 0.12 to make room for agenticTask
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04, // Reduced - agentic signals influence tier selection, not dominate it
    },

    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0.0,
      mediumComplex: 0.3, // Raised from 0.18 - prevent simple tasks from reaching expensive COMPLEX tier
      complexReasoning: 0.5, // Raised from 0.4 - reserve for true reasoning tasks
    },

    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.7,
  },

  // Auto (balanced) tier configs - current default smart routing
  tiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5", // $0.50/$2.40 - best quality/price for simple tasks
      fallback: [
        "google/gemini-2.5-flash", // 1M context, cost-effective
        "nvidia/gpt-oss-120b", // FREE fallback
        "deepseek/deepseek-chat",
      ],
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1", // Code specialist, $0.20/$1.50
      fallback: [
        "google/gemini-2.5-flash", // 1M context, cost-effective
        "deepseek/deepseek-chat",
        "xai/grok-4-1-fast-non-reasoning", // Upgraded Grok 4.1
      ],
    },
    COMPLEX: {
      primary: "google/gemini-3-pro-preview", // Latest Gemini - upgraded from 2.5
      fallback: [
        "google/gemini-2.5-flash", // CRITICAL: 1M context, cheap failsafe before expensive models
        "google/gemini-2.5-pro",
        "deepseek/deepseek-chat", // Another cheap option
        "xai/grok-4-0709",
        "openai/gpt-4o",
        "openai/gpt-5.2",
        "anthropic/claude-sonnet-4",
      ],
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning", // Upgraded Grok 4.1 reasoning $0.20/$0.50
      fallback: [
        "deepseek/deepseek-reasoner", // Cheap reasoning model as first fallback
        "xai/grok-4-fast-reasoning",
        "openai/o3",
        "openai/o4-mini", // Latest o-series mini
        "moonshot/kimi-k2.5",
      ],
    },
  },

  // Eco tier configs - ultra cost-optimized (blockrun/eco)
  ecoTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5", // $0.50/$2.40
      fallback: ["nvidia/gpt-oss-120b", "deepseek/deepseek-chat", "google/gemini-2.5-flash"],
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat", // $0.14/$0.28
      fallback: ["xai/grok-code-fast-1", "google/gemini-2.5-flash", "moonshot/kimi-k2.5"],
    },
    COMPLEX: {
      primary: "xai/grok-4-0709", // $0.20/$1.50
      fallback: ["deepseek/deepseek-chat", "google/gemini-2.5-flash", "openai/gpt-4o-mini"],
    },
    REASONING: {
      primary: "deepseek/deepseek-reasoner", // $0.55/$2.19
      fallback: ["xai/grok-4-fast-reasoning", "moonshot/kimi-k2.5"],
    },
  },

  // Premium tier configs - best quality (blockrun/premium)
  // kimi=coding, sonnet=reasoning/instructions, opus=heavy lifting/architecture/audits
  premiumTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5", // $0.50/$2.40 - good for coding
      fallback: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash", "xai/grok-code-fast-1"],
    },
    MEDIUM: {
      primary: "anthropic/claude-sonnet-4", // $3/$15 - reasoning/instructions
      fallback: ["moonshot/kimi-k2.5", "google/gemini-2.5-pro", "xai/grok-4-0709"],
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4.5", // $5/$25 - architecture, audits, heavy lifting
      fallback: ["anthropic/claude-sonnet-4", "google/gemini-3-pro-preview", "moonshot/kimi-k2.5"],
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4", // $3/$15 - best for reasoning/instructions
      fallback: ["anthropic/claude-opus-4.5", "openai/o3", "xai/grok-4-1-fast-reasoning"],
    },
  },

  // Agentic tier configs - models that excel at multi-step autonomous tasks
  agenticTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5", // Cheaper than Haiku ($0.5/$2.4 vs $1/$5), larger context
      fallback: [
        "anthropic/claude-haiku-4.5",
        "xai/grok-4-fast-non-reasoning",
        "openai/gpt-4o-mini",
      ],
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1", // Code specialist for agentic coding
      fallback: ["moonshot/kimi-k2.5", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4"],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4",
      fallback: [
        "anthropic/claude-opus-4.5", // Latest Opus - best agentic
        "openai/gpt-5.2",
        "google/gemini-3-pro-preview",
        "xai/grok-4-0709",
      ],
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4", // Strong tool use + reasoning for agentic tasks
      fallback: [
        "anthropic/claude-opus-4.5",
        "xai/grok-4-fast-reasoning",
        "moonshot/kimi-k2.5",
        "deepseek/deepseek-reasoner",
      ],
    },
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM",
    agenticMode: false,
  },
};
