/**
 * The mark beside a file's name, the way an editor draws it.
 *
 * A glance at a tree should say what is in it before a name is read: code,
 * config, a picture, a lock file nobody edits. The shape is the kind of file;
 * the tone is the language, on the same palette the syntax layer uses so a
 * TypeScript file is the same blue in the tree as its types are in the tab.
 * Nothing here is loud — ember stays for what needs you.
 */
import type { LucideIcon } from "lucide-react";
import {
  Braces,
  Container,
  Database,
  File,
  FileCode2,
  FileJson2,
  FileTerminal,
  FileText,
  FileType2,
  FlaskConical,
  Folder,
  FolderCode,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Globe,
  Image,
  Lock,
  Package,
  Paintbrush,
  Settings2,
} from "lucide-react";

type Glyph = { icon: LucideIcon; tone: string };

const BY_NAME: Record<string, Glyph> = {
  "package.json": { icon: Package, tone: "text-syn-fn" },
  "cargo.toml": { icon: Package, tone: "text-syn-fn" },
  "pyproject.toml": { icon: Package, tone: "text-syn-fn" },
  "go.mod": { icon: Package, tone: "text-syn-fn" },
  dockerfile: { icon: Container, tone: "text-syn-type" },
  "docker-compose.yml": { icon: Container, tone: "text-syn-type" },
  "docker-compose.yaml": { icon: Container, tone: "text-syn-type" },
  "compose.yml": { icon: Container, tone: "text-syn-type" },
  "compose.yaml": { icon: Container, tone: "text-syn-type" },
  ".gitignore": { icon: GitBranch, tone: "text-mute" },
  ".gitattributes": { icon: GitBranch, tone: "text-mute" },
  ".gitmodules": { icon: GitBranch, tone: "text-mute" },
  "readme.md": { icon: FileText, tone: "text-syn-type" },
  license: { icon: FileText, tone: "text-mute" },
  "license.md": { icon: FileText, tone: "text-mute" },
  makefile: { icon: FileTerminal, tone: "text-syn-string" },
  justfile: { icon: FileTerminal, tone: "text-syn-string" },
};

const BY_EXT: Record<string, Glyph> = {
  ts: { icon: FileCode2, tone: "text-syn-type" },
  tsx: { icon: FileCode2, tone: "text-syn-type" },
  mts: { icon: FileCode2, tone: "text-syn-type" },
  js: { icon: FileCode2, tone: "text-syn-number" },
  jsx: { icon: FileCode2, tone: "text-syn-number" },
  mjs: { icon: FileCode2, tone: "text-syn-number" },
  cjs: { icon: FileCode2, tone: "text-syn-number" },
  rs: { icon: FileCode2, tone: "text-syn-fn" },
  py: { icon: FileCode2, tone: "text-syn-number" },
  go: { icon: FileCode2, tone: "text-syn-type" },
  rb: { icon: FileCode2, tone: "text-brick" },
  java: { icon: FileCode2, tone: "text-syn-fn" },
  kt: { icon: FileCode2, tone: "text-syn-keyword" },
  swift: { icon: FileCode2, tone: "text-syn-fn" },
  c: { icon: FileCode2, tone: "text-syn-type" },
  h: { icon: FileCode2, tone: "text-syn-attr" },
  cpp: { icon: FileCode2, tone: "text-syn-type" },
  cs: { icon: FileCode2, tone: "text-syn-keyword" },
  php: { icon: FileCode2, tone: "text-syn-keyword" },
  lua: { icon: FileCode2, tone: "text-syn-type" },
  zig: { icon: FileCode2, tone: "text-syn-number" },
  sh: { icon: FileTerminal, tone: "text-syn-string" },
  bash: { icon: FileTerminal, tone: "text-syn-string" },
  zsh: { icon: FileTerminal, tone: "text-syn-string" },
  fish: { icon: FileTerminal, tone: "text-syn-string" },
  json: { icon: FileJson2, tone: "text-syn-number" },
  jsonc: { icon: FileJson2, tone: "text-syn-number" },
  json5: { icon: FileJson2, tone: "text-syn-number" },
  yaml: { icon: Settings2, tone: "text-syn-attr" },
  yml: { icon: Settings2, tone: "text-syn-attr" },
  toml: { icon: Settings2, tone: "text-syn-attr" },
  ini: { icon: Settings2, tone: "text-syn-attr" },
  env: { icon: Settings2, tone: "text-syn-attr" },
  cfg: { icon: Settings2, tone: "text-syn-attr" },
  conf: { icon: Settings2, tone: "text-syn-attr" },
  md: { icon: FileText, tone: "text-dim" },
  mdx: { icon: FileText, tone: "text-dim" },
  txt: { icon: FileText, tone: "text-mute" },
  rst: { icon: FileText, tone: "text-dim" },
  css: { icon: Paintbrush, tone: "text-syn-keyword" },
  scss: { icon: Paintbrush, tone: "text-syn-keyword" },
  less: { icon: Paintbrush, tone: "text-syn-keyword" },
  html: { icon: Globe, tone: "text-syn-fn" },
  htm: { icon: Globe, tone: "text-syn-fn" },
  vue: { icon: Globe, tone: "text-syn-string" },
  svelte: { icon: Globe, tone: "text-syn-fn" },
  astro: { icon: Globe, tone: "text-syn-keyword" },
  svg: { icon: Image, tone: "text-syn-keyword" },
  png: { icon: Image, tone: "text-syn-keyword" },
  jpg: { icon: Image, tone: "text-syn-keyword" },
  jpeg: { icon: Image, tone: "text-syn-keyword" },
  gif: { icon: Image, tone: "text-syn-keyword" },
  webp: { icon: Image, tone: "text-syn-keyword" },
  ico: { icon: Image, tone: "text-syn-keyword" },
  icns: { icon: Image, tone: "text-syn-keyword" },
  sql: { icon: Database, tone: "text-syn-number" },
  db: { icon: Database, tone: "text-mute" },
  sqlite: { icon: Database, tone: "text-mute" },
  lock: { icon: Lock, tone: "text-mute" },
  woff: { icon: FileType2, tone: "text-mute" },
  woff2: { icon: FileType2, tone: "text-mute" },
  ttf: { icon: FileType2, tone: "text-mute" },
  otf: { icon: FileType2, tone: "text-mute" },
  graphql: { icon: Braces, tone: "text-brick" },
  gql: { icon: Braces, tone: "text-brick" },
  proto: { icon: Braces, tone: "text-syn-type" },
  wasm: { icon: Braces, tone: "text-syn-keyword" },
};

const DIRS: Record<string, Glyph> = {
  ".git": { icon: FolderGit2, tone: "text-mute" },
  node_modules: { icon: Package, tone: "text-mute" },
  target: { icon: Package, tone: "text-mute" },
  dist: { icon: Package, tone: "text-mute" },
  build: { icon: Package, tone: "text-mute" },
  src: { icon: FolderCode, tone: "text-syn-type" },
  lib: { icon: FolderCode, tone: "text-syn-type" },
  crates: { icon: FolderCode, tone: "text-syn-fn" },
  test: { icon: FlaskConical, tone: "text-syn-string" },
  tests: { icon: FlaskConical, tone: "text-syn-string" },
  __tests__: { icon: FlaskConical, tone: "text-syn-string" },
};

export function glyphFor(name: string, directory: boolean, open = false): Glyph {
  const lower = name.toLowerCase();
  if (directory) return DIRS[lower] ?? { icon: open ? FolderOpen : Folder, tone: "text-dim" };
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (/\.(test|spec)\.[a-z]+$/.test(lower) || /_test\.go$/.test(lower)) return { icon: FlaskConical, tone: "text-syn-string" };
  if (/^\.env(\.|$)/.test(lower)) return BY_EXT.env;
  if (/\.lock$/.test(lower) || /-lock\.(json|yaml)$/.test(lower)) return BY_EXT.lock;
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? { icon: File, tone: "text-mute" };
}

/** `tone` overrides the language's colour — a changed file is green whatever it is written in. */
export function FileGlyph({ name, directory = false, open = false, tone }: { name: string; directory?: boolean; open?: boolean; tone?: string }) {
  const glyph = glyphFor(name, directory, open);
  const Icon = glyph.icon;
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${tone ?? glyph.tone}`} strokeWidth={1.75} />;
}
