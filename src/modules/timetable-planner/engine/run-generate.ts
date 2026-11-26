/**
 * Run a timetable generation in a worker thread so the API keeps answering while it works.
 *
 * Resolves with `{ entries, unplaced, stats, warnings }`. Rejects if the engine throws, the worker
 * dies, or the run outlives `timeoutMs` (the worker is then terminated, so it can never linger).
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GenerateOptions, GenerateOutput, Problem } from './engine';

// Under tsx or Vitest this module is a .ts file and so is the worker; after `npm run build` both are .js.
const RUNNING_TS = __filename.endsWith('.ts');
const WORKER_PATH = path.join(__dirname, RUNNING_TS ? 'generate.worker.ts' : 'generate.worker.js');

/**
 * Flags for the worker. `npm run dev` runs under tsx, whose loader flags are in process.execArgv and are passed on.
 * Vitest has no such flags (it compiles .ts itself), so the worker is given tsx to read its .ts file.
 * Compiled code needs neither.
 */
const WORKER_EXEC_ARGV =
  RUNNING_TS && !process.execArgv.some((arg) => arg.includes('tsx')) ? [...process.execArgv, '--import', 'tsx'] : process.execArgv;

export class GenerationBusyError extends Error {}

/** The run outlived its time limit and the worker was stopped. Callers can tell this apart from an engine failure. */
export class GenerationTimeoutError extends Error {}

const MAX_CONCURRENT = 2;
let running = 0;

type WorkerMessage = { ok: true; result: GenerateOutput } | { ok: false; message: string };

/** The part of a worker the generator uses. Tests pass a fake through `createWorker`; production uses a real Worker. */
export type GenerationWorker = Pick<Worker, 'once' | 'terminate'>;
export type GenerateInWorkerOptions = {
  timeoutMs?: number;
  createWorker?: (workerData: { problem: Problem; options: Omit<GenerateOptions, 'shouldStop' | 'onProgress'> }) => GenerationWorker;
};

/** How many generations are running right now (for tests and diagnostics). */
export const activeGenerations = () => running;

const startWorker: NonNullable<GenerateInWorkerOptions['createWorker']> = (workerData) =>
  new Worker(WORKER_PATH, { workerData, execArgv: WORKER_EXEC_ARGV });

export function generateInWorker(
  problem: Problem,
  options: Omit<GenerateOptions, 'shouldStop' | 'onProgress'>,
  { timeoutMs = 45_000, createWorker = startWorker }: GenerateInWorkerOptions = {},
): Promise<GenerateOutput> {
  if (running >= MAX_CONCURRENT) {
    return Promise.reject(new GenerationBusyError('Another timetable is being generated. Try again in a few seconds.'));
  }
  running += 1;
  return new Promise((resolve, reject) => {
    let worker: GenerationWorker;
    try {
      worker = createWorker({ problem, options });
    } catch (error) {
      running -= 1; // the worker never started, so nothing else will release this slot
      throw error;
    }
    let settled = false;
    const finish = <T>(settle: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      running -= 1;
      clearTimeout(timer);
      void worker.terminate();
      settle(value);
    };
    const timer = setTimeout(
      () => finish(reject, new GenerationTimeoutError('Generation took too long and was stopped. Try a shorter search time.')),
      timeoutMs,
    );
    worker.once('message', (message: WorkerMessage) =>
      message.ok ? finish(resolve, message.result) : finish(reject, new Error(message.message)),
    );
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => finish(reject, new Error(`The generation worker stopped unexpectedly (code ${code}).`)));
  });
}
