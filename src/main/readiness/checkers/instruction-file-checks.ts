import * as path from 'path';
import type { ReadinessCheck } from '../../../shared/types';
import { fileExists, readFileSafe } from '../utils';

export interface InstructionFileOpts {
  fileName: string;      // e.g. 'CLAUDE.md' or 'AGENTS.md'
  idPrefix: string;      // e.g. 'claude-md' or 'agents-md'
  displayName: string;   // e.g. 'CLAUDE.md' or 'AGENTS.md'
}

export function checkFileExists(projectPath: string, opts: InstructionFileOpts): ReadinessCheck {
  const exists = fileExists(path.join(projectPath, opts.fileName));
  return {
    id: `${opts.idPrefix}-exists`,
    name: `${opts.displayName} exists`,
    status: exists ? 'pass' : 'fail',
    description: exists
      ? `${opts.displayName} found`
      : `No ${opts.displayName} file found. This is the primary way to give AI agents context about your project.`,
    score: exists ? 100 : 0,
    maxScore: 100,
    fixPrompt: exists
      ? undefined
      : `Create a ${opts.displayName} file for this project. Analyze the codebase and generate a comprehensive ${opts.displayName} that includes: project description, build/run commands, test commands, architecture overview, key file locations, and coding conventions. Make it thorough but concise (50-300 lines).`,
    effort: 'low',
    impact: 90,
    rationale: `${opts.displayName} is the first thing the AI reads about your project. Without it, the AI has to infer architecture, commands, and conventions from scratch every session — slower, costlier, and more error-prone. A focused instructions file pays for itself within a few prompts.`,
  };
}

export function checkBuildCommands(content: string | null, opts: InstructionFileOpts): ReadinessCheck {
  if (!content) {
    return {
      id: `${opts.idPrefix}-build`,
      name: `${opts.displayName} has build commands`,
      status: 'fail',
      description: `${opts.displayName} missing — cannot check for build commands.`,
      score: 0,
      maxScore: 100,
    };
  }
  const hasBuild = /\b(build|compile|run|start|dev|npm run|yarn |pnpm |make|cargo |go build|gradle|mvn)\b/i.test(content);
  return {
    id: `${opts.idPrefix}-build`,
    name: `${opts.displayName} has build commands`,
    status: hasBuild ? 'pass' : 'fail',
    description: hasBuild ? 'Build/run commands documented' : `No build or run commands found in ${opts.displayName}.`,
    score: hasBuild ? 100 : 0,
    maxScore: 100,
    fixPrompt: hasBuild ? undefined : `Update the ${opts.displayName} file to include build and run commands. Add a "Build & Run" section with the exact commands needed to build and run this project.`,
    effort: 'low',
    impact: 60,
    rationale: 'Without explicit build/run commands, the AI guesses based on the package manager or framework — and often guesses wrong on monorepos or projects with custom scripts. Listing the canonical commands removes a whole class of "command not found" failures.',
  };
}

export function checkTestCommands(content: string | null, opts: InstructionFileOpts): ReadinessCheck {
  if (!content) {
    return {
      id: `${opts.idPrefix}-test`,
      name: `${opts.displayName} has test commands`,
      status: 'fail',
      description: `${opts.displayName} missing — cannot check for test commands.`,
      score: 0,
      maxScore: 100,
    };
  }
  const hasTest = /\b(test|spec|jest|vitest|pytest|mocha|rspec|cargo test|go test|npm test|yarn test)\b/i.test(content);
  return {
    id: `${opts.idPrefix}-test`,
    name: `${opts.displayName} has test commands`,
    status: hasTest ? 'pass' : 'fail',
    description: hasTest ? 'Test commands documented' : `No test commands found in ${opts.displayName}.`,
    score: hasTest ? 100 : 0,
    maxScore: 100,
    fixPrompt: hasTest ? undefined : `Update the ${opts.displayName} file to include test commands. Add a "Testing" section with the exact commands needed to run tests in this project.`,
    effort: 'low',
    impact: 60,
    rationale: 'Documented test commands let the AI verify its own changes before handing back. Without them, it either skips testing or invents a command, which breaks the loop and wastes a turn.',
  };
}

export function checkArchitecture(content: string | null, opts: InstructionFileOpts): ReadinessCheck {
  if (!content) {
    return {
      id: `${opts.idPrefix}-architecture`,
      name: `${opts.displayName} has architecture section`,
      status: 'fail',
      description: `${opts.displayName} missing — cannot check for architecture documentation.`,
      score: 0,
      maxScore: 100,
    };
  }
  const hasArch = /\b(architecture|overview|structure|description|design|data flow|components)\b/i.test(content);
  return {
    id: `${opts.idPrefix}-architecture`,
    name: `${opts.displayName} has architecture section`,
    status: hasArch ? 'pass' : 'fail',
    description: hasArch ? 'Architecture/overview documented' : `No architecture or project overview found in ${opts.displayName}.`,
    score: hasArch ? 100 : 0,
    maxScore: 100,
    fixPrompt: hasArch ? undefined : `Update the ${opts.displayName} file to include an architecture overview. Add an "Architecture" section describing the project structure, key components, data flow, and important design decisions.`,
    effort: 'medium',
    impact: 70,
    rationale: 'A short architecture overview lets the AI skip the "where does this live?" exploration phase and jump straight into the right module. Without it, it spelunks files trying to reverse-engineer your structure.',
  };
}

export function checkFileSize(content: string | null, opts: InstructionFileOpts): ReadinessCheck {
  if (!content) {
    return {
      id: `${opts.idPrefix}-size`,
      name: `${opts.displayName} appropriate size`,
      status: 'fail',
      description: `${opts.displayName} missing.`,
      score: 0,
      maxScore: 100,
    };
  }
  const lines = content.split('\n').length;
  let status: ReadinessCheck['status'];
  let score: number;
  let description: string;

  if (lines >= 50 && lines <= 300) {
    status = 'pass';
    score = 100;
    description = `${opts.displayName} is ${lines} lines — good size.`;
  } else if ((lines >= 10 && lines < 50) || (lines > 300 && lines <= 500)) {
    status = 'warning';
    score = 50;
    description = lines < 50
      ? `${opts.displayName} is only ${lines} lines — consider adding more detail.`
      : `${opts.displayName} is ${lines} lines — consider trimming for focus.`;
  } else {
    status = 'fail';
    score = 0;
    description = lines < 10
      ? `${opts.displayName} is only ${lines} lines — too short to be useful.`
      : `${opts.displayName} is ${lines} lines — too long, may waste context window.`;
  }

  let fixPrompt: string | undefined;
  if (status !== 'pass') {
    fixPrompt = lines < 50
      ? `The ${opts.displayName} file is too short. Expand it to include comprehensive project documentation (aim for 50-300 lines) covering: build commands, test commands, architecture, key files, and conventions.`
      : `The ${opts.displayName} file is too long (over 300 lines). Trim it to focus on the most important information for AI agents. Move detailed documentation to separate files and keep ${opts.displayName} between 50-300 lines.`;
  }

  return {
    id: `${opts.idPrefix}-size`,
    name: `${opts.displayName} appropriate size`,
    status,
    description,
    score,
    maxScore: 100,
    fixPrompt,
    effort: 'low',
    impact: 30,
    rationale: `${opts.displayName} is loaded into every prompt, so its bytes compete with your actual code for context. Too short and the AI lacks grounding; too long and it crowds out the files the AI actually needs to read.`,
  };
}

export function checkNotBloated(projectPath: string, opts: InstructionFileOpts): ReadinessCheck {
  const content = readFileSafe(path.join(projectPath, opts.fileName));
  if (!content) {
    return {
      id: `${opts.idPrefix}-bloat`,
      name: `${opts.displayName} not bloated`,
      status: 'pass',
      description: `No ${opts.displayName} to check for bloat (checked in instructions).`,
      score: 100,
      maxScore: 100,
    };
  }
  const lines = content.split('\n').length;
  const bloatRationale = `Every byte of ${opts.displayName} is paid for on every prompt. Past ~300 lines you're spending real context budget on text the AI may not need that turn. Trim to essentials and offload depth to linked files.`;
  if (lines <= 300) {
    return { id: `${opts.idPrefix}-bloat`, name: `${opts.displayName} not bloated`, status: 'pass', description: `${opts.displayName} is ${lines} lines — within limits.`, score: 100, maxScore: 100, effort: 'low', impact: 30, rationale: bloatRationale };
  }
  if (lines <= 500) {
    return {
      id: `${opts.idPrefix}-bloat`, name: `${opts.displayName} not bloated`, status: 'warning', description: `${opts.displayName} is ${lines} lines — getting large.`, score: 50, maxScore: 100,
      fixPrompt: `The ${opts.displayName} file is getting large. Review it and move detailed documentation to separate files. Keep ${opts.displayName} focused on essential context that AI agents need for every interaction.`,
      effort: 'medium', impact: 30, rationale: bloatRationale,
    };
  }
  return {
    id: `${opts.idPrefix}-bloat`, name: `${opts.displayName} not bloated`, status: 'fail', description: `${opts.displayName} is ${lines} lines — too large, wastes context window.`, score: 0, maxScore: 100,
    fixPrompt: `The ${opts.displayName} file is too large and wastes AI context window space. Aggressively trim it: move detailed docs to separate files, remove redundant information, and keep only the most critical context. Target under 300 lines.`,
    effort: 'medium', impact: 60, rationale: bloatRationale,
  };
}

export function runAllInstructionChecks(projectPath: string, opts: InstructionFileOpts): ReadinessCheck[] {
  const content = readFileSafe(path.join(projectPath, opts.fileName));
  return [
    checkFileExists(projectPath, opts),
    checkBuildCommands(content, opts),
    checkTestCommands(content, opts),
    checkArchitecture(content, opts),
    checkFileSize(content, opts),
  ];
}
