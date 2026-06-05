import { ToolInfo } from "./aggregator.js";
import * as path from "path";
import { config } from "../config.js";
import type { MessageFormatMode } from "../config.js";
import { logger } from "../utils/logger.js";
import { t } from "../i18n/index.js";
import { getCurrentProject } from "../settings/manager.js";
import { convertToTelegramMarkdownV2 } from "./markdown-to-telegram-v2.js";
import { normalizeMarkdownForTelegramRendering } from "../telegram/render/markdown-normalizer.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const RAW_CODE_FENCE_OVERHEAD = 12; // "```text\n" + "\n```"
const MARKDOWN_V2_RESERVED_CHARS = /([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g;

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return ".".repeat(Math.max(0, maxLength));
  }

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

interface SplitTextOptions {
  avoidTrailingMarkdownEscape?: boolean;
}

function endsWithOddTrailingBackslashes(text: string, start: number, end: number): boolean {
  let backslashCount = 0;

  for (let index = end - 1; index >= start; index--) {
    if (text[index] !== "\\") {
      break;
    }
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function resolveSplitEndIndex(
  text: string,
  currentIndex: number,
  maxLength: number,
  options?: SplitTextOptions,
): number {
  const hardLimit = Math.min(text.length, currentIndex + maxLength);
  if (hardLimit >= text.length) {
    return text.length;
  }

  let endIndex = hardLimit;
  const breakPoint = text.lastIndexOf("\n", endIndex);
  if (breakPoint > currentIndex) {
    endIndex = breakPoint + 1;
  }

  if (!options?.avoidTrailingMarkdownEscape) {
    return endIndex;
  }

  while (endIndex > currentIndex && endsWithOddTrailingBackslashes(text, currentIndex, endIndex)) {
    endIndex -= 1;
  }

  return endIndex > currentIndex ? endIndex : hardLimit;
}

function splitText(text: string, maxLength: number, options?: SplitTextOptions): string[] {
  const parts: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    const endIndex = resolveSplitEndIndex(text, currentIndex, maxLength, options);

    if (endIndex <= currentIndex) {
      const fallbackEnd = Math.min(text.length, currentIndex + 1);
      parts.push(text.slice(currentIndex, fallbackEnd));
      currentIndex = fallbackEnd;
      continue;
    }

    parts.push(text.slice(currentIndex, endIndex));
    currentIndex = endIndex;
  }

  return parts;
}

export function normalizePathForDisplay(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const project = getCurrentProject();

  if (!project?.worktree) {
    return normalizedPath;
  }

  const normalizedWorktree = project.worktree.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedWorktree) {
    return normalizedPath;
  }

  const pathForCompare =
    process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const worktreeForCompare =
    process.platform === "win32" ? normalizedWorktree.toLowerCase() : normalizedWorktree;

  if (pathForCompare === worktreeForCompare) {
    return ".";
  }

  const worktreePrefix = `${worktreeForCompare}/`;
  if (pathForCompare.startsWith(worktreePrefix)) {
    return normalizedPath.slice(normalizedWorktree.length + 1);
  }

  return normalizedPath;
}

export function formatSummary(text: string): string[] {
  return formatSummaryWithMode(text, config.bot.messageFormatMode);
}

export function escapePlainTextForTelegramMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_RESERVED_CHARS, "\\$1");
}

function formatMarkdownForTelegram(text: string): string {
  try {
    const preprocessed = normalizeMarkdownForTelegramRendering(text);
    return escapeMarkdownV2PipesOutsideCode(convertToTelegramMarkdownV2(preprocessed));
  } catch (error) {
    logger.warn("[Formatter] Failed to convert markdown summary, falling back to raw text", error);
    return text;
  }
}

function escapeMarkdownV2PipesOutsideCode(text: string): string {
  let result = "";
  let index = 0;
  let inInlineCode = false;
  let inCodeFence = false;

  while (index < text.length) {
    if (text.startsWith("```", index)) {
      result += "```";
      index += 3;
      inCodeFence = !inCodeFence;
      continue;
    }

    const char = text[index];

    if (!inCodeFence && char === "`") {
      inInlineCode = !inInlineCode;
      result += char;
      index += 1;
      continue;
    }

    if (!inCodeFence && !inInlineCode && char === "|" && text[index - 1] !== "\\") {
      result += "\\|";
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

export function formatSummaryWithMode(
  text: string,
  mode: MessageFormatMode,
  maxLength: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const normalizedMaxLength = Math.max(1, Math.floor(maxLength));
  const rawTextLimit =
    mode === "raw" ? Math.max(1, normalizedMaxLength - RAW_CODE_FENCE_OVERHEAD) : normalizedMaxLength;
  const parts = splitText(text, rawTextLimit);
  const formattedParts: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    if (mode === "markdown") {
      const converted = formatMarkdownForTelegram(trimmed);
      const convertedParts = splitText(converted, normalizedMaxLength, {
        avoidTrailingMarkdownEscape: true,
      });

      for (const convertedPart of convertedParts) {
        const normalizedPart = convertedPart.trim();
        if (normalizedPart) {
          formattedParts.push(normalizedPart);
        }
      }
      continue;
    }

    if (parts.length > 1) {
      formattedParts.push(`\`\`\`text\n${trimmed}\n\`\`\``);
    } else {
      formattedParts.push(trimmed);
    }
  }

  return formattedParts;
}

function getToolDetails(tool: string, input?: { [key: string]: unknown }): string {
  if (!input) {
    return "";
  }

  // First, check fields specific to known tools
  switch (tool) {
    case "read":
    case "edit":
    case "write":
    case "apply_patch":
      const filePath = input.path || input.filePath;
      if (typeof filePath === "string") return normalizePathForDisplay(filePath);
      break;
    case "bash":
      if (typeof input.command === "string") return input.command;
      break;
    case "grep":
    case "glob":
      if (typeof input.pattern === "string") return input.pattern;
      break;
  }

  // Generic search for MCP and other tools
  // Look for common fields: query, url, name, prompt
  const commonFields = ["query", "url", "name", "prompt", "text"];
  for (const field of commonFields) {
    if (typeof input[field] === "string") {
      return input[field];
    }
  }

  // If nothing matched but string fields exist, take the first one (except description)
  for (const [key, value] of Object.entries(input)) {
    if (key !== "description" && typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "";
}

function getToolIcon(tool: string): string {
  switch (tool) {
    case "read":
      return "📖";
    case "write":
      return "✍️";
    case "edit":
      return "✏️";
    case "apply_patch":
      return "🩹";
    case "bash":
      return "💻";
    case "glob":
      return "📁";
    case "grep":
      return "🔍";
    case "task":
      return "🤖";
    case "question":
      return "❓";
    case "todoread":
      return "📋";
    case "todowrite":
      return "📝";
    case "webfetch":
      return "🌐";
    case "web-search_tavily_search":
      return "🔎";
    case "web-search_tavily_extract":
      return "📄";
    case "skill":
      return "🎓";
    default:
      return "🛠️";
  }
}

function formatTodos(todos: Array<{ id: string; content: string; status: string }>): string {
  const MAX_TODOS = 20;

  const statusToMarker: Record<string, string> = {
    completed: "✅",
    in_progress: "🔄",
    pending: "🔲",
  };

  const formattedTodos: string[] = [];

  for (let i = 0; i < Math.min(todos.length, MAX_TODOS); i++) {
    const todo = todos[i];
    const marker = statusToMarker[todo.status] ?? "🔲";
    formattedTodos.push(`${marker} ${todo.content}`);
  }

  let result = formattedTodos.join("\n");

  if (todos.length > MAX_TODOS) {
    result += `\n${t("tool.todo.overflow", { count: todos.length - MAX_TODOS })}`;
  }

  return result;
}

function formatDiffLineInfo(filediff: { additions?: number; deletions?: number }): string {
  const parts = [];
  if (filediff.additions && filediff.additions > 0) parts.push(`+${filediff.additions}`);
  if (filediff.deletions && filediff.deletions > 0) parts.push(`-${filediff.deletions}`);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function countDiffChangesFromText(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { additions, deletions };
}

function extractFirstUpdatedFileFromTitle(title: string): string {
  for (const rawLine of title.split("\n")) {
    const line = rawLine.trim();
    if (line.length >= 3 && line[1] === " " && /[AMDURC]/.test(line[0])) {
      return line.slice(2).trim();
    }
  }
  return "";
}

export function formatToolInfo(toolInfo: ToolInfo): string | null {
  const { tool, input, title } = toolInfo;
  logger.debug(
    `[Formatter] formatToolInfo: tool=${tool}, hasMetadata=${!!toolInfo.metadata}, hasFilediff=${!!toolInfo.metadata?.filediff}`,
  );

  if (tool === "todowrite" && toolInfo.metadata?.todos) {
    const todos = toolInfo.metadata.todos as Array<{
      id: string;
      content: string;
      status: string;
      priority?: string;
    }>;
    const toolIcon = getToolIcon(tool);
    const todosList = formatTodos(todos);
    return `${toolIcon} ${tool} (${todos.length})\n\n${todosList}`;
  }

  let details = title || getToolDetails(tool, input);
  const toolIcon = getToolIcon(tool);

  let description = "";
  if (input && typeof input.description === "string") {
    description = `${input.description}\n`;
  }

  if (tool === "bash" && input && typeof input.command === "string") {
    details = truncateWithEllipsis(input.command, config.bot.bashToolDisplayMaxLength);
  }

  if (tool === "apply_patch") {
    const filediff =
      toolInfo.metadata && "filediff" in toolInfo.metadata
        ? (toolInfo.metadata.filediff as { file?: string })
        : undefined;
    if (filediff?.file) {
      details = normalizePathForDisplay(filediff.file);
    } else if (title) {
      const fileFromTitle = extractFirstUpdatedFileFromTitle(title);
      if (fileFromTitle) {
        details = normalizePathForDisplay(fileFromTitle);
      }
    }
  }

  const detailsStr = details ? ` ${details}` : "";
  let lineInfo = "";

  if (tool === "write" && input && "content" in input && typeof input.content === "string") {
    const lines = countLines(input.content);
    lineInfo = ` (+${lines})`;
  }

  if (
    (tool === "edit" || tool === "apply_patch") &&
    toolInfo.metadata &&
    "filediff" in toolInfo.metadata
  ) {
    const filediff = toolInfo.metadata.filediff as { additions?: number; deletions?: number };
    logger.debug("[Formatter] Diff metadata:", JSON.stringify(toolInfo.metadata, null, 2));
    lineInfo = formatDiffLineInfo(filediff);
  }

  if (tool === "apply_patch" && !lineInfo) {
    const diffText =
      toolInfo.metadata && typeof toolInfo.metadata.diff === "string"
        ? toolInfo.metadata.diff
        : input && typeof input.patchText === "string"
          ? input.patchText
          : "";

    if (diffText) {
      lineInfo = formatDiffLineInfo(countDiffChangesFromText(diffText));
    }
  }

  return `${toolIcon} ${description}${tool}${detailsStr}${lineInfo}`;
}

export function formatCompactToolInfo(toolInfo: ToolInfo, maxLength = 64, fallback = "-"): string {
  const formatted = formatToolInfo(toolInfo);
  const normalized = formatted?.replace(/\s*\n+\s*/g, " ").trim() ?? "";

  if (!normalized) {
    return fallback;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

// Source: https://github.com/github-linguist/linguist/blob/main/lib/linguist/languages.yml
// Generated from github-linguist/linguist languages.yml (ace_mode field)
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  "1": "text",
  "1in": "text",
  "1m": "text",
  "1x": "text",
  "2": "text",
  "2da": "text",
  "3": "text",
  "3in": "text",
  "3m": "text",
  "3p": "text",
  "3pm": "text",
  "3qt": "text",
  "3x": "text",
  "4": "text",
  "4dform": "json",
  "4dm": "text",
  "4dproject": "json",
  "4gl": "text",
  "4th": "forth",
  "5": "text",
  "6": "text",
  "6pl": "raku",
  "6pm": "raku",
  "7": "text",
  "8": "text",
  "8xp": "text",
  "8xp.txt": "text",
  "9": "text",
  _coffee: "coffee",
  _js: "javascript",
  _ls: "livescript",
  a51: "assembly_x86",
  abap: "abap",
  abbrev_defs: "lisp",
  abnf: "text",
  ackrc: "sh",
  action: "text",
  ada: "ada",
  adb: "ada",
  adml: "xml",
  admx: "xml",
  ado: "text",
  adoc: "asciidoc",
  adp: "tcl",
  ads: "ada",
  afm: "text",
  agc: "assembly_x86",
  agda: "text",
  ahk: "autohotkey",
  ahkl: "autohotkey",
  aidl: "text",
  aj: "text",
  ak: "text",
  al: "text",
  alg: "pascal",
  "all-contributorsrc": "json",
  als: "text",
  ampl: "text",
  angelscript: "text",
  anim: "yaml",
  ant: "xml",
  "antlers.html": "text",
  "antlers.php": "text",
  "antlers.xml": "text",
  apacheconf: "apache_conf",
  apex: "apex",
  apib: "markdown",
  apl: "text",
  app: "erlang",
  "app.src": "erlang",
  applescript: "applescript",
  arc: "text",
  arcconfig: "json",
  arpa: "text",
  arr: "python",
  as: "actionscript",
  asax: "text",
  asc: "c_cpp",
  asciidoc: "asciidoc",
  ascx: "text",
  asd: "lisp",
  asddls: "text",
  ash: "c_cpp",
  ashx: "text",
  asl: "asl",
  asm: "assembly_x86",
  asmx: "text",
  asn: "text",
  asn1: "text",
  asp: "text",
  aspx: "text",
  asset: "yaml",
  astro: "astro",
  asy: "c_cpp",
  atomignore: "gitignore",
  au3: "autohotkey",
  aug: "text",
  auk: "text",
  "auto-changelog": "json",
  aux: "tex",
  avdl: "text",
  avsc: "json",
  aw: "php",
  awk: "text",
  axaml: "xml",
  axd: "text",
  axi: "text",
  "axi.erb": "text",
  axml: "xml",
  axs: "text",
  "axs.erb": "text",
  b: "text",
  babelignore: "gitignore",
  babelrc: "javascript",
  bal: "text",
  baml: "io",
  bas: "text",
  bash: "sh",
  bash_aliases: "sh",
  bash_functions: "sh",
  bash_history: "sh",
  bash_logout: "sh",
  bash_profile: "sh",
  bashrc: "sh",
  bat: "batchfile",
  bats: "sh",
  bb: "text",
  bbappend: "text",
  bbclass: "text",
  bbx: "tex",
  bdf: "text",
  bdy: "plsql",
  be: "text",
  befunge: "text",
  bf: "csharp",
  bi: "text",
  bib: "bibtex",
  bibtex: "bibtex",
  bicep: "text",
  bicepparam: "text",
  bison: "text",
  blade: "php_laravel_blade",
  "blade.php": "php_laravel_blade",
  bmx: "text",
  bones: "javascript",
  boo: "text",
  boot: "clojure",
  bpl: "text",
  bqn: "text",
  brd: "xml",
  bro: "zeek",
  browserslistrc: "text",
  brs: "text",
  bru: "text",
  bs: "html",
  bsl: "text",
  bst: "text",
  bsv: "verilog",
  buckconfig: "ini",
  builder: "ruby",
  builds: "xml",
  bzl: "python",
  bzrignore: "gitignore",
  c: "c_cpp",
  "c++": "c_cpp",
  "c++-objdump": "assembly_x86",
  "c++objdump": "assembly_x86",
  "c-objdump": "assembly_x86",
  c3: "c_cpp",
  c8rc: "json",
  cabal: "haskell_cabal",
  caddyfile: "text",
  cairo: "text",
  cake: "csharp",
  capnp: "text",
  carbon: "golang",
  cats: "c_cpp",
  cbl: "cobol",
  cbx: "tex",
  cc: "c_cpp",
  ccp: "cobol",
  ccproj: "xml",
  ccxml: "xml",
  cdc: "text",
  cdf: "text",
  cds: "text",
  ceylon: "text",
  cfc: "coldfusion",
  cfg: "text",
  cfm: "coldfusion",
  cfml: "coldfusion",
  cgi: "perl",
  cginc: "text",
  ch: "text",
  chem: "text",
  chpl: "text",
  chs: "haskell",
  cil: "text",
  circom: "text",
  cirru: "cirru",
  cj: "swift",
  cjs: "javascript",
  cjsx: "coffee",
  ck: "java",
  cl: "lisp",
  cl2: "clojure",
  "clang-format": "yaml",
  "clang-tidy": "yaml",
  clangd: "yaml",
  clar: "lisp",
  classpath: "xml",
  click: "text",
  clixml: "xml",
  clj: "clojure",
  cljc: "clojure",
  cljs: "clojure",
  "cljs.hl": "clojure",
  cljscm: "clojure",
  cljx: "clojure",
  clp: "text",
  cls: "apex",
  clue: "text",
  clw: "text",
  cmake: "text",
  "cmake.in": "text",
  cmd: "batchfile",
  cmp: "text",
  cnc: "gcode",
  cnf: "ini",
  cob: "cobol",
  cobol: "cobol",
  cocci: "text",
  "code-snippets": "javascript",
  "code-workspace": "javascript",
  coffee: "coffee",
  "coffee.md": "text",
  coffeelintignore: "gitignore",
  com: "text",
  command: "sh",
  conll: "text",
  conllu: "text",
  container: "ini",
  containerfile: "dockerfile",
  cook: "text",
  coq: "text",
  coveragerc: "ini",
  cp: "c_cpp",
  cpp: "c_cpp",
  "cpp-objdump": "assembly_x86",
  cppm: "c_cpp",
  cppobjdump: "assembly_x86",
  cproject: "xml",
  cps: "pascal",
  cpy: "cobol",
  cql: "text",
  cr: "crystal",
  crc32: "text",
  creole: "text",
  cs: "csharp",
  "cs.pp": "csharp",
  csc: "c_cpp",
  cscfg: "xml",
  csd: "csound_document",
  csdef: "xml",
  csh: "sh",
  cshrc: "sh",
  cshtml: "razor",
  csl: "text",
  cson: "coffee",
  csproj: "xml",
  css: "css",
  csv: "csv",
  csx: "csharp",
  ct: "xml",
  ctl: "text",
  ctp: "php",
  cts: "typescript",
  cu: "c_cpp",
  cue: "text",
  cuh: "c_cpp",
  curlrc: "text",
  curry: "haskell",
  cvsignore: "gitignore",
  cw: "text",
  cwl: "yaml",
  cxx: "c_cpp",
  "cxx-objdump": "assembly_x86",
  cy: "javascript",
  cylc: "ini",
  cyp: "text",
  cypher: "text",
  d: "d",
  "d-objdump": "assembly_x86",
  d2: "text",
  dae: "xml",
  darcspatch: "text",
  dart: "dart",
  das: "text",
  dats: "ocaml",
  db2: "sql",
  dcl: "text",
  ddl: "plsql",
  decls: "text",
  depproj: "xml",
  desktop: "text",
  "desktop.in": "text",
  "devcontainer.json": "javascript",
  dfm: "pascal",
  dfy: "text",
  dhall: "haskell",
  di: "d",
  diff: "diff",
  dir_colors: "text",
  dircolors: "text",
  dita: "xml",
  ditamap: "xml",
  ditaval: "xml",
  djs: "text",
  "dll.config": "xml",
  dlm: "text",
  dm: "c_cpp",
  do: "text",
  dockerfile: "dockerfile",
  dockerignore: "gitignore",
  dof: "ini",
  doh: "text",
  dot: "dot",
  dotsettings: "xml",
  dpatch: "text",
  dpr: "pascal",
  druby: "ruby",
  dsc: "text",
  dsl: "asl",
  dsp: "text",
  dsr: "text",
  dtx: "tex",
  duby: "ruby",
  dwl: "text",
  dyalog: "text",
  dyl: "text",
  dylan: "text",
  dzn: "text",
  e: "text",
  "eam.fs": "text",
  easignore: "gitignore",
  eb: "python",
  ebnf: "text",
  ebuild: "sh",
  ec: "text",
  ecl: "text",
  eclass: "sh",
  eclxml: "text",
  ecr: "html_ruby",
  ect: "ejs",
  edc: "c_cpp",
  edge: "html",
  edgeql: "text",
  editorconfig: "ini",
  edn: "clojure",
  eh: "text",
  ejs: "ejs",
  "ejs.t": "ejs",
  el: "lisp",
  eleventyignore: "gitignore",
  eliom: "ocaml",
  eliomi: "ocaml",
  elm: "elm",
  elv: "text",
  em: "coffee",
  emacs: "lisp",
  "emacs.desktop": "lisp",
  emberscript: "coffee",
  eml: "text",
  env: "text",
  "env.ci": "text",
  "env.dev": "text",
  "env.development": "text",
  "env.development.local": "text",
  "env.example": "text",
  "env.local": "text",
  "env.prod": "text",
  "env.production": "text",
  "env.sample": "text",
  "env.staging": "text",
  "env.template": "text",
  "env.test": "text",
  "env.testing": "text",
  envrc: "sh",
  epj: "json",
  eps: "text",
  epsi: "text",
  eq: "csharp",
  erb: "html_ruby",
  "erb.deface": "html_ruby",
  erl: "erlang",
  es: "erlang",
  es6: "javascript",
  escript: "erlang",
  esdl: "text",
  "eslint-ignore": "gitignore",
  eslintignore: "gitignore",
  "eslintrc.json": "javascript",
  ex: "elixir",
  exrc: "text",
  exs: "elixir",
  eye: "ruby",
  f: "text",
  f03: "fortran",
  f08: "fortran",
  f77: "fortran",
  f90: "fortran",
  f95: "fortran",
  factor: "text",
  "factor-boot-rc": "text",
  "factor-rc": "text",
  fan: "text",
  fancypack: "text",
  fbs: "text",
  fcgi: "lua",
  fea: "text",
  feature: "gherkin",
  filters: "xml",
  fir: "text",
  fish: "text",
  flake8: "ini",
  flaskenv: "sh",
  flex: "text",
  flf: "text",
  flix: "flix",
  flux: "text",
  fnc: "plsql",
  fnl: "text",
  for: "text",
  forth: "forth",
  fp: "glsl",
  fpp: "fortran",
  fr: "forth",
  frag: "glsl",
  frg: "glsl",
  frm: "ini",
  frt: "forth",
  fs: "fsharp",
  fsh: "glsl",
  fshader: "glsl",
  fsi: "fsharp",
  fsproj: "xml",
  fst: "text",
  fsti: "text",
  fsx: "fsharp",
  fth: "forth",
  ftl: "text",
  ftlh: "ftl",
  fun: "text",
  fut: "text",
  fx: "text",
  fxh: "text",
  fxml: "xml",
  fy: "text",
  g: "gcode",
  g4: "text",
  gaml: "text",
  gap: "text",
  gawk: "text",
  gbl: "text",
  gbo: "text",
  gbp: "text",
  gbr: "text",
  gbs: "text",
  gclient: "python",
  gco: "gcode",
  gcode: "gcode",
  gd: "text",
  gdb: "text",
  gdbinit: "text",
  gdnlib: "text",
  gdns: "text",
  gdshader: "glsl",
  gdshaderinc: "glsl",
  ged: "text",
  gemrc: "yaml",
  gemspec: "ruby",
  geo: "glsl",
  geojson: "json",
  geom: "glsl",
  gf: "haskell",
  gi: "text",
  "git-blame-ignore-revs": "text",
  gitattributes: "gitignore",
  gitconfig: "ini",
  gitignore: "gitignore",
  gitmodules: "ini",
  gjs: "javascript",
  gko: "text",
  glade: "xml",
  gleam: "text",
  glf: "tcl",
  glsl: "glsl",
  glslf: "glsl",
  glslv: "glsl",
  gltf: "json",
  glyphs: "text",
  gmi: "text",
  gml: "c_cpp",
  gms: "text",
  gmx: "xml",
  gn: "python",
  gni: "python",
  gnu: "text",
  gnuplot: "text",
  gnus: "lisp",
  go: "golang",
  god: "ruby",
  gohtml: "text",
  golo: "text",
  gotmpl: "text",
  gp: "text",
  gpb: "text",
  gpt: "text",
  gpx: "xml",
  gql: "graphqlschema",
  grace: "text",
  gradle: "text",
  "gradle.kts": "text",
  graphql: "graphqlschema",
  graphqls: "graphqlschema",
  groovy: "groovy",
  grt: "groovy",
  grxml: "xml",
  gs: "glsl",
  gsc: "c_cpp",
  gsh: "c_cpp",
  gshader: "glsl",
  gsp: "jsp",
  gst: "text",
  gsx: "text",
  gtl: "text",
  gto: "text",
  gtp: "text",
  gtpl: "groovy",
  gts: "text",
  gv: "dot",
  gvimrc: "text",
  gvy: "groovy",
  gyp: "python",
  gypi: "python",
  h: "c_cpp",
  "h++": "c_cpp",
  "h.in": "c_cpp",
  ha: "text",
  hack: "php",
  haml: "haml",
  "haml.deface": "haml",
  handlebars: "handlebars",
  har: "json",
  hats: "ocaml",
  hb: "text",
  hbs: "handlebars",
  hc: "c_cpp",
  hcl: "terraform",
  heex: "html_elixir",
  hh: "c_cpp",
  hhi: "php",
  hic: "clojure",
  hip: "c_cpp",
  hlean: "text",
  hlsl: "text",
  hlsli: "text",
  hocon: "text",
  hoon: "text",
  hpp: "c_cpp",
  hqf: "text",
  hql: "sql",
  hrl: "erlang",
  hs: "haskell",
  "hs-boot": "haskell",
  hsc: "haskell",
  hta: "html",
  htaccess: "apache_conf",
  htm: "html",
  html: "html",
  "html.eex": "html_elixir",
  "html.hl": "html",
  "html.tmpl": "text",
  htmlhintrc: "json",
  http: "text",
  hurl: "text",
  hx: "haxe",
  hxml: "text",
  hxsl: "haxe",
  hxx: "c_cpp",
  hy: "text",
  hzp: "xml",
  i: "assembly_x86",
  i3: "text",
  i7x: "text",
  ical: "properties",
  ice: "json",
  iced: "coffee",
  icl: "text",
  icls: "xml",
  ics: "properties",
  idc: "c_cpp",
  idr: "text",
  ig: "text",
  ignore: "gitignore",
  ihlp: "text",
  ijm: "text",
  ijs: "text",
  ik: "text",
  il: "text",
  ily: "text",
  imba: "text",
  imgbotconfig: "json",
  iml: "xml",
  inc: "assembly_x86",
  ini: "ini",
  ink: "text",
  inl: "c_cpp",
  ino: "c_cpp",
  inputrc: "text",
  ins: "tex",
  intr: "text",
  io: "io",
  iol: "text",
  ipf: "text",
  ipp: "c_cpp",
  ipynb: "json",
  irbrc: "ruby",
  irclog: "text",
  isl: "text",
  ispc: "c_cpp",
  iss: "text",
  iuml: "text",
  ivy: "xml",
  ixx: "c_cpp",
  j: "java",
  j2: "django",
  jac: "text",
  jade: "jade",
  jai: "text",
  jake: "javascript",
  janet: "scheme",
  jav: "java",
  java: "java",
  javascript: "javascript",
  jbuilder: "ruby",
  jcl: "text",
  jelly: "xml",
  jflex: "text",
  jinja: "django",
  jinja2: "django",
  jison: "text",
  jisonlex: "text",
  jl: "julia",
  jq: "jsoniq",
  js: "javascript",
  "js.erb": "javascript",
  jsb: "javascript",
  jscad: "javascript",
  jscsrc: "javascript",
  jsfl: "javascript",
  jsh: "java",
  jshintrc: "javascript",
  jslib: "javascript",
  jslintrc: "javascript",
  jsm: "javascript",
  json: "json",
  "json-tmlanguage": "json",
  "json.example": "json",
  json5: "json5",
  jsonc: "javascript",
  jsonl: "json",
  jsonld: "javascript",
  jsonnet: "text",
  jsp: "jsp",
  jspre: "javascript",
  jsproj: "xml",
  jss: "javascript",
  jst: "ejs",
  jsx: "javascript",
  jte: "text",
  just: "text",
  justfile: "text",
  k: "text",
  kak: "text",
  kdl: "tcl",
  kicad_mod: "lisp",
  kicad_pcb: "lisp",
  kicad_sch: "text",
  kicad_sym: "text",
  kicad_wks: "lisp",
  kid: "xml",
  kit: "html",
  kk: "text",
  kml: "xml",
  kojo: "scala",
  kql: "text",
  krl: "text",
  ks: "text",
  ksh: "sh",
  kshrc: "sh",
  ksy: "yaml",
  kt: "kotlin",
  ktm: "kotlin",
  kts: "kotlin",
  kv: "text",
  l: "lisp",
  lagda: "text",
  langium: "text",
  lark: "text",
  las: "text",
  lasso: "text",
  lasso8: "text",
  lasso9: "text",
  latexmkrc: "perl",
  latte: "latte",
  launch: "xml",
  lbx: "tex",
  ld: "text",
  lds: "text",
  lean: "text",
  leex: "html_elixir",
  lektorproject: "ini",
  leo: "text",
  less: "less",
  lex: "text",
  lfe: "lisp",
  lgt: "logtalk",
  lhs: "text",
  libsonnet: "text",
  lid: "text",
  lidr: "text",
  ligo: "pascal",
  linq: "csharp",
  liq: "text",
  liquid: "liquid",
  lisp: "lisp",
  litcoffee: "text",
  livecodescript: "text",
  livemd: "markdown",
  lkml: "yaml",
  ll: "text",
  lmi: "python",
  login: "sh",
  logtalk: "logtalk",
  lol: "text",
  lookml: "yaml",
  lp: "prolog",
  lpr: "pascal",
  ls: "livescript",
  lsl: "lsl",
  lslp: "lsl",
  lsp: "lisp",
  ltx: "tex",
  lua: "lua",
  luacheckrc: "lua",
  luau: "lua",
  lvclass: "xml",
  lvlib: "xml",
  lvproj: "xml",
  ly: "text",
  m: "text",
  m2: "text",
  m3: "text",
  m3u: "text",
  m3u8: "text",
  m4: "text",
  ma: "text",
  mak: "makefile",
  make: "makefile",
  makefile: "makefile",
  mako: "text",
  man: "text",
  mao: "text",
  markdown: "markdown",
  markdownlintignore: "gitignore",
  marko: "text",
  mask: "mask",
  mat: "yaml",
  mata: "text",
  matah: "text",
  mathematica: "text",
  matlab: "matlab",
  mawk: "text",
  maxhelp: "json",
  maxpat: "json",
  maxproj: "json",
  mbox: "text",
  mbt: "text",
  mc: "text",
  mcfunction: "text",
  mch: "text",
  mcmeta: "json",
  mcr: "text",
  md: "markdown",
  md2: "text",
  md4: "text",
  md5: "text",
  mdoc: "text",
  mdown: "markdown",
  mdpolicy: "xml",
  mdwn: "markdown",
  mdx: "markdown",
  me: "text",
  mediawiki: "mediawiki",
  mermaid: "text",
  meta: "yaml",
  metal: "c_cpp",
  metta: "text",
  mg: "text",
  minid: "text",
  mint: "text",
  mir: "yaml",
  mirah: "ruby",
  mjml: "xml",
  mjs: "javascript",
  mk: "makefile",
  mkd: "markdown",
  mkdn: "markdown",
  mkdown: "markdown",
  mkfile: "makefile",
  mkii: "tex",
  mkiv: "tex",
  mkvi: "tex",
  ml: "ocaml",
  ml4: "ocaml",
  mli: "ocaml",
  mligo: "ocaml",
  mlir: "text",
  mll: "ocaml",
  mly: "ocaml",
  mm: "objectivec",
  mmd: "text",
  mmk: "text",
  mms: "text",
  mo: "text",
  mod: "text",
  mojo: "python",
  monkey: "text",
  monkey2: "text",
  moo: "prolog",
  moon: "text",
  mount: "ini",
  move: "text",
  mpl: "xml",
  mps: "xml",
  mq4: "c_cpp",
  mq5: "c_cpp",
  mqh: "c_cpp",
  mrc: "text",
  ms: "text",
  msd: "xml",
  msg: "text",
  mspec: "ruby",
  mss: "text",
  mt: "text",
  mtl: "text",
  mtml: "html",
  mts: "typescript",
  mu: "text",
  mud: "text",
  muf: "forth",
  mumps: "text",
  muse: "text",
  mustache: "smarty",
  mxml: "xml",
  mxt: "json",
  mysql: "sql",
  myt: "text",
  mzn: "text",
  n: "text",
  nanorc: "text",
  nas: "assembly_x86",
  nasl: "text",
  nasm: "assembly_x86",
  natvis: "xml",
  nawk: "text",
  nb: "text",
  nbp: "text",
  nc: "text",
  ncl: "text",
  ndproj: "xml",
  ne: "text",
  nearley: "text",
  ned: "text",
  neon: "text",
  network: "ini",
  nf: "groovy",
  nginx: "nginx",
  nginxconf: "nginx",
  ni: "text",
  nim: "nim",
  "nim.cfg": "nim",
  nimble: "nim",
  nimrod: "nim",
  nims: "nim",
  ninja: "text",
  nit: "text",
  nix: "nix",
  njk: "nunjucks",
  njs: "javascript",
  nl: "text",
  nlogo: "lisp",
  no: "text",
  nodemonignore: "gitignore",
  nomad: "terraform",
  npmignore: "gitignore",
  npmrc: "text",
  nproj: "xml",
  nqp: "raku",
  nr: "rust",
  nse: "lua",
  nsh: "nsis",
  nsi: "nsis",
  nss: "c_cpp",
  nu: "scheme",
  numpy: "text",
  numpyw: "text",
  numsc: "text",
  nuspec: "xml",
  nut: "c_cpp",
  nvimrc: "text",
  ny: "lisp",
  nycrc: "json",
  ob2: "text",
  obj: "text",
  objdump: "assembly_x86",
  odd: "xml",
  odin: "text",
  ol: "text",
  omgrofl: "text",
  ooc: "text",
  opa: "text",
  opal: "text",
  opencl: "c_cpp",
  opy: "python",
  orc: "csound_orchestra",
  org: "text",
  os: "text",
  osm: "xml",
  outjob: "ini",
  overpassql: "text",
  owl: "xml",
  ox: "text",
  oxh: "text",
  "oxlintrc.json": "javascript",
  oxo: "text",
  oxygene: "text",
  oz: "text",
  p: "text",
  p4: "text",
  p6: "raku",
  p6l: "raku",
  p6m: "raku",
  p8: "lua",
  pac: "javascript",
  pact: "text",
  pan: "text",
  parrot: "text",
  pas: "pascal",
  pascal: "pascal",
  pasm: "text",
  pat: "json",
  patch: "diff",
  pb: "text",
  pbi: "text",
  pbt: "text",
  pbtxt: "text",
  pc: "c_cpp",
  "pc.in": "properties",
  pcbdoc: "ini",
  pck: "plsql",
  pcss: "text",
  pd: "text",
  pd_lua: "lua",
  pddl: "text",
  pde: "text",
  peggy: "javascript",
  pegjs: "javascript",
  pep: "text",
  per: "text",
  perl: "perl",
  pfa: "text",
  pgsql: "pgsql",
  ph: "perl",
  php: "php",
  php3: "php",
  php4: "php",
  php5: "php",
  php_cs: "php",
  "php_cs.dist": "php",
  phps: "php",
  phpt: "php",
  phtml: "php",
  pic: "text",
  pig: "pig",
  pike: "text",
  pir: "text",
  pkb: "plsql",
  pkgproj: "xml",
  pkl: "text",
  pks: "plsql",
  pl: "perl",
  pl6: "raku",
  plantuml: "text",
  plb: "plsql",
  plist: "text",
  plot: "text",
  pls: "plsql",
  plsql: "plsql",
  plt: "text",
  pluginspec: "ruby",
  plx: "perl",
  pm: "perl",
  pm6: "raku",
  pml: "text",
  pmod: "text",
  po: "text",
  pod: "perl",
  pod6: "perl",
  podsl: "lisp",
  podspec: "ruby",
  pogo: "text",
  polar: "text",
  pony: "text",
  por: "text",
  postcss: "text",
  pot: "text",
  pov: "text",
  pp: "pascal",
  pprx: "text",
  praat: "praat",
  prawn: "ruby",
  prc: "plsql",
  prefab: "yaml",
  prefs: "ini",
  prettierignore: "gitignore",
  prg: "text",
  pri: "text",
  prisma: "prisma",
  prjpcb: "ini",
  pro: "text",
  profile: "sh",
  proj: "xml",
  project: "xml",
  prolog: "prolog",
  properties: "ini",
  props: "xml",
  proto: "protobuf",
  prw: "text",
  pryrc: "ruby",
  ps: "text",
  ps1: "powershell",
  ps1xml: "xml",
  psc: "text",
  psc1: "xml",
  psd1: "powershell",
  psgi: "perl",
  psm1: "powershell",
  pt: "xml",
  pub: "text",
  pubxml: "xml",
  pug: "jade",
  puml: "text",
  purs: "haskell",
  pwn: "text",
  pxd: "text",
  pxi: "text",
  py: "python",
  py3: "python",
  pyde: "python",
  pyi: "python",
  pylintrc: "ini",
  pyp: "python",
  pyt: "python",
  pytb: "text",
  pyw: "python",
  pyx: "text",
  q: "sql",
  qasm: "text",
  qbs: "qml",
  qc: "text",
  qhelp: "xml",
  ql: "text",
  qll: "text",
  qmd: "markdown",
  qml: "qml",
  qnt: "text",
  qs: "text",
  r: "r",
  r2: "text",
  r3: "text",
  rabl: "ruby",
  rake: "ruby",
  raku: "raku",
  rakumod: "raku",
  raml: "yaml",
  rascript: "text",
  raw: "text",
  razor: "razor",
  rb: "ruby",
  rbbas: "text",
  rbfrm: "text",
  rbi: "ruby",
  rbmnu: "text",
  rbres: "text",
  rbs: "ruby",
  rbtbar: "text",
  rbuild: "ruby",
  rbuistate: "text",
  rbw: "ruby",
  rbx: "ruby",
  rbxs: "lua",
  rchit: "glsl",
  rd: "r",
  rdf: "xml",
  rdoc: "rdoc",
  re: "c_cpp",
  reb: "text",
  rebol: "text",
  red: "red",
  reds: "red",
  reek: "yaml",
  reg: "ini",
  regex: "text",
  regexp: "text",
  rego: "text",
  rei: "rust",
  religo: "rust",
  res: "rust",
  resi: "rust",
  resource: "robot",
  rest: "rst",
  "rest.txt": "rst",
  resx: "xml",
  rex: "text",
  rexx: "text",
  rg: "clojure",
  rhtml: "html_ruby",
  ring: "text",
  riot: "html",
  rkt: "lisp",
  rktd: "lisp",
  rktl: "lisp",
  rl: "text",
  rmd: "markdown",
  rmiss: "glsl",
  rnh: "text",
  rno: "text",
  rnw: "tex",
  robot: "robot",
  roc: "text",
  rockspec: "lua",
  roff: "text",
  ron: "rust",
  ronn: "markdown",
  rpgle: "text",
  rprofile: "r",
  rpy: "python",
  rq: "sparql",
  rs: "rust",
  "rs.in": "rust",
  rsc: "text",
  rsh: "text",
  rspec: "sh",
  rss: "xml",
  rst: "rst",
  "rst.txt": "rst",
  rsx: "r",
  rtf: "text",
  ru: "ruby",
  ruby: "ruby",
  rviz: "yaml",
  s: "assembly_x86",
  sage: "python",
  sagews: "python",
  sail: "text",
  sarif: "json",
  sas: "text",
  sass: "sass",
  sats: "ocaml",
  sbatch: "sh",
  sbt: "scala",
  sc: "scala",
  scad: "scad",
  scala: "scala",
  "scalafix.conf": "text",
  "scalafmt.conf": "text",
  scaml: "text",
  scd: "markdown",
  sce: "text",
  scenic: "text",
  sch: "xml",
  schdoc: "ini",
  sci: "text",
  scm: "scheme",
  sco: "csound_score",
  scpt: "applescript",
  scrbl: "lisp",
  scss: "scss",
  scxml: "xml",
  sdc: "tcl",
  sed: "text",
  self: "text",
  service: "ini",
  sexp: "lisp",
  sfd: "yaml",
  sfproj: "xml",
  sfv: "ini",
  sh: "sh",
  "sh-session": "sh",
  "sh.in": "sh",
  sha1: "text",
  sha2: "text",
  sha224: "text",
  sha256: "text",
  sha256sum: "text",
  sha3: "text",
  sha384: "text",
  sha512: "text",
  shader: "glsl",
  shellcheckrc: "ini",
  shen: "text",
  shproj: "xml",
  sieve: "text",
  sig: "text",
  simplecov: "ruby",
  sj: "text",
  sjs: "javascript",
  sl: "text",
  slang: "text",
  sld: "scheme",
  slim: "slim",
  slint: "text",
  sln: "text",
  slnlaunch: "json",
  slnx: "xml",
  sls: "yaml",
  slurm: "sh",
  sma: "text",
  smali: "text",
  smithy: "smithy",
  smk: "python",
  sml: "text",
  smt: "text",
  smt2: "text",
  snakefile: "python",
  snap: "javascript",
  snip: "text",
  snippet: "text",
  snippets: "text",
  socket: "ini",
  sol: "text",
  soy: "soy_template",
  sp: "text",
  spacemacs: "lisp",
  sparql: "sparql",
  spc: "plsql",
  spec: "python",
  spin: "text",
  sps: "scheme",
  sqf: "text",
  sql: "sql",
  sqlrpgle: "text",
  sra: "text",
  srdf: "xml",
  srt: "lisp",
  sru: "text",
  srv: "text",
  srw: "text",
  ss: "scheme",
  ssjs: "javascript",
  sss: "text",
  st: "text",
  stan: "text",
  star: "text",
  sthlp: "text",
  stl: "text",
  ston: "text",
  story: "gherkin",
  storyboard: "xml",
  sttheme: "xml",
  sty: "tex",
  styl: "stylus",
  stylelintignore: "gitignore",
  "sublime-build": "javascript",
  "sublime-color-scheme": "javascript",
  "sublime-commands": "javascript",
  "sublime-completions": "javascript",
  "sublime-keymap": "javascript",
  "sublime-macro": "javascript",
  "sublime-menu": "javascript",
  "sublime-mousemap": "javascript",
  "sublime-project": "javascript",
  "sublime-settings": "javascript",
  "sublime-snippet": "xml",
  "sublime-syntax": "yaml",
  "sublime-theme": "javascript",
  "sublime-workspace": "javascript",
  sublime_metrics: "javascript",
  sublime_session: "javascript",
  surql: "text",
  sv: "verilog",
  svelte: "html",
  svg: "svg",
  svh: "verilog",
  svx: "text",
  sw: "rust",
  swcrc: "javascript",
  swg: "c_cpp",
  swift: "swift",
  swig: "c_cpp",
  syntax: "yaml",
  t: "perl",
  tab: "sql",
  tac: "python",
  tact: "json",
  tag: "jsp",
  talon: "text",
  target: "ini",
  targets: "xml",
  tcc: "c_cpp",
  tcl: "tcl",
  "tcl.in": "tcl",
  tcsh: "sh",
  te: "text",
  tea: "text",
  templ: "text",
  "tern-config": "json",
  "tern-project": "json",
  tesc: "glsl",
  tese: "glsl",
  tex: "tex",
  texi: "text",
  texinfo: "text",
  textgrid: "text",
  textile: "textile",
  textproto: "text",
  tf: "terraform",
  tfstate: "json",
  "tfstate.backup": "json",
  tftpl: "ruby",
  tfvars: "terraform",
  thor: "ruby",
  thrift: "text",
  thy: "text",
  timer: "ini",
  tl: "lua",
  tla: "text",
  tlv: "verilog",
  tm: "tcl",
  tm_properties: "properties",
  tmac: "text",
  tmcommand: "xml",
  tmdl: "text",
  tml: "xml",
  tmlanguage: "xml",
  tmpl: "text",
  tmpreferences: "xml",
  tmsnippet: "xml",
  tmtheme: "xml",
  tmux: "sh",
  "tmux.conf": "sh",
  toc: "tex",
  tofu: "terraform",
  toit: "text",
  toml: "toml",
  "toml.example": "toml",
  tool: "sh",
  topojson: "json",
  tpb: "plsql",
  tpl: "text",
  tpp: "c_cpp",
  tps: "plsql",
  tres: "text",
  trg: "plsql",
  trigger: "apex",
  ts: "typescript",
  tscn: "text",
  "tsconfig.json": "javascript",
  tsp: "text",
  tst: "text",
  tsv: "tsv",
  tsx: "typescript",
  ttl: "turtle",
  tu: "text",
  twig: "twig",
  txi: "text",
  txl: "text",
  txt: "text",
  txtpb: "text",
  txx: "c_cpp",
  typ: "text",
  uc: "java",
  udf: "sql",
  udo: "csound_orchestra",
  ui: "xml",
  unity: "yaml",
  uno: "csharp",
  upc: "c_cpp",
  uplc: "text",
  ur: "text",
  urdf: "xml",
  url: "ini",
  urs: "text",
  ux: "xml",
  v: "text",
  vala: "vala",
  vapi: "vala",
  vark: "text",
  vb: "text",
  vba: "text",
  vbhtml: "text",
  vbproj: "xml",
  vbs: "vbscript",
  vcf: "tsv",
  vcl: "text",
  vcxproj: "xml",
  vdf: "text",
  veo: "verilog",
  vercelignore: "gitignore",
  vert: "glsl",
  vh: "verilog",
  vhd: "vhdl",
  vhdl: "vhdl",
  vhf: "vhdl",
  vhi: "vhdl",
  vho: "vhdl",
  vhost: "apache_conf",
  vhs: "vhdl",
  vht: "vhdl",
  vhw: "vhdl",
  vim: "text",
  vimrc: "text",
  viper: "lisp",
  viw: "sql",
  vmb: "text",
  vmf: "text",
  volt: "d",
  vrx: "glsl",
  vs: "glsl",
  vscodeignore: "gitignore",
  vsh: "glsl",
  vshader: "glsl",
  vsixmanifest: "xml",
  vssettings: "xml",
  vstemplate: "xml",
  vtl: "velocity",
  vto: "text",
  vtt: "text",
  vue: "vue",
  vw: "plsql",
  vxml: "xml",
  vy: "text",
  w: "text",
  wast: "lisp",
  wat: "lisp",
  watchmanconfig: "json",
  watchr: "ruby",
  wdl: "text",
  webapp: "json",
  webidl: "text",
  webmanifest: "json",
  weechatlog: "text",
  wgetrc: "text",
  wgsl: "text",
  whiley: "text",
  wiki: "mediawiki",
  wikitext: "mediawiki",
  wisp: "clojure",
  wit: "text",
  wixproj: "xml",
  wl: "text",
  wlk: "wollok",
  wls: "text",
  wlt: "text",
  wlua: "lua",
  workbook: "markdown",
  workflow: "terraform",
  wren: "text",
  ws: "text",
  wsdl: "xml",
  wsf: "xml",
  wsgi: "python",
  wxi: "xml",
  wxl: "xml",
  wxs: "xml",
  x: "text",
  x10: "text",
  x3d: "xml",
  x68: "assembly_x86",
  xacro: "xml",
  xaml: "xml",
  xbm: "c_cpp",
  xc: "c_cpp",
  xcompose: "text",
  xdc: "tcl",
  xht: "html",
  xhtml: "html",
  xi: "text",
  xib: "xml",
  xinitrc: "sh",
  xlf: "xml",
  xliff: "xml",
  xm: "text",
  xmi: "xml",
  xml: "xml",
  "xml.dist": "xml",
  xmp: "xml",
  xojo_code: "text",
  xojo_menu: "text",
  xojo_report: "text",
  xojo_script: "text",
  xojo_toolbar: "text",
  xojo_window: "text",
  xpl: "xml",
  xpm: "c_cpp",
  xproc: "xml",
  xproj: "xml",
  xpy: "python",
  xq: "xquery",
  xql: "xquery",
  xqm: "xquery",
  xquery: "xquery",
  xqy: "xquery",
  xrl: "erlang",
  xs: "c_cpp",
  xsd: "xml",
  xsession: "sh",
  xsh: "text",
  xsjs: "javascript",
  xsjslib: "javascript",
  xsl: "xml",
  xslt: "xml",
  "xsp-config": "xml",
  "xsp.metadata": "xml",
  xspec: "xml",
  xtend: "text",
  xul: "xml",
  xzap: "text",
  y: "text",
  yacc: "text",
  yaml: "yaml",
  "yaml-tmlanguage": "yaml",
  "yaml.sed": "yaml",
  yang: "text",
  yap: "prolog",
  yar: "text",
  yara: "text",
  yardopts: "sh",
  yasnippet: "text",
  yml: "yaml",
  "yml.mysql": "yaml",
  yrl: "erlang",
  yul: "text",
  yy: "json",
  yyp: "json",
  z3: "text",
  zap: "text",
  zcml: "xml",
  zed: "text",
  zeek: "zeek",
  zep: "php",
  zig: "zig",
  "zig.zon": "zig",
  zil: "text",
  zimpl: "text",
  zlogin: "sh",
  zlogout: "sh",
  zmodel: "text",
  zmpl: "text",
  zone: "text",
  zpl: "text",
  zprofile: "sh",
  zs: "text",
  zsh: "sh",
  "zsh-theme": "sh",
  zshenv: "sh",
  zshrc: "sh",
};

export function detectCodeLanguage(
  filePath?: string,
): string {
  if (!filePath) {
    return "text";
  }

  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return EXTENSION_LANGUAGE_MAP[ext] || "text";
}

export interface CodeFileData {
  buffer: Buffer;
  filename: string;
  caption: string;
}

function formatDiff(diff: string): string {
  const lines = diff.split("\n");
  const formattedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("Index:")) {
      continue;
    }
    if (line.startsWith("===") && line.includes("=")) {
      continue;
    }
    if (line.startsWith("\\ No newline")) {
      continue;
    }

    if (line.startsWith(" ")) {
      formattedLines.push(" " + line.slice(1));
    } else if (line.startsWith("+")) {
      formattedLines.push("+ " + line.slice(1));
    } else if (line.startsWith("-")) {
      formattedLines.push("- " + line.slice(1));
    } else {
      formattedLines.push(line);
    }
  }

  return formattedLines.join("\n");
}

export function prepareCodeFile(
  content: string,
  filePath: string,
  operation: "write" | "edit",
): CodeFileData | null {
  const displayPath = normalizePathForDisplay(filePath);
  let processedContent = content;

  if (operation === "edit") {
    processedContent = formatDiff(content);
  }

  const sizeKb = Buffer.byteLength(processedContent, "utf8") / 1024;

  if (sizeKb > config.files.maxFileSizeKb) {
    logger.debug(
      `[Formatter] File too large: ${displayPath} (${sizeKb.toFixed(2)} KB > ${config.files.maxFileSizeKb} KB)`,
    );
    return null;
  }

  const header =
    operation === "write"
      ? t("tool.file_header.write", { path: displayPath })
      : t("tool.file_header.edit", { path: displayPath });
  const fullContent = header + processedContent;

  const buffer = Buffer.from(fullContent, "utf8");
  const basename = path.basename(filePath);
  const filename = `${operation}_${basename}.txt`;

  return { buffer, filename, caption: "" };
}
