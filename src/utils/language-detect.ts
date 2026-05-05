/**
 * Maps file extensions to language identifiers for Tree-sitter grammar selection
 * and general language classification.
 */

export interface LanguageInfo {
  id: string;
  name: string;
  extensions: string[];
}

const LANGUAGE_MAP: Record<string, LanguageInfo> = {
  ".ts": { id: "typescript", name: "TypeScript", extensions: [".ts"] },
  ".tsx": { id: "tsx", name: "TypeScript JSX", extensions: [".tsx"] },
  ".js": { id: "javascript", name: "JavaScript", extensions: [".js"] },
  ".jsx": { id: "javascript", name: "JavaScript JSX", extensions: [".jsx"] },
  ".mjs": { id: "javascript", name: "JavaScript Module", extensions: [".mjs"] },
  ".cjs": { id: "javascript", name: "JavaScript CommonJS", extensions: [".cjs"] },
  ".py": { id: "python", name: "Python", extensions: [".py"] },
};

// File extensions we consider "source code" for analysis
const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// Files/directories to always skip regardless of .gitignore
const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "env",
  ".env",
  ".tox",
  "vendor",
]);

export function detectLanguage(filePath: string): LanguageInfo | null {
  const ext = getExtension(filePath);
  return LANGUAGE_MAP[ext] ?? null;
}

export function isSourceFile(filePath: string): boolean {
  const ext = getExtension(filePath);
  return SOURCE_EXTENSIONS.has(ext);
}

export function shouldIgnoreDirectory(dirName: string): boolean {
  return ALWAYS_IGNORE.has(dirName);
}

export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot).toLowerCase();
}

export function getSupportedExtensions(): string[] {
  return Array.from(SOURCE_EXTENSIONS);
}
