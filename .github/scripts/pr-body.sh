#!/usr/bin/env sh
# What a pull request body actually says — as GitHub renders it, not as we
# imagine it.
#
# Called by the `contribution` workflow with the branch's changed files; the
# body and title arrive in `$BODY` and `$TITLE`. Prints its verdict, writes the
# same thing to the job summary, and exits 1 if the pull request fails.
#
# This used to parse the markdown itself — fences, code spans, HTML comments,
# block versus inline, the lot — and six separate passes over it found six
# divergences. Every one of the six was the same shape: the gap between what we
# parsed and what GitHub puts on the page. A fork-hosted image hiding behind an
# allowlisted `alt`. A `<!--` nobody closed. A `<picture>` whose `<source>`
# covers the `<img>` the check was reading. And, in the other direction, four
# honest shapes refused — setext headings, `## **bold**` headings, a raw `<h2>`,
# a reference-style image — each of which renders perfectly for a reader while
# the check told the author their description was missing.
#
# So it stopped guessing. The body goes to GitHub's own `/markdown` endpoint and
# what comes back is the HTML the pull request page shows. Sections are the
# headings in it; evidence is the images in it. There is no second renderer to
# disagree with the first, which is the whole of the idea — the class of bug
# goes with it, and so does the ugrep-versus-GNU-grep problem underneath it.
#
# What did NOT change is the policy, and it should not: the host allowlist
# anchored at the start of each URL, `..`, `@`, `\` and their percent-encodings
# refused, and a `<source>` we do not allow disqualifying the `<img>` behind it.
# Those survived five rounds of review on their own merits. Only the reading of
# the body moved.
#
# **It fails open.** If the endpoint is slow, down, or says anything other than
# 200, the check passes and says plainly in the summary that it could not run
# and why. This is advisory — a red cross here has never blocked a merge — and
# an outage at GitHub must never read as a contributor's mistake.
#
# What that costs, said here rather than discovered later: failing open means
# the check can be made not to run. Burning the hourly API budget on edit
# events would do it, and so would picking a bad minute. That is a real trade
# and it is the right one — this is a signal, and a signal that cries wolf
# through a GitHub incident is worse than one that can be stepped around by
# somebody who has already decided to.
set -eu

if [ "$#" -ne 2 ]; then
    echo "usage: pr-body.sh <changed-files> <numstat>" >&2
    exit 2
fi

files_list=$1
numstat=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- ask GitHub what this body looks like -----------------------------------

perl > "$work/payload.json" <<'PERL'
my $b = $ENV{BODY} // '';
$b =~ s/\\/\\\\/g;
$b =~ s/"/\\"/g;
$b =~ s/\r/\\r/g;
$b =~ s/\n/\\n/g;
$b =~ s/\t/\\t/g;
$b =~ s/([\x00-\x1f])/sprintf('\\u%04x', ord($1))/ge;
print '{"text":"' . $b . '","mode":"gfm","context":"firetower-cloud/firetower"}';
PERL

token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
if [ -n "$token" ]; then
    set -- -H "Authorization: Bearer $token"
else
    set --
fi

status=$(curl -sS -o "$work/rendered.html" -w '%{http_code}' \
    -X POST https://api.github.com/markdown \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$@" \
    --max-time 20 --retry 2 --retry-delay 1 --retry-all-errors \
    --data-binary "@$work/payload.json" 2>"$work/curl.err") || status=000

if [ "$status" != "200" ]; then
    {
        echo "### ⚠ this check could not run"
        echo
        echo "It asks GitHub to render the pull request body and reads the result, so that"
        echo "it is looking at the same page a reviewer is. That request did not come back:"
        echo
        echo '```'
        echo "POST https://api.github.com/markdown  ->  $status"
        sed -n '1,3p' "$work/curl.err" 2>/dev/null || true
        echo '```'
        echo
        echo "So it is passing. Nothing is wrong with this pull request as far as anybody"
        echo "here knows — the check simply has no opinion this time. Re-run it from the"
        echo "Checks tab, or edit the body, and it will try again."
    } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    echo "::warning::the contribution check could not reach GitHub's renderer and is passing"
    exit 0
fi

# --- read the page ----------------------------------------------------------

perl - "$work/rendered.html" > "$work/facts" <<'PERL'
my $h = do { local $/; open my $fh, '<', $ARGV[0] or die "$!"; <$fh> };
$h = '' unless defined $h;
my $title = $ENV{TITLE} // '';

sub untag { my ($x) = @_; $x =~ s/<[^>]*>//gs; return $x; }
sub unent {
    my ($x) = @_;
    $x =~ s/&lt;/</g;  $x =~ s/&gt;/>/g;  $x =~ s/&quot;/"/g;
    $x =~ s/&#0*39;/'/g; $x =~ s/&#x0*27;/'/gi;
    $x =~ s/&amp;/&/g;   # last, or everything above decodes twice
    return $x;
}

# GitHub proxies an off-site image through camo, and the proxy URL carries the
# original hex-encoded in its last path segment. Showing somebody a camo hash
# when they asked what their picture loads from is no answer at all.
sub pretty {
    my ($u) = @_;
    if ($u =~ m{^https?://camo\.githubusercontent\.com/[^/]+/([0-9a-fA-F]+)}) {
        my $hex = $1;
        if (length($hex) % 2 == 0) {
            my $decoded = pack 'H*', $hex;
            return $decoded if $decoded =~ m{^https?://};
        }
    }
    return $u;
}

# --- the sections the template asks for -------------------------------------
# Whatever GitHub calls a heading is a heading: an ATX one, a setext one, a
# bolded one, a raw <h2> somebody wrote by hand. All four arrive here as the
# same tag, which is the point of asking the renderer instead of the text.
my @headings;
while ($h =~ m{<h([1-6])\b[^>]*>(.*?)</h\1>}gis) {
    my $t = unent(untag($2));
    $t =~ s/\A\s+//; $t =~ s/\s+\z//; $t =~ s/\s+/ /g;
    push @headings, lc $t;
}
for my $want ('What changes', 'Why', 'How it was checked', 'What I did not do') {
    my $w = lc $want;
    print "missing=$want\n" unless grep { index($_, $w) == 0 } @headings;
}

# --- what it shows ----------------------------------------------------------
# Only what the page loads. An allowed host written in the alt text, in a query
# string or in the sentence above the picture is not where the picture is from.
my (@found, @shadow);
while ($h =~ m{<(img|source|video)\b([^>]*)>}gis) {
    my ($tag, $attrs) = (lc $1, $2);
    # Walk the attributes as name=value pairs from the start of the tag. A
    # search for `src=` instead finds one written *inside* an earlier value —
    # GitHub keeps `alt`, `title` and `aria-label` ahead of `src` and keeps the
    # single quotes in them, so `alt="x src='<allowlisted>'"` was read as the
    # source while the page loaded the fork. A value can only be consumed as a
    # value here, never re-read as a name. First one wins, as HTML does with a
    # repeated attribute.
    #
    # Two properties of the sanitised HTML hold this up, and both were checked
    # rather than assumed: a `>` inside a value comes back as `&gt;`, so the
    # tag really does end at the first `>`; and a `"` cannot survive inside a
    # double-quoted value at all — GitHub drops the whole element instead.
    my %attr;
    while ($attrs =~ m{([-\w:.]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))}gs) {
        my $name = lc $1;
        my $val  = defined $2 ? $2 : defined $3 ? $3 : $4;
        $attr{$name} = $val unless exists $attr{$name};
    }
    my @urls;
    if (defined $attr{src}) {
        push @urls, unent($attr{src});
    }
    if (defined $attr{srcset}) {
        for my $cand (split /\s*,\s*/, unent($attr{srcset})) {   # a srcset is a candidate list
            $cand =~ s/\A\s+//;
            $cand =~ s/\s.*\z//;                      # drop the `2x` / `640w` descriptor
            push @urls, $cand if length $cand;
        }
    }
    @urls = grep { m{^https?://}i } @urls;
    push @found, @urls;
    # A <source> overrides the <img> or <video> it sits beside — a <picture>
    # shows its first matching <source> and keeps the <img> only as a fallback,
    # and a <source> with neither `media` nor `type` always matches. So what a
    # <source> points at is what the reader sees.
    push @shadow, @urls if $tag eq 'source';
}

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
if (@found) {
    $evidence = 'elsewhere';
    for my $u (@found) {
        if (allowed($u)) { $evidence = 'hosted'; last; }
    }
}
# A shadow we do not allow takes the verdict back down whatever the picture
# behind it says — only one of the two is ever on the screen.
$evidence = 'elsewhere'
    if $evidence eq 'hosted' && grep { !allowed($_) } @shadow;

if ($evidence eq 'elsewhere') {
    my %seen;
    for my $u (@found) {
        my $p = pretty($u);
        next if $seen{$p}++;
        print "refused=$p\n";
        last if keys(%seen) >= 5;
    }
}
print "evidence=$evidence\n";

my $text = unent(untag($h));
my $linked = ($text =~ /(?:^|[^A-Za-z0-9_])#[0-9]+/
           || $h =~ m{/issues/[0-9]+}
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

# The verdict first and the warnings under it, because the answer is what
# somebody opened this to read.
: > "$work/verdict"
: > "$work/warnings"
out="$work/verdict"
say() { printf '%s\n' "$1" >> "$out"; }
plural() { if [ "$1" -eq 1 ]; then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }
fails=0

ui_files() {
    say '```'
    head -n 10 "$work/ui" >> "$out"
    if [ "$ui" -gt 10 ]; then say "...and $((ui - 10)) more"; fi
    say '```'
}

if [ "$ui" -gt 0 ] && [ "$evidence" = none ]; then
    fails=$((fails + 1))
    echo "::error::this pull request changes what people see, and shows none of it"
    say "### ✕ this pull request changes what people see, and shows none of it"
    say ""
    say "A failure here is never a failure of the code."
    say ""
    if [ "$ui" -eq 1 ]; then
        say "It touches $(plural "$files" file). This is the one people look at:"
    else
        say "It touches $(plural "$files" file). These are the ones people look at:"
    fi
    say ""
    ui_files
    say ""
    say "GitHub rendered the body and there is no image in it."
    say ""
    say "Add a row to the Screenshots table for every user path you changed — before"
    say "and after, on every surface it appears on. Drag the images into the box so"
    say "GitHub hosts them rather than linking a branch on your fork."
    say ""
    say "This check reads the page GitHub draws, not the markdown you typed, so a"
    say "picture inside a comment or a code fence does not count — the reader cannot"
    say "see it either. If one is missing and you cannot think why, open the pull"
    say "request's Conversation tab: whatever is on that page is what this read."
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
    if [ "$ui" -eq 1 ]; then
        say "It touches $(plural "$files" file). This is the one people look at:"
    else
        say "It touches $(plural "$files" file). These are the ones people look at:"
    fi
    say ""
    ui_files
    say ""
    say "The body does carry pictures, and no picture on the rendered page is served"
    say "by a host GitHub controls. What each one actually loads from:"
    say ""
    say '```'
    cat "$work/refused" >> "$out"
    say '```'
    say ""
    say "Those stay under somebody else's control. The owner can change the picture a"
    say "reviewer approved, or delete it — and a deleted fork turns this into a page of"
    say "broken images. #256 and #260 are both built that way today. An off-site image"
    say "GitHub caches through its proxy is the same problem one step along: the cache"
    say "is refilled from wherever it came from."
    say ""
    say "What counts is where the image loads from, not what is written near it. An"
    say "allowed host in the alt text, in the query string or in the sentence above the"
    say "picture is not where the picture comes from."
    say ""
    say "Drag the file into the comment box instead and GitHub rehosts it. That link is"
    say "immutable and outlives the fork. The three it accepts are:"
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
    sed 's/^/## /' "$work/missing" >> "$out"
    say '```'
    say ""
    say "They are in \`.github/pull_request_template.md\` — paste the headings back in"
    say "and fill them. \"What I did not do\" is the one people delete; it is never"
    say "\"nothing\" on a pull request of any size, and it is what tells a reviewer"
    say "where to look hardest."
    say ""
    say "This reads the headings off the page GitHub draws, so any heading it draws"
    say "counts — \`##\`, an underlined one, a bolded one, a hand-written \`<h2>\`. If a"
    say "heading looks right to you and this cannot find it, it is almost always"
    say "raw HTML earlier in the body: GitHub stops reading markdown after an HTML"
    say "block, and everything under it comes out as plain text. Leave a blank line"
    say "between the HTML and the next heading and both come back."
    say ""
fi

out="$work/warnings"

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

out="$work/verdict"
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

cat "$work/verdict" "$work/warnings" > "$work/summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat "$work/summary" >> "$GITHUB_STEP_SUMMARY"
fi
cat "$work/summary"

if [ "$fails" -ne 0 ]; then
    echo "What failed above is the description, not the diff."
    echo "Edit the pull request body and this re-runs on its own."
    exit 1
fi
