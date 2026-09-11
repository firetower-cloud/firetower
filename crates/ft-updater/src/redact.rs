//! Keep a value that looks like a secret out of a log line.
//!
//! Nothing the updater runs is handed a credential, so this should never have
//! anything to do. It exists because "should never" is the wrong strength of
//! claim for the one log that is shown on a screen and kept in a database:
//! Compose prints the environment it interpolated when it fails to parse a
//! file, and `.env` holds the database password.

/// Mask the value after `KEY=` for keys that name a secret.
///
/// Whole-word, case-insensitive, and only on the value: `POSTGRES_PASSWORD=`
/// stays legible so the line still says which variable it was.
pub fn redact(line: &str) -> String {
    const SUSPECT: [&str; 5] = ["password", "token", "secret", "key", "credential"];

    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(eq) = rest.find('=') {
        let (before, after) = rest.split_at(eq);
        // The identifier immediately before the `=`.
        let name_start = before
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map(|i| i + 1)
            .unwrap_or(0);
        let name = &before[name_start..];
        out.push_str(before);
        out.push('=');

        // A quoted value runs to its closing quote; a bare one to the next
        // separator.
        let raw = &after[1..];
        let (open, close) = match raw.chars().next() {
            Some(q @ ('"' | '\'')) => (1, raw[1..].find(q).map(|i| i + 1).unwrap_or(raw.len())),
            _ => (
                0,
                raw.find(|c: char| c.is_whitespace() || c == ',')
                    .unwrap_or(raw.len()),
            ),
        };
        let value = &raw[open..close];
        let lowered = name.to_ascii_lowercase();
        out.push_str(&raw[..open]);
        if !value.is_empty() && SUSPECT.iter().any(|s| lowered.contains(s)) {
            out.push_str("***");
        } else {
            out.push_str(value);
        }
        rest = &raw[close..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn a_secret_value_is_masked_and_its_name_is_kept() {
        assert_eq!(
            redact("POSTGRES_PASSWORD=hunter2 HTTP_PORT=8080"),
            "POSTGRES_PASSWORD=*** HTTP_PORT=8080"
        );
        assert_eq!(
            redact("env: FIRETOWER_UPDATER_TOKEN=abc,DOMAIN=x"),
            "env: FIRETOWER_UPDATER_TOKEN=***,DOMAIN=x"
        );
        assert_eq!(
            redact("DNS_API_TOKEN=\"tok\""),
            "DNS_API_TOKEN=\"tok\"".replace("tok", "***")
        );
    }

    #[test]
    fn an_ordinary_line_is_left_alone() {
        assert_eq!(
            redact("Pulled ghcr.io/x/y:latest"),
            "Pulled ghcr.io/x/y:latest"
        );
        assert_eq!(redact("a == b"), "a == b");
        assert_eq!(redact("FIRETOWER_ROOT_KEY="), "FIRETOWER_ROOT_KEY=");
    }
}
