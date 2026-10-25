// Runs async functions one after another per key; different keys run in parallel.
// The returned promise settles with fn's own result or error; a failing fn does
// not stop the functions queued after it.
export function createSerializer() {
  const tails = new Map();
  return (key, fn) => {
    const run = (tails.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
