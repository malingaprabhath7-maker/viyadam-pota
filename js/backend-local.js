// Guest backend: everything is kept in this browser's localStorage.
import { load, save, emptyData, normalise } from "./store.js";

export function createLocalBackend() {
  let data = load();
  let listener = () => {};
  const commit = () => {
    const ok = save(data);
    listener(data, { ok });
    return ok;
  };
  return {
    kind: "local",
    start(onChange) { listener = onChange; listener(data, { ok: true }); },
    stop() { listener = () => {}; },
    get: () => data,
    putEntries(list) {
      const byId = new Map(data.entries.map((e) => [e.id, e]));
      for (const e of list) byId.set(e.id, e);
      data.entries = [...byId.values()];
      return commit();
    },
    deleteEntry(id) { data.entries = data.entries.filter((e) => e.id !== id); return commit(); },
    putMeta(patch) { Object.assign(data, patch); return commit(); },
    replaceAll(next) { data = normalise({ ...next, settings: next.settings || data.settings }); return commit(); },
    clear() { data = { ...emptyData(), settings: data.settings }; return commit(); },
  };
}
