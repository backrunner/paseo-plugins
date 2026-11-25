import { mkdir, readFile, open, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { State, freshState, type State as Data } from '../shared/model';
import { SubmissionRejected } from './rejection';

export class Store {
  state = freshState();
  private tail: Promise<unknown> = Promise.resolve();
  private release: (() => Promise<void>) | null = null;
  fault: string | null = null;
  constructor(readonly directory: string) {}
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(this.directory)).isDirectory() ||
      (await lstat(this.directory)).isSymbolicLink()
    )
      throw new Error('Invalid state directory');
    await chmod(this.directory, 0o700);
    this.release = await lockfile.lock(this.directory, {
      realpath: true,
      retries: 0,
      stale: 30000,
      update: 10000,
      onCompromised: () => {
        this.fault = 'Storage lock lost. Automatic delivery stopped.';
      },
    });
    try {
      const path = join(this.directory, 'state.json');
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8_000_000)
          throw new Error('Invalid state file');
        this.state = State.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.change((state) => {
        for (const job of state.jobs)
          if (job.status === 'dispatching') {
            job.status = 'unknown';
            job.wait = 'outcome-unknown';
          }
        for (const launch of state.launches)
          if (launch.status === 'starting') {
            launch.status = 'unknown';
            launch.problem = 'unconfirmed';
            launch.revision++;
          }
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  change<T>(operation: (state: Data) => T): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.fault || !this.release) throw new Error(this.fault ?? 'Storage closed');
      const next = structuredClone(this.state);
      const value = operation(next);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return value;
      next.revision++;
      State.parse(next);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 8_000_000)
        throw new SubmissionRejected('Queue storage limit reached');
      const path = join(this.directory, 'state.json');
      const temporary = join(this.directory, `state.${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(serialized);
          await file.sync();
        } finally {
          await file.close();
        }
        if (this.fault) throw new Error(this.fault);
        await rename(temporary, path);
        // Persist the rename as well as the file contents on POSIX filesystems.
        if (process.platform !== 'win32') {
          const directory = await open(this.directory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        this.state = next;
      } catch (error) {
        this.fault = 'Unable to persist queue. Delivery stopped.';
        throw error;
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close() {
    await this.tail;
    const release = this.release;
    this.release = null;
    await release?.().catch(() => {});
  }
}
