// DB-free: generateInWorker is driven with a fake worker, so no thread is started and nothing connects to a database.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GenerationBusyError,
  GenerationTimeoutError,
  activeGenerations,
  generateInWorker,
  type GenerationWorker,
} from '../src/modules/timetable-planner/engine/run-generate';
import type { Problem } from '../src/modules/timetable-planner/engine/engine';

const problem = {} as Problem;
const options = { seed: 1, budgetMs: 100 };

class FakeWorker extends EventEmitter {
  terminate = vi.fn(() => Promise.resolve(0));
}
const asWorker = (worker: FakeWorker) => worker as unknown as GenerationWorker;

afterEach(() => vi.useRealTimers());

describe('generateInWorker', () => {
  it('restores the running counter when the worker cannot be constructed', async () => {
    const before = activeGenerations();
    const createWorker = () => {
      throw new Error('cannot start worker');
    };
    // Three failures in a row: before the fix the counter leaked and the third call answered "busy".
    for (let i = 0; i < 3; i += 1) {
      await expect(generateInWorker(problem, options, { createWorker })).rejects.toThrow('cannot start worker');
    }
    expect(activeGenerations()).toBe(before);
  });

  it('rejects with GenerationBusyError when the concurrency cap is reached, and recovers afterwards', async () => {
    const workers: FakeWorker[] = [];
    const createWorker = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return asWorker(worker);
    };
    const first = generateInWorker(problem, options, { createWorker });
    const second = generateInWorker(problem, options, { createWorker });
    await expect(generateInWorker(problem, options, { createWorker })).rejects.toBeInstanceOf(GenerationBusyError);
    expect(workers).toHaveLength(2);

    const output = { entries: [], unplaced: [], stats: {}, warnings: [] };
    workers.forEach((worker) => worker.emit('message', { ok: true, result: output }));
    await expect(first).resolves.toBe(output);
    await expect(second).resolves.toBe(output);
    expect(activeGenerations()).toBe(0);
    workers.forEach((worker) => expect(worker.terminate).toHaveBeenCalledTimes(1));
  });

  it('rejects with GenerationTimeoutError and terminates the worker when the run outlives the timeout', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const pending = generateInWorker(problem, options, { timeoutMs: 1000, createWorker: () => asWorker(worker) });
    const assertion = expect(pending).rejects.toBeInstanceOf(GenerationTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(activeGenerations()).toBe(0);
  });

  it('rejects with the engine message when the worker reports a failure', async () => {
    const worker = new FakeWorker();
    const pending = generateInWorker(problem, options, { createWorker: () => asWorker(worker) });
    worker.emit('message', { ok: false, message: 'engine exploded' });
    await expect(pending).rejects.toThrow('engine exploded');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(activeGenerations()).toBe(0);
  });
});
