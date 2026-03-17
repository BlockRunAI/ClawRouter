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

    // Multilingual keywords: EN + ZH + JA + RU + DE + ES + PT + KO + AR
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
      // Spanish
      "función",
      "clase",
      "importar",
      "definir",
      "consulta",
      "asíncrono",
      "esperar",
      "constante",
      "variable",
      "retornar",
      // Portuguese
      "função",
      "classe",
      "importar",
      "definir",
      "consulta",
      "assíncrono",
      "aguardar",
      "constante",
      "variável",
      "retornar",
      // Korean
      "함수",
      "클래스",
      "가져오기",
      "정의",
      "쿼리",
      "비동기",
      "대기",
      "상수",
      "변수",
      "반환",
      // Arabic
      "دالة",
      "فئة",
      "استيراد",
      "تعريف",
      "استعلام",
      "غير متزامن",
      "انتظار",
      "ثابت",
      "متغير",
      "إرجاع",
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
      // Spanish
      "demostrar",
      "teorema",
      "derivar",
      "paso a paso",
      "cadena de pensamiento",
      "formalmente",
      "matemático",
      "prueba",
      "lógicamente",
      // Portuguese
      "provar",
      "teorema",
      "derivar",
      "passo a passo",
      "cadeia de pensamento",
      "formalmente",
      "matemático",
      "prova",
      "logicamente",
      // Korean
      "증명",
      "정리",
      "도출",
      "단계별",
      "사고의 연쇄",
      "형식적",
      "수학적",
      "논리적",
      // Arabic
      "إثبات",
      "نظرية",
      "اشتقاق",
      "خطوة بخطوة",
      "سلسلة التفكير",
      "رسمياً",
      "رياضي",
      "برهان",
      "منطقياً",
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
      // Spanish
      "qué es",
      "definir",
      "traducir",
      "hola",
      "sí o no",
      "capital de",
      "cuántos años",
      "quién es",
      "cuándo",
      // Portuguese
      "o que é",
      "definir",
      "traduzir",
      "olá",
      "sim ou não",
      "capital de",
      "quantos anos",
      "quem é",
      "quando",
      // Korean
      "무엇",
      "정의",
      "번역",
      "안녕하세요",
      "예 또는 아니오",
      "수도",
      "누구",
      "언제",
      // Arabic
      "ما هو",
      "تعريف",
      "ترجم",
      "مرحبا",
      "نعم أو لا",
      "عاصمة",
      "من هو",
      "متى",
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
      // Spanish
      "algoritmo",
      "optimizar",
      "arquitectura",
      "distribuido",
      "microservicio",
      "base de datos",
      "infraestructura",
      // Portuguese
      "algoritmo",
      "otimizar",
      "arquitetura",
      "distribuído",
      "microsserviço",
      "banco de dados",
      "infraestrutura",
      // Korean
      "알고리즘",
      "최적화",
      "아키텍처",
      "분산",
      "마이크로서비스",
      "데이터베이스",
      "인프라",
      // Arabic
      "خوارزمية",
      "تحسين",
      "بنية",
      "موزع",
      "خدمة مصغرة",
      "قاعدة بيانات",
      "بنية تحتية",
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
      // Spanish
      "historia",
      "poema",
      "componer",
      "lluvia de ideas",
      "creativo",
      "imaginar",
      "escribe",
      // Portuguese
      "história",
      "poema",
      "compor",
      "criativo",
      "imaginar",
      "escreva",
      // Korean
      "이야기",
      "시",
      "작곡",
      "브레인스토밍",
      "창의적",
      "상상",
      "작성",
      // Arabic
      "قصة",
      "قصيدة",
      "تأليف",
      "عصف ذهني",
      "إبداعي",
      "تخيل",
      "اكتب",
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
      // Spanish
      "construir",
      "crear",
      "implementar",
      "diseñar",
      "desarrollar",
      "generar",
      "desplegar",
      "configurar",
      // Portuguese
      "construir",
      "criar",
      "implementar",
      "projetar",
      "desenvolver",
      "gerar",
      "implantar",
      "configurar",
      // Korean
      "구축",
      "생성",
      "구현",
      "설계",
      "개발",
      "배포",
      "설정",
      // Arabic
      "بناء",
      "إنشاء",
      "تنفيذ",
      "تصميم",
      "تطوير",
      "توليد",
      "نشر",
      "إعداد",
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
      // Spanish
      "como máximo",
      "al menos",
      "dentro de",
      "no más de",
      "máximo",
      "mínimo",
      "límite",
      "presupuesto",
      // Portuguese
      "no máximo",
      "pelo menos",
      "dentro de",
      "não mais que",
      "máximo",
      "mínimo",
      "limite",
      "orçamento",
      // Korean
      "이하",
      "이상",
      "최대",
      "최소",
      "제한",
      "예산",
      // Arabic
      "على الأكثر",
      "على الأقل",
      "ضمن",
      "لا يزيد عن",
      "أقصى",
      "أدنى",
      "حد",
      "ميزانية",
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
      // Spanish
      "tabla",
      "formatear como",
      "estructurado",
      // Portuguese
      "tabela",
      "formatar como",
      "estruturado",
      // Korean
      "테이블",
      "형식",
      "구조화",
      // Arabic
      "جدول",
      "تنسيق",
      "منظم",
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
      // Spanish
      "arriba",
      "abajo",
      "anterior",
      "siguiente",
      "documentación",
      "el código",
      "adjunto",
      // Portuguese
      "acima",
      "abaixo",
      "anterior",
      "seguinte",
      "documentação",
      "o código",
      "anexo",
      // Korean
      "위",
      "아래",
      "이전",
      "다음",
      "문서",
      "코드",
      "첨부",
      // Arabic
      "أعلاه",
      "أدناه",
      "السابق",
      "التالي",
      "الوثائق",
      "الكود",
      "مرفق",
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
      // Spanish
      "no hagas",
      "evitar",
      "nunca",
      "sin",
      "excepto",
      "excluir",
      // Portuguese
      "não faça",
      "evitar",
      "nunca",
      "sem",
      "exceto",
      "excluir",
      // Korean
      "하지 마",
      "피하다",
      "절대",
      "없이",
      "제외",
      // Arabic
      "لا تفعل",
      "تجنب",
      "أبداً",
      "بدون",
      "باستثناء",
      "استبعاد",
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
      // Spanish
      "cuántico",
      "fotónica",
      "genómica",
      "proteómica",
      "topológico",
      "homomórfico",
      // Portuguese
      "quântico",
      "fotônica",
      "genômica",
      "proteômica",
      "topológico",
      "homomórfico",
      // Korean
      "양자",
      "포토닉스",
      "유전체학",
      "위상",
      "동형",
      // Arabic
      "كمي",
      "ضوئيات",
      "جينوميات",
      "طوبولوجي",
      "تماثلي",
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
      // Spanish
      "leer archivo",
      "editar",
      "modificar",
      "actualizar",
      "ejecutar",
      "desplegar",
      "instalar",
      "paso 1",
      "paso 2",
      "arreglar",
      "depurar",
      "verificar",
      // Portuguese
      "ler arquivo",
      "editar",
      "modificar",
      "atualizar",
      "executar",
      "implantar",
      "instalar",
      "passo 1",
      "passo 2",
      "corrigir",
      "depurar",
      "verificar",
      // Korean
      "파일 읽기",
      "편집",
      "수정",
      "업데이트",
      "실행",
      "배포",
      "설치",
      "단계 1",
      "단계 2",
      "디버그",
      "확인",
      // Arabic
      "قراءة ملف",
      "تحرير",
      "تعديل",
      "تحديث",
      "تنفيذ",
      "نشر",
      "تثبيت",
      "الخطوة 1",
      "الخطوة 2",
      "إصلاح",
      "تصحيح",
      "تحقق",
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
  // Benchmark-tuned 2026-03-16: balancing quality (retention) + latency
  tiers: {
    SIMPLE: {
      primary: "google/gemini-2.5-flash", // 1,238ms, IQ 20, 60% retention (best) — fast AND quality
      fallback: [
        "google/gemini-3-flash-preview", // 1,398ms, IQ 46 — smarter fallback
        "deepseek/deepseek-chat", // 1,431ms, IQ 32, 41% retention
        "moonshot/kimi-k2.5", // 1,646ms, IQ 47, strong quality
        "google/gemini-2.5-flash-lite", // 1,353ms, 1M context, ultra cheap ($0.10/$0.40)
        "xai/grok-4-fast-non-reasoning", // 1,143ms, $0.20/$0.50 — fast fallback
        "nvidia/gpt-oss-120b", // 1,252ms, FREE fallback
      ],
    },
    MEDIUM: {
      primary: "moonshot/kimi-k2.5", // 1,646ms, IQ 47, $0.60/$3.00 — strong tool use, quality output
      fallback: [
        "google/gemini-3-flash-preview", // 1,398ms, IQ 46 — nearly same IQ, faster + cheaper
        "deepseek/deepseek-chat", // 1,431ms, IQ 32, 41% retention
        "google/gemini-2.5-flash", // 1,238ms, 60% retention
        "google/gemini-2.5-flash-lite", // 1,353ms, 1M context ($0.10/$0.40)
        "xai/grok-4-1-fast-non-reasoning", // 1,244ms, fast fallback
        "xai/grok-3-mini", // 1,202ms, $0.30/$0.50
      ],
    },
    COMPLEX: {
      primary: "google/gemini-3.1-pro", // 1,609ms, IQ 57 — fast flagship quality
      fallback: [
        "google/gemini-3-pro-preview", // 1,352ms, IQ 48 — quality-first fallback
        "google/gemini-3-flash-preview", // 1,398ms, IQ 46 — fast + smart
        "xai/grok-4-0709", // 1,348ms, IQ 41
        "google/gemini-2.5-pro", // 1,294ms
        "anthropic/claude-sonnet-4.6", // 2,110ms, IQ 52 — quality fallback
        "deepseek/deepseek-chat", // 1,431ms, IQ 32
        "google/gemini-2.5-flash", // 1,238ms, IQ 20 — cheap last resort
        "openai/gpt-5.4", // 6,213ms, IQ 57 — slowest but highest quality
      ],
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning", // 1,454ms, $0.20/$0.50
      fallback: [
        "xai/grok-4-fast-reasoning", // 1,298ms, $0.20/$0.50
        "deepseek/deepseek-reasoner", // 1,454ms, cheap reasoning
        "openai/o4-mini", // 2,328ms ($1.10/$4.40)
        "openai/o3", // 2,862ms
      ],
    },
  },

  // Eco tier configs - absolute cheapest (blockrun/eco)
  ecoTiers: {
    SIMPLE: {
      primary: "nvidia/gpt-oss-120b", // 1,252ms, FREE! $0.00/$0.00
      fallback: [
        "google/gemini-2.5-flash-lite", // 1,353ms, $0.10/$0.40
        "xai/grok-4-fast-non-reasoning", // 1,143ms, $0.20/$0.50
        "google/gemini-2.5-flash", // 1,238ms
      ],
    },
    MEDIUM: {
      primary: "google/gemini-2.5-flash-lite", // 1,353ms, $0.10/$0.40 - cheapest capable with 1M context
      fallback: [
        "xai/grok-4-fast-non-reasoning",
        "google/gemini-2.5-flash",
        "deepseek/deepseek-chat",
        "nvidia/gpt-oss-120b",
      ],
    },
    COMPLEX: {
      primary: "google/gemini-2.5-flash-lite", // 1,353ms, $0.10/$0.40 - 1M context handles complexity
      fallback: ["xai/grok-4-0709", "google/gemini-2.5-flash", "deepseek/deepseek-chat"],
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning", // 1,454ms, $0.20/$0.50
      fallback: ["xai/grok-4-fast-reasoning", "deepseek/deepseek-reasoner"],
    },
  },

  // Premium tier configs - best quality (blockrun/premium)
  // codex=complex coding, kimi=simple coding, sonnet=reasoning/instructions, opus=architecture/PM/audits
  premiumTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5", // $0.60/$3.00 - good for simple coding
      fallback: [
        "google/gemini-2.5-flash", // 60% retention, fast growth
        "anthropic/claude-haiku-4.5",
        "google/gemini-2.5-flash-lite",
        "deepseek/deepseek-chat",
      ],
    },
    MEDIUM: {
      primary: "openai/gpt-5.3-codex", // $1.75/$14 - 400K context, 128K output, replaces 5.2
      fallback: [
        "moonshot/kimi-k2.5",
        "google/gemini-2.5-flash", // 60% retention, good coding capability
        "google/gemini-2.5-pro",
        "xai/grok-4-0709",
        "anthropic/claude-sonnet-4.6",
      ],
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4.6", // Best quality for complex tasks
      fallback: [
        "openai/gpt-5.4", // Newest flagship
        "openai/gpt-5.3-codex",
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
        "google/gemini-3.1-pro", // Newest Gemini
        "google/gemini-3-pro-preview",
        "moonshot/kimi-k2.5",
      ],
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6", // 2,110ms, $3/$15 - best for reasoning/instructions
      fallback: [
        "anthropic/claude-opus-4.6", // 2,139ms
        "xai/grok-4-1-fast-reasoning", // 1,454ms, cheap fast reasoning
        "openai/o4-mini", // 2,328ms ($1.10/$4.40)
        "openai/o3", // 2,862ms
      ],
    },
  },

  // Agentic tier configs - models that excel at multi-step autonomous tasks
  agenticTiers: {
    SIMPLE: {
      primary: "openai/gpt-4o-mini", // $0.15/$0.60 - best tool compliance at lowest cost
      fallback: [
        "moonshot/kimi-k2.5", // 1,646ms, strong tool use quality
        "anthropic/claude-haiku-4.5", // 2,305ms
        "xai/grok-4-1-fast-non-reasoning", // 1,244ms, fast fallback
      ],
    },
    MEDIUM: {
      primary: "moonshot/kimi-k2.5", // 1,646ms, $0.60/$3.00 - strong tool use, proper function calls
      fallback: [
        "xai/grok-4-1-fast-non-reasoning", // 1,244ms, fast fallback
        "openai/gpt-4o-mini", // 2,764ms, reliable tool calling
        "anthropic/claude-haiku-4.5", // 2,305ms
        "deepseek/deepseek-chat", // 1,431ms
      ],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4.6", // 2,110ms — best agentic quality
      fallback: [
        "anthropic/claude-opus-4.6", // 2,139ms — top quality
        "google/gemini-3.1-pro", // 1,609ms
        "xai/grok-4-0709", // 1,348ms
        "openai/gpt-5.4", // 6,213ms — slow but highest quality fallback
      ],
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6", // 2,110ms — strong tool use + reasoning
      fallback: [
        "anthropic/claude-opus-4.6", // 2,139ms
        "xai/grok-4-1-fast-reasoning", // 1,454ms
        "deepseek/deepseek-reasoner", // 1,454ms
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
