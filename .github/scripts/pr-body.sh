#!/usr/bin/env sh
# What a pull request body actually says, once GitHub has rendered it.
#
# Called by the `contribution` workflow with the branch's changed files; the
# body and title arrive in `$BODY` and `$TITLE`. Prints its verdict, writes the
# same thing to the job summary, and exits 1 if the pull request fails.
#
# It lives in a file rather than inside the workflow because the part of this
# that reads a body has now been wrong three times, and every one of the three
# was found by running it rather than by reading it: an allowlisted hostname
# written in prose counted as a screenshot; the host allowlist matched anywhere
# in the body rather than the image's own source, so `alt="<allowlisted>"` on a
# fork-hosted `<img>` passed; and an HTML comment that was never closed hid the
# whole description from the check while GitHub hid it from the reader too. A
# thing that keeps being wrong needs a test, and a test needs something it can
# call. `.github/scripts/pr-body-test.sh` is that test.
#
# The parsing is one perl pass, not a pipeline of greps, for a reason found the
# hard way: GNU grep and ugrep disagree about enough of this that the same body
# reached different verdicts on a laptop and on `ubuntu-latest`. A check whose
# answer depends on which grep is installed is not a check.
#
# What the perl does is flatten the body the way GitHub's renderer does, and
# then ask two questions of what is left:
#
#   * Fenced code is dropped. An image inside a fence renders as the characters
#     `![s](…)`, not as a picture, and a heading inside one is not a heading. An
#     unterminated fence runs to the end, as CommonMark says.
#   * Inline code spans are dropped next, for the same reason — and because it
#     is what lets somebody write `<!--` in a sentence without the next step
#     eating the rest of their description.
#   * HTML comments are two different things and have to be treated as two.
#     One that opens at the start of a line is a *block*, and a block that is
#     never closed swallows the rest of the document — that is settled in the
#     line loop, because the renderer decides blocks before it looks at
#     anything inline, and a code span that appears to wrap such a comment does
#     not actually wrap it. One that opens mid-line is *inline*, and an inline
#     one that is never closed is literal text the reader can see, so it is
#     left alone. `<!-->` and `<!--->` are complete and empty, and everything
#     after them renders.
#
# Evidence is then taken from image *sources* only — the destination of a
# markdown image, the `src` of an `<img>`, `<video>` or `<source>`, and a bare
# GitHub attachment URL alone on its line, which is what dragging a video in
# produces and what the README already uses. A URL mentioned in prose is not a
# screenshot. Each source is matched against the allowlist anchored at its own
# start, so a host that merely contains an allowed one — a suffix, a prefix, a
# userinfo `@`, a query string, a path segment — is not it. `..` is refused
# outright: `github.com/user-attachments/assets/../../someone/repo/raw/main/a.png`
# is served by github.com and comes from the fork.
#
# One thing it does not do: a reference-style image, `![a][ref]` with the URL
# defined further down, is not read as a source. That fails rather than passes,
# so it is a false failure and not a hole — and the fix is the one the message
# already asks for, which is to drag the file in.
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: pr-body.sh <changed-files> <numstat>" >&2
    exit 2
fi

files_list=$1
numstat=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

perl > "$work/facts" <<'PERL'
my $body  = $ENV{BODY}  // '';
my $title = $ENV{TITLE} // '';

# --- flatten it the way the renderer does -----------------------------------
my ($fence_char, $fence_len, $in_comment, @keep) = ('', 0, 0);
for my $line (split /^/, $body) {
    if ($fence_len) {
        if ($line =~ /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?\z/) {
            my $c = substr($1, 0, 1);
            $fence_len = 0 if $c eq $fence_char && length($1) >= $fence_len;
        }
        next;
    }
    if ($in_comment) { $in_comment = 0 if $line =~ /-->/; next; }
    if ($line =~ /^ {0,3}(`{3,}|~{3,})/) {
        $fence_char = substr($1, 0, 1);
        $fence_len  = length($1);
        next;
    }
    # A comment that opens at the start of a line is a block, and a block that
    # never closes runs to the end of the document. It has to be settled here,
    # line by line, rather than left to a regex on the whole body: the renderer
    # decides blocks before it looks at anything inline, so a code span that
    # appears to wrap one of these does not actually wrap it.
    if ($line =~ /^ {0,3}<!--/ && $line !~ /^ {0,3}<!--->/ && $line !~ /^ {0,3}<!-->/) {
        $in_comment = 1 unless $line =~ /-->/;
        next;
    }
    push @keep, $line;
}
my $t = join '', @keep;

$t =~ s/(`+)(?s:.)*?\1//g;          # inline code spans
$t =~ s/<!--->|<!-->//g;            # GitHub's two empty comments
# Closed only. A `<!--` that opens in the middle of a line and is never closed
# is literal text on the page — the reader sees `<!--` — so eating the rest of
# the description on account of it is a failure of an honest pull request. The
# block phase above has already dealt with the ones that really do run on.
$t =~ s/<!--(?s:.)*?-->//g;

# --- the sections the template asks for -------------------------------------
# Up to three spaces and a space after the hashes, because that is what GFM
# calls a heading. Four spaces is an indented code block and `##Thing` is a
# paragraph that happens to start with two hashes.
for my $want ('What changes', 'Why', 'How it was checked', 'What I did not do') {
    print "missing=$want\n" unless $t =~ /^ {0,3}\#{1,6}[ \t]+\Q$want\E/mi;
}

# --- what it shows ----------------------------------------------------------
my @found;
push @found, $1 while $t =~ /!\[[^\]]*\][ \t]*\(\s*<?([^>\s)]+)/g;
# `\b` alone matches the `src` inside `data-src`, and the lazy `[^>]*?` takes
# the first one it can — so a decoy attribute placed before the real `src` was
# what got read. The lookbehind is what makes it the attribute and not a
# substring of one.
push @found, $2 while $t =~ /<(?:img|video|source)\b[^>]*?(?<![-\w:.])src\s*=\s*(["']?)([^"'>\s]+)\1/gi;
push @found, $1 while $t =~ m{^[ \t]*(https?://github\.com/user-attachments/assets/\S+)[ \t]*$}gmi;

# A `<picture>` displays its first matching `<source>`, and the `<img>` inside
# it is only the fallback — a `<source>` carrying neither `media` nor `type`
# always matches, so it always wins. GitHub strips `srcset` from an `<img>`,
# which makes that one harmless, but it keeps `<source srcset>` and does not
# proxy it. So a fork-hosted `<source>` in front of an allowlisted `<img>` is
# what the reviewer actually looks at, and the `<img>` behind it is evidence of
# nothing. The `media="(prefers-color-scheme: dark)"` spelling is the one to
# watch: it is GitHub's own documented idiom, it reads as entirely legitimate,
# and it shows the fork to every reviewer in dark mode and nobody else.
my @shadow;
while ($t =~ /<source\b[^>]*?(?<![-\w:.])srcset\s*=\s*(["']?)([^"'>]+)\1/gi) {
    for my $cand (split /\s*,\s*/, $2) {   # a srcset is a candidate list
        $cand =~ s/^\s+//;
        $cand =~ s/\s.*\z//;               # drop the `2x` / `640w` descriptor
        push @shadow, $cand if length $cand;
    }
}
push @found, @shadow;

# Only a real target counts as a picture. The template ships three `![](…)`
# cells and an untouched one should be told it shows nothing — not told its
# screenshots are on the wrong host.
my @src = grep { m{^https?://}i } @found;

# One copy of the question, asked in two places. A userinfo `@`, a backslash,
# or any spelling of `..` means the host or the path is not what it reads as.
# `%25` and the always-invalid UTF-8 lead bytes are here for the same reason
# one step further out: they only do anything if something downstream decodes
# twice or accepts an overlong sequence, which would be a bug in GitHub rather
# than here — but no attachment URL GitHub produces contains a `%` at all, so
# refusing them costs nothing and does not have to be reasoned about again.
sub allowed {
    my ($u) = @_;
    return 0 if $u =~ /[\@\\]/ || $u =~ /\.\./ || $u =~ /%2e|%2f|%5c|%25|%c0|%c1/i;
    return 1 if $u =~ m{^https?://(?:user-images|private-user-images)\.githubusercontent\.com/}i;
    return 1 if $u =~ m{^https?://github\.com/user-attachments/assets/[^./]}i;
    return 0;
}

my $evidence = 'none';
if (@src) {
    $evidence = 'elsewhere';
    for my $u (@src) {
        if (allowed($u)) { $evidence = 'hosted'; last; }
    }
    if ($evidence eq 'elsewhere') {
        my %seen;
        for my $u (@src) {
            next if $seen{$u}++;
            print "refused=$u\n";
            last if keys(%seen) >= 5;
        }
    }
}
# A shadow we do not allow takes the verdict back down, whatever the `<img>`
# behind it says — only one of the two is ever on the screen.
$evidence = 'elsewhere'
    if $evidence eq 'hosted' && grep { !allowed($_) } @shadow;
print "evidence=$evidence\n";

my $linked = ($t =~ /(?:^|[^A-Za-z0-9_])#[0-9]+/ || $t =~ m{/issues/[0-9]+}
            || $title =~ /(?:^|[^A-Za-z0-9_])#[0-9]+/) ? 'yes' : 'no';
print "linked=$linked\n";
PERL

evidence=$(sed -n 's/^evidence=//p' "$work/facts")
linked=$(sed -n 's/^linked=//p' "$work/facts")
sed -n 's/^missing=//p' "$work/facts" > "$work/missing"
sed -n 's/^refused=//p' "$work/facts" > "$work/refused"

files=$(wc -l < "$files_list" | tr -d ' ')
added=$(awk '$1 ~ /^[0-9]+$/ { n += $1 } END { print n + 0 }' "$numstat")

# The three directories a person can see the result of.
grep -E '^(web|desktop|mobile)/' "$files_list" > "$work/ui" || true
ui=$(wc -l < "$work/ui" | tr -d ' ')

: > "$work/verdict"
say() { printf '%s\n' "$1" >> "$work/verdict"; }
plural() { if [ "$1" -eq 1 ]; then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }
fails=0

if [ "$ui" -gt 0 ] && [ "$evidence" = none ]; then
    fails=$((fails + 1))
    echo "::error::this pull request changes what people see, and shows none of it"
    say "### ✕ this pull request changes what people see, and shows none of it"
    say ""
    say "A failure here is never a failure of the code."
    say ""
    say "It touches $(plural "$files" file). These are the ones people look at:"
    say ""
    say '```'
    head -n 10 "$work/ui" >> "$work/verdict"
    if [ "$ui" -gt 10 ]; then say "...and $((ui - 10)) more"; fi
    say '```'
    say ""
    say "There is no image in the pull request body that GitHub is hosting."
    say ""
    say "Add a row to the Screenshots table for every user path you changed — before"
    say "and after, on every surface it appears on. Drag the images into the box so"
    say "GitHub hosts them rather than linking a branch on your fork."
    say ""
    say "A picture inside a code fence or an HTML comment does not count, because it"
    say "is not one — the reader sees the characters, or nothing at all."
    say ""
    say "This is the only check here that is not about the code. It exists because a"
    say "reviewer cannot see a screen from a diff, and because \"it looks right\" is not"
    say "something anybody can verify later."
    say ""
elif [ "$ui" -gt 0 ] && [ "$evidence" = elsewhere ]; then
    fails=$((fails + 1))
    echo "::error::the images here are ones that can be changed after they are approved"
    say "### ✕ the images here are ones that can be changed after they are approved"
    say ""
    say "A failure here is never a failure of the code."
    say ""
    say "This pull request touches $(plural "$ui" file) under \`web/\`, \`desktop/\` or"
    say "\`mobile/\`, and the body does carry images — but no image here is *served by*"
    say "a host GitHub controls. What each picture actually loads from:"
    say ""
    say '```'
    cat "$work/refused" >> "$work/verdict"
    say '```'
    say ""
    say "GitHub does not proxy those. The page points straight at the repository they"
    say "live in, so whoever owns it can change the picture a reviewer approved, or"
    say "delete it — and a deleted fork turns this into a page of broken images. #256"
    say "and #260 are both built that way today."
    say ""
    say "What counts is where the image loads from, not what is written near it. An"
    say "allowed host in the alt text, in the query string or in the sentence above"
    say "the picture is not where the picture comes from."
    say ""
    say "Drag the file into the comment box instead and GitHub rehosts it. That link"
    say "is immutable and outlives the fork. The three it accepts are:"
    say ""
    say '```'
    say "https://user-images.githubusercontent.com/..."
    say "https://private-user-images.githubusercontent.com/..."
    say "https://github.com/user-attachments/assets/..."
    say '```'
    say ""
    say "It refuses the others for that reason, and not to be awkward."
    say ""
fi

if [ -s "$work/missing" ]; then
    fails=$((fails + 1))
    echo "::error::the body is missing $(plural "$(wc -l < "$work/missing" | tr -d ' ')" section) the template asks for"
    say "### ✕ the body is missing sections the template asks for"
    say ""
    say "A failure here is never a failure of the code."
    say ""
    say "Missing:"
    say ""
    say '```'
    sed 's/^/## /' "$work/missing" >> "$work/verdict"
    say '```'
    say ""
    say "They are in \`.github/pull_request_template.md\` — paste the headings back in"
    say "and fill them. \"What I did not do\" is the one people delete; it is never"
    say "\"nothing\" on a pull request of any size, and it is what tells a reviewer"
    say "where to look hardest."
    say ""
    say "A heading inside an HTML comment or a code fence is not one. If your body"
    say "looks right to you and this says otherwise, check for a \`<!--\` you never"
    say "closed: GitHub hides everything after it, from the check and from the"
    say "reader both."
    say ""
fi

if [ "$files" -gt 30 ] || [ "$added" -gt 1500 ]; then
    echo "::warning::$files files and +$added lines — large enough that it will sit open"
    say "### ⚠ $files files and +$added lines"
    say ""
    say "Past about 30 files or 1,500 lines a pull request stops being reviewable in"
    say "one sitting and starts sitting open. Say in a comment which commits could"
    say "land on their own, or ask in Discord how to split it — #283 is 84 files and"
    say "ends by asking which half should be cut, and that was a cheaper question"
    say "before the code than after."
    say ""
    say "This is a warning. It does not fail."
    say ""
fi

if [ "$linked" = no ]; then
    echo "::warning::nothing here links an issue"
    say "### ⚠ nothing here links an issue"
    say ""
    say "Put \`Closes #123\` in the Why section. The issue wants the \`accepted\` label —"
    say "that label is the only thing that says a maintainer agreed to this before the"
    say "code existed, and a pull request without one may be closed without review."
    say ""
    say "A fix under about fifty lines with a screenshot needs no issue at all. If that"
    say "is what this is, ignore this."
    say ""
    say "This check cannot read the label. It holds \`contents: read\` and nothing else,"
    say "so it can see that an issue is linked and not what state it is in. This is a"
    say "warning. It does not fail."
    say ""
fi

if [ "$fails" -eq 0 ]; then
    case "$evidence" in
        hosted)    shown="an image GitHub is hosting" ;;
        elsewhere) shown="images, none of them GitHub-hosted" ;;
        *)         shown="none" ;;
    esac
    say "### ✓ the pull request shows its work"
    say ""
    say "$(plural "$files" file), +$added lines. $ui under \`web/\`, \`desktop/\` or \`mobile/\`."
    say "Evidence: $shown. Sections: all four present. Linked issue: $linked."
    say ""
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat "$work/verdict" >> "$GITHUB_STEP_SUMMARY"
fi
cat "$work/verdict"

if [ "$fails" -ne 0 ]; then
    echo "What failed above is the description, not the diff."
    echo "Edit the pull request body and this re-runs on its own."
    exit 1
fi
