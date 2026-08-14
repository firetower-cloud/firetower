//! The contract git actually uses.
//!
//! `GIT_ASKPASS` is invoked as `<program> "<prompt>"` — no subcommand, no
//! flags — and whatever it prints on stdout is the answer. Nothing else in the
//! suite exercised that, which is how the binary shipped unable to answer at
//! all: git handed it a prompt, the argument parser read it as a subcommand
//! name, and it exited with a usage error.
//!
//! So this test runs the real binary the way git runs it.

use ft_proto::Credential;
use ft_worker::askpass::Askpass;
use std::process::Command;

/// What cargo built for this test run — the same binary a worker uses.
const FIRETOWER: &str = env!("CARGO_BIN_EXE_firetower");

#[tokio::test]
async fn git_can_ask_the_binary_for_a_credential() {
    let credential = Credential {
        username: "x-access-token".into(),
        secret: "the-secret-value".into(),
    };

    let serving = Askpass::start(credential, std::path::Path::new(FIRETOWER))
        .await
        .expect("starting the credential server");

    let env = serving.env();
    let askpass = env
        .iter()
        .find(|(k, _)| k == "GIT_ASKPASS")
        .map(|(_, v)| v.clone())
        .expect("GIT_ASKPASS should be set");

    // Exactly what git does: run it with the prompt as the only argument.
    let answer = tokio::task::spawn_blocking(move || {
        Command::new(&askpass)
            .arg("Password for 'https://x-access-token@github.com': ")
            .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
            .output()
            .expect("running the askpass program")
    })
    .await
    .unwrap();

    let printed = String::from_utf8_lossy(&answer.stdout);
    let complaint = String::from_utf8_lossy(&answer.stderr);

    assert!(
        answer.status.success(),
        "askpass should succeed, said: {complaint}"
    );
    assert_eq!(
        printed.trim(),
        "the-secret-value",
        "git reads one line from stdout, and that line is the credential"
    );
}

#[tokio::test]
async fn git_gets_the_username_when_it_asks_for_one() {
    let credential = Credential {
        username: "x-access-token".into(),
        secret: "the-secret-value".into(),
    };

    let serving = Askpass::start(credential, std::path::Path::new(FIRETOWER))
        .await
        .unwrap();

    let env = serving.env();
    let askpass = env
        .iter()
        .find(|(k, _)| k == "GIT_ASKPASS")
        .map(|(_, v)| v.clone())
        .unwrap();

    let answer = tokio::task::spawn_blocking(move || {
        Command::new(&askpass)
            .arg("Username for 'https://github.com': ")
            .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
            .output()
            .unwrap()
    })
    .await
    .unwrap();

    assert_eq!(
        String::from_utf8_lossy(&answer.stdout).trim(),
        "x-access-token",
        "the two prompts must not answer the same way"
    );
}
