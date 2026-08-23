//! Reading a pasted `.env`, and writing one back out.
//!
//! Nobody types sixteen variables into a form. They paste the file they already
//! have — with `export ` in front of some lines, quotes around some values,
//! comments, and a blank line at the end — and it has to come out the way they
//! meant it.

/// A variable and what it is set to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variable {
    pub name: String,
    pub value: String,
}

/// Why a line couldn't be used, in words that name the line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub line: usize,
    pub reason: String,
}

/// What a paste turned into: what will be stored, and what was skipped.
#[derive(Debug, Default)]
pub struct Parsed {
    pub variables: Vec<Variable>,
    pub rejected: Vec<Rejected>,
}

/// Read a `.env`.
///
/// Later definitions win, the way the shell and every dotenv library treat a
/// repeated name.
pub fn parse(text: &str) -> Parsed {
    let mut out = Parsed::default();

    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // `export FOO=bar` is what a file meant to be sourced looks like.
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();

        let Some((name, value)) = line.split_once('=') else {
            out.rejected.push(Rejected {
                line: n + 1,
                reason: format!("no `=` in `{}`", clipped(line)),
            });
            continue;
        };

        let name = name.trim();
        if let Err(reason) = check(name) {
            out.rejected.push(Rejected {
                line: n + 1,
                reason,
            });
            continue;
        }

        let value = unquote(value.trim());

        // Later wins, so a file that sets something twice behaves the way it
        // does everywhere else.
        if let Some(existing) = out.variables.iter_mut().find(|v| v.name == name) {
            existing.value = value;
        } else {
            out.variables.push(Variable {
                name: name.to_string(),
                value,
            });
        }
    }

    out
}

/// Whether this is a name a shell would accept.
///
/// Checked because the alternative is a variable that is stored, listed, and
/// silently absent from every session — `tmux -e` will not take `my-var`.
pub fn check(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a variable needs a name".into());
    }

    let mut chars = name.chars();
    let first = chars.next().unwrap_or_default();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "`{}` can't start with `{first}` — a name starts with a letter or `_`",
            clipped(name)
        ));
    }

    if let Some(bad) = chars.find(|c| !(c.is_ascii_alphanumeric() || *c == '_')) {
        return Err(format!(
            "`{}` can't contain `{bad}` — names are letters, digits and `_`",
            clipped(name)
        ));
    }

    Ok(())
}

/// Write the file back out, quoted so that reading it returns what went in.
pub fn render(variables: &[Variable]) -> String {
    let mut out = String::from(
        "# Written by Firetower when this session started.\n\
         # Edits are lost the next time a session on this repository starts.\n",
    );

    for v in variables {
        out.push_str(&v.name);
        out.push('=');
        out.push_str(&quoted(&v.value));
        out.push('\n');
    }

    out
}

/// Single quotes where they work, double quotes where they must.
///
/// Inside single quotes a value is literal to every reader: `$HOME` stays
/// `$HOME`, a `#` is not a comment. That covers almost everything. It cannot
/// cover a value that itself contains a single quote or a newline — the shell
/// trick for that (`'\''`) is a shell trick, and a dotenv library reading this
/// file would hand back the escaping along with the value. Those get double
/// quotes and the escapes `unquote` below understands.
fn quoted(value: &str) -> String {
    if !value.contains('\'') && !value.contains('\n') {
        return format!("'{value}'");
    }

    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

/// Strip the quotes a file was written with, if it was written with any.
///
/// Inside double quotes `\n` means a newline, because that is the only way a
/// multi-line value survives a file whose format is one line each. Inside
/// single quotes nothing does.
fn unquote(value: &str) -> String {
    let mut chars = value.chars();
    match (chars.next(), value.chars().last()) {
        (Some('\''), Some('\'')) if value.len() >= 2 => value[1..value.len() - 1].to_string(),
        (Some('"'), Some('"')) if value.len() >= 2 => value[1..value.len() - 1]
            .replace("\\n", "\n")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\"),
        // Unquoted: a trailing comment is a comment, the way dotenv readers
        // treat one. `KEY=value # why` is not a value ending in "# why".
        _ => match value.split_once(" #") {
            Some((before, _)) => before.trim_end().to_string(),
            None => value.to_string(),
        },
    }
}

/// Enough of it to recognise, in a message that has to fit on a line.
fn clipped(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(40) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(parsed: &Parsed) -> Vec<&str> {
        parsed.variables.iter().map(|v| v.name.as_str()).collect()
    }

    #[test]
    fn a_real_file_survives_being_pasted() {
        let parsed = parse(
            r#"
# database
DATABASE_URL=postgres://user:pass@localhost:5432/app

export STRIPE_KEY="sk_test_abc123"
QUOTED='single quoted # not a comment'
NODE_ENV=test # the comment goes
EMPTY=
"#,
        );

        assert_eq!(
            names(&parsed),
            ["DATABASE_URL", "STRIPE_KEY", "QUOTED", "NODE_ENV", "EMPTY"]
        );
        assert_eq!(
            parsed.variables[0].value,
            "postgres://user:pass@localhost:5432/app"
        );
        assert_eq!(parsed.variables[1].value, "sk_test_abc123");
        assert_eq!(parsed.variables[2].value, "single quoted # not a comment");
        assert_eq!(parsed.variables[3].value, "test");
        assert_eq!(parsed.variables[4].value, "");
        assert!(parsed.rejected.is_empty());
    }

    /// A value with an `=` in it is the common case for a URL or a base64 key.
    #[test]
    fn only_the_first_equals_separates() {
        let parsed = parse("TOKEN=abc=def==");
        assert_eq!(parsed.variables[0].value, "abc=def==");
    }

    #[test]
    fn a_name_a_shell_would_refuse_is_said_rather_than_stored() {
        let parsed = parse("my-var=1\n2FA=x\njust a sentence\nGOOD=1");

        assert_eq!(names(&parsed), ["GOOD"]);
        assert_eq!(parsed.rejected.len(), 3);
        assert_eq!(parsed.rejected[0].line, 1);
        assert!(
            parsed.rejected[0].reason.contains('-'),
            "the message says what is wrong with it: {}",
            parsed.rejected[0].reason
        );
        assert_eq!(parsed.rejected[2].reason, "no `=` in `just a sentence`");
    }

    #[test]
    fn the_last_definition_wins() {
        let parsed = parse("A=1\nA=2");
        assert_eq!(parsed.variables.len(), 1);
        assert_eq!(parsed.variables[0].value, "2");
    }

    /// What is written has to read back identically, or a password with a
    /// quote in it quietly becomes a different password.
    #[test]
    fn writing_and_reading_are_the_same_round_trip() {
        let awkward = vec![
            Variable {
                name: "PLAIN".into(),
                value: "simple".into(),
            },
            Variable {
                name: "SPACES".into(),
                value: "two words".into(),
            },
            Variable {
                name: "QUOTE".into(),
                value: "it's mine".into(),
            },
            Variable {
                name: "HASH".into(),
                value: "a#b".into(),
            },
            Variable {
                name: "DOLLAR".into(),
                value: "$HOME and `date`".into(),
            },
            Variable {
                name: "EMPTY".into(),
                value: String::new(),
            },
            Variable {
                name: "KEY".into(),
                value: "-----BEGIN-----\nline two\n-----END-----".into(),
            },
            Variable {
                name: "BACKSLASH".into(),
                value: "C:\\path\\to".into(),
            },
        ];

        let back = parse(&render(&awkward));
        assert_eq!(back.variables, awkward);
        assert!(back.rejected.is_empty());
    }
}
