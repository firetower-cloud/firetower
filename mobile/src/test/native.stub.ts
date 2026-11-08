/**
 * The native modules, for a node test runner.
 *
 * `conversation.ts` reads which server is current, which reaches the registry,
 * which reaches the Keychain and MMKV. None of it matters to the fold being
 * tested — it decides a cache key — but all of it has to resolve.
 *
 * `react-native-safe-area-context` is here for the same reason and not the
 * same one. `edges.ts` holds the rule that a safe-area inset is a *minimum*,
 * and that rule is a pure function worth pinning — but the hook beside it
 * imports the real package, whose source is untranspiled and fails the import
 * with `Unexpected token 'typeof'`. Splitting the file to dodge that is how
 * `theme.ts`/`scheme.ts` went, and it is the wrong trade here: the whole point
 * of `edges.ts` is that there is **one** place allowed to read the insets.
 * So the package resolves instead, and the tests exercise the pure half.
 */
export const createMMKV = () => ({
  getString: (_: string) => undefined as string | undefined,
  set: (_: string, __: string) => {},
  delete: (_: string) => {},
});
export const getItemAsync = async () => null;
export const setItemAsync = async () => {};
export const deleteItemAsync = async () => {};

/**
 * Zero on every edge. The tests call `screenEdges` with their own insets —
 * a plain phone and the Duo's measured `right: 84` — so this only has to
 * exist. A test that depended on this returning something would be testing
 * the stub.
 */
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
