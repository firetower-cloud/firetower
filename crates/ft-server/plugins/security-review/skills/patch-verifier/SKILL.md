---
name: patch-verifier
description: Use when a fix has been proposed for a bug or a vulnerability and somebody has to establish that the original trigger no longer reproduces.
---

# Verifying a patch

A fix is a claim. This is how the claim gets checked.

1. **Reproduce the original first**, against the code *before* the fix. A
   patch that is verified against a trigger that never worked proves nothing,
   and this is the step people skip.
2. Apply the fix. Run the same trigger. It should fail to fire.
3. **Try the neighbourhood.** The same bug one character to the left — a
   different encoding, a trailing slash, a null byte, the second parameter
   rather than the first.
4. Write the trigger down as a test, in the dialect the repository already
   uses, so the next person does not have to re-derive it.

Report what you ran, not what you concluded. A verdict without the commands
under it cannot be checked by anybody else.
