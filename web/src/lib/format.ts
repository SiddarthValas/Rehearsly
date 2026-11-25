import type { Mode, Persona, TopicStatus } from "./api";

export const MODE_LABEL: Record<Mode, string> = {
  resume: "Resume interview",
  technical: "Role interview",
  behavioral: "Behavioral interview",
  custom: "Custom interview",
  hr: "HR interview",
  bank: "Past questions",
};

export const PERSONA_LABEL: Record<Persona, string> = {
  coach: "Supportive coach",
  professional: "Neutral professional",
  bar_raiser: "Bar-raiser",
};

export const STATUS_LABEL: Record<TopicStatus, string> = {
  pending: "Not yet",
  covered: "Covered",
  thin: "Thin",
  skipped: "Skipped",
};

export const KIND_LABEL: Record<string, string> = {
  experience: "Experience",
  project: "Project",
  fundamentals: "Fundamentals",
  scenario: "Scenario",
  behavioral: "Behavioral",
  gap: "Skill gap",
  education: "Education",
  achievement: "Achievement",
  leadership: "Leadership",
  company: "Company fit",
};

export const DIFFICULTY_LABEL = ["", "Warm-up", "Standard", "Probing", "Advanced", "Expert"];

export function when(seconds: number): string {
  const date = new Date(seconds * 1000);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 6) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: diff > 86400 * 300 ? "numeric" : undefined });
}

export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function scoreTone(score: number | null | undefined, outOf = 10): "good" | "mid" | "low" | "none" {
  if (score == null) return "none";
  const ratio = score / outOf;
  if (ratio >= 0.75) return "good";
  if (ratio >= 0.5) return "mid";
  return "low";
}

export const AREA_LABEL: Record<string, string> = {
  projects: "Projects",
  experience: "Internships & work",
  skills: "Skills & tools",
  education: "Education",
  achievements: "Achievements",
  leadership: "Leadership",
  fundamentals: "Fundamentals",
  scenarios: "Scenarios",
  tools: "Tools & stack",
  design: "Problem solving",
  teamwork: "Teamwork",
  conflict: "Conflict",
  failure: "Failure & learning",
  pressure: "Pressure",
  ownership: "Ownership",
};

/** Saved question-bank searches, kept in this browser. */
export const banks = {
  key: "rehearsly.banks.v1",
  all(): import("./api").Bank[] {
    try {
      return JSON.parse(localStorage.getItem(this.key) || "[]");
    } catch {
      return [];
    }
  },
  save(bank: import("./api").Bank) {
    try {
      const rest = this.all().filter((b) => !(b.company.toLowerCase() === bank.company.toLowerCase() && b.role.toLowerCase() === bank.role.toLowerCase()));
      localStorage.setItem(this.key, JSON.stringify([bank, ...rest].slice(0, 12)));
    } catch {
      /* storage full or unavailable */
    }
  },
  find(company: string, role: string) {
    return this.all().find((b) => b.company.toLowerCase() === company.toLowerCase() && b.role.toLowerCase() === role.toLowerCase());
  },
};

export function prettyDate(value: string): string {
  if (!value) return "Date unknown";
  const [year, month] = value.split("-");
  if (!month) return year;
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
