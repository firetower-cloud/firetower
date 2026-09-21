/**
 * The native storage modules, for a node test runner.
 *
 * `conversation.ts` reads which server is current, which reaches the registry,
 * which reaches the Keychain and MMKV. None of it matters to the fold being
 * tested — it decides a cache key — but all of it has to resolve.
 */
export const createMMKV = () => ({
  getString: (_: string) => undefined as string | undefined,
  set: (_: string, __: string) => {},
  delete: (_: string) => {},
});
export const getItemAsync = async () => null;
export const setItemAsync = async () => {};
export const deleteItemAsync = async () => {};
