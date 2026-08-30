//! The session state machine.
//!
//! A session doesn't "finish" — it hands the work back and waits. The only
//! terminal state is [`SessionStatus::Ended`]: branch shipped, workspace gone.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub enum SessionStatus {
    /// The workspace is being built.
    Starting,
    /// The agent is doing something.
    Working,
    /// Up, idle, and waiting for its first instruction.
    ///
    /// A workspace may be made without a task — a branch checked out and an
    /// agent waiting in it, to be told what to do once you are looking at the
    /// files. That agent is not `Working`: nothing is in flight and nothing
    /// will arrive to say otherwise, so a session created that way sat under a
    /// breathing "Working" light forever.
    ///
    /// Not [`needs_you`](Self::needs_you) either. Nothing is blocked and
    /// nothing went wrong — you have simply not said anything yet, and a
    /// workspace you made ten seconds ago does not belong in an inbox.
    Ready,
    /// Blocked on a question only you can answer.
    NeedsYou,
    /// Did a turn and is waiting for the next thing. A resting state, not an end.
    HandedBack,
    /// Something broke. Also your move.
    Failed,
    /// Branch shipped, workspace destroyed. Terminal.
    Ended,
}

impl SessionStatus {
    /// Whether this session is waiting on a human.
    ///
    /// All three of these mean the same thing to the person using Firetower:
    /// it stopped being useful without you. That's why they share an inbox.
    /// Whether this session still has something running behind it.
    ///
    /// `Ended` was cleaned up and `Failed` never got going — neither holds a
    /// workspace, an agent, or a claim on the host it was scheduled to.
    pub fn is_finished(&self) -> bool {
        matches!(self, Self::Ended | Self::Failed)
    }

    pub fn needs_you(&self) -> bool {
        matches!(self, Self::NeedsYou | Self::HandedBack | Self::Failed)
    }

    /// Whether the agent is still doing something unattended.
    pub fn in_flight(&self) -> bool {
        matches!(self, Self::Starting | Self::Working)
    }

    /// Nothing follows this.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Ended)
    }

    /// What the interface calls it.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Starting => "Starting up",
            Self::Working => "Working",
            Self::Ready => "Ready",
            Self::NeedsYou => "Asked a question",
            Self::HandedBack => "Handed it back",
            Self::Failed => "Failed",
            Self::Ended => "Ended",
        }
    }

    /// Whether `self -> next` is a move the system can actually make.
    ///
    /// The interesting cases: a session can go back to Working from any resting
    /// state, because you reply and it carries on — that's what makes it a
    /// session rather than a task. And nothing leaves `Ended`.
    pub fn can_transition_to(self, next: SessionStatus) -> bool {
        use SessionStatus::*;
        match (self, next) {
            // Nothing escapes the terminal state.
            (Ended, _) => false,

            // Anything can be ended or fail.
            (_, Ended) | (_, Failed) => true,

            // Booting. A session with a first prompt goes straight to work;
            // one made without a task comes up idle instead.
            (Starting, Working | Ready) => true,
            (Starting, _) => false,

            // Working either stops for you, or keeps going.
            (Working, NeedsYou | HandedBack | Working) => true,
            (Working, Starting) => false,

            // You replied, or asked for something else. Back to work.
            (NeedsYou | HandedBack | Failed | Ready, Working) => true,

            // Sideways moves between resting states. `Ready` is not among
            // them: it means "has never been asked for anything", and nothing
            // that has done a turn can go back to never having done one.
            (NeedsYou, HandedBack) | (HandedBack, NeedsYou) => true,

            _ => false,
        }
    }

    /// Apply a transition, or explain why it can't happen.
    pub fn transition_to(self, next: SessionStatus) -> Result<SessionStatus, TransitionError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(TransitionError {
                from: self,
                to: next,
            })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("a session cannot go from {from:?} to {to:?}")]
pub struct TransitionError {
    pub from: SessionStatus,
    pub to: SessionStatus,
}

#[cfg(test)]
mod tests {
    use super::SessionStatus::*;

    #[test]
    fn ended_is_the_only_terminal_state() {
        for s in [Starting, Working, NeedsYou, HandedBack, Failed, Ended] {
            assert_eq!(s.is_terminal(), s == Ended, "{s:?}");
        }
    }

    #[test]
    fn nothing_escapes_ended() {
        for s in [Starting, Working, NeedsYou, HandedBack, Failed, Ended] {
            assert!(
                !Ended.can_transition_to(s),
                "Ended -> {s:?} must be refused"
            );
        }
    }

    #[test]
    fn a_resting_session_can_be_resumed() {
        // The whole reason it's a session and not a task.
        assert!(HandedBack.can_transition_to(Working));
        assert!(NeedsYou.can_transition_to(Working));
        assert!(Failed.can_transition_to(Working));
    }

    #[test]
    fn resting_states_are_the_inbox() {
        assert!(NeedsYou.needs_you());
        assert!(HandedBack.needs_you());
        assert!(Failed.needs_you());
        assert!(!Working.needs_you());
        assert!(!Starting.needs_you());
        assert!(!Ended.needs_you());
    }

    #[test]
    fn a_starting_session_cannot_skip_straight_to_resting() {
        assert!(!Starting.can_transition_to(NeedsYou));
        assert!(!Starting.can_transition_to(HandedBack));
        assert!(Starting.can_transition_to(Working));
    }

    #[test]
    fn anything_can_fail_or_be_ended() {
        for s in [Starting, Working, NeedsYou, HandedBack, Failed] {
            assert!(s.can_transition_to(Failed), "{s:?} -> Failed");
            assert!(s.can_transition_to(Ended), "{s:?} -> Ended");
        }
    }

    #[test]
    fn transition_reports_what_it_refused() {
        let err = Ended.transition_to(Working).unwrap_err();
        assert_eq!(err.from, Ended);
        assert_eq!(err.to, Working);
    }

    #[test]
    fn in_flight_and_needs_you_are_disjoint() {
        for s in [Starting, Working, NeedsYou, HandedBack, Failed, Ended] {
            assert!(!(s.in_flight() && s.needs_you()), "{s:?} cannot be both");
        }
    }
}

#[cfg(test)]
mod finished_tests {
    use super::*;

    #[test]
    fn a_failed_session_holds_nothing() {
        // It never got a workspace, so it must not block removing the host or
        // the repository it was scheduled against.
        assert!(SessionStatus::Failed.is_finished());
        assert!(SessionStatus::Ended.is_finished());

        for still_going in [
            SessionStatus::Starting,
            SessionStatus::Working,
            SessionStatus::NeedsYou,
            SessionStatus::HandedBack,
        ] {
            assert!(!still_going.is_finished(), "{still_going:?}");
        }
    }
}
