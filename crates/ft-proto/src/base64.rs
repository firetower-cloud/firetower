//! Terminal bytes, carried by a JSON frame.
//!
//! Frames are JSON and terminal output is not text: it holds escape sequences,
//! and a read can land mid-character in a UTF-8 sequence. Base64 is what makes
//! those bytes survive the trip unchanged.
//!
//! Written out rather than taken as a dependency — it is thirty lines, and both
//! ends of the protocol need exactly this and nothing more.

pub fn encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);

        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The other direction, for keystrokes arriving from a browser.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    }

    let text = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;

    for &c in text {
        acc = acc << 6 | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_survive_the_round_trip() {
        // Terminal output is not text: escape sequences, high bytes, and UTF-8
        // cut mid-character all have to come back exactly as they went in.
        for case in [
            b"".to_vec(),
            b"a".to_vec(),
            b"ab".to_vec(),
            b"abc".to_vec(),
            b"\x1b[31mred\x1b[0m".to_vec(),
            vec![0, 255, 128, 1, 2, 3],
            "héllo ✓".as_bytes().to_vec(),
            vec![0xf0, 0x9f], // half an emoji, as a chunk boundary would give
        ] {
            assert_eq!(decode(&encode(&case)).unwrap(), case, "{case:?}");
        }
    }

    #[test]
    fn encoding_matches_the_standard() {
        assert_eq!(encode(b"hello"), "aGVsbG8=");
        assert_eq!(encode(b"hi"), "aGk=");
        assert_eq!(decode("aGVsbG8=").unwrap(), b"hello");
    }

    #[test]
    fn nonsense_decodes_to_nothing_rather_than_panicking() {
        assert!(decode("not valid base64!").is_none());
    }
}
