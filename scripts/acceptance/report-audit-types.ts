import type { ReportCheck } from './report.ts';

export interface AuditInput {
  reportPath: string;
  artifactDir: string;
  resultPath: string;
  synthetic: boolean;
}
export interface AuditState {
  name: string;
  screenshot: string;
  viewport: { width: number; height: number };
  theme: string;
  firstEntryTop: number | null;
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    targets: string[];
  }>;
  incomplete: string[];
}
export interface AuditResult {
  checks: ReportCheck[];
  states: AuditState[];
  errors: string[];
  tasks: Array<{ task: string; actions: number }>;
  engine: string;
  complete: boolean;
}
