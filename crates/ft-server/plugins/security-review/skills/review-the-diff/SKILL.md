---
name: review-the-diff
description: Use when a branch is finished and wants reading before it is opened — looks for correctness bugs and security holes in the pending change only, not the whole repository.
---

# Reviewing a pending change

Read the diff, not the repository. An audit of four hundred files is a report
nobody acts on; a comment on the twelve lines somebody just wrote is one they
can.

## What to look at first

1. **Anything that crosses a boundary.** A parser, an authentication check, a
   path that is built from input, a query that is concatenated.
2. **What the change made reachable** that was not reachable before. A new
   route, a new public method, a loosened guard.
3. **Error paths.** The happy path is the one that was tested.

## What to say

One finding per comment, with the input that triggers it and what comes out.
A finding without a failure case is a preference, and preferences belong in a
style guide rather than in a review.

If nothing is wrong, say so in one line. A review that invents work to look
thorough is how people learn to ignore reviews.
