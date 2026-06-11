export type CorpusId = "overlap";

export interface CorpusCase {
  id: string;
  language: "typescript" | "python" | "go" | "rust";
  repo: string;
  defaultRef: string;
  question: string;
  expectedRedSkillsSupport: "supported";
}

export const OVERLAP_CORPUS: CorpusCase[] = [
  {
    id: "excalidraw-render",
    language: "typescript",
    repo: "https://github.com/excalidraw/excalidraw.git",
    defaultRef: "HEAD",
    question: "How does Excalidraw render and update canvas elements?",
    expectedRedSkillsSupport: "supported",
  },
  {
    id: "django-orm-query",
    language: "python",
    repo: "https://github.com/django/django.git",
    defaultRef: "HEAD",
    question: "How does Django's ORM build and execute a query from a QuerySet?",
    expectedRedSkillsSupport: "supported",
  },
  {
    id: "tokio-runtime-tasks",
    language: "rust",
    repo: "https://github.com/tokio-rs/tokio.git",
    defaultRef: "HEAD",
    question: "How does tokio schedule and run async tasks on its runtime?",
    expectedRedSkillsSupport: "supported",
  },
  {
    id: "gin-middleware-chain",
    language: "go",
    repo: "https://github.com/gin-gonic/gin.git",
    defaultRef: "HEAD",
    question: "How does gin route requests through its middleware chain?",
    expectedRedSkillsSupport: "supported",
  },
];

export function loadCorpus(id: CorpusId): CorpusCase[] {
  if (id !== "overlap") throw new Error(`unknown corpus: ${id}`);
  return OVERLAP_CORPUS;
}
