/**
 * Worker-thread entry: runs one timetable generation off the API thread.
 *
 * The engine is pure and synchronous, so a generation (seconds long) would otherwise stop the API
 * from answering anyone else. Only plain JSON crosses the thread boundary, so the Schedule
 * instance is not returned; the route rebuilds it from the entries when it needs one.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { generate } from './engine';

try {
  const { problem, options } = workerData;
  const result = generate(problem, options);
  parentPort?.postMessage({
    ok: true,
    result: { entries: result.entries, unplaced: result.unplaced, stats: result.stats, warnings: result.warnings },
  });
} catch (error) {
  parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
