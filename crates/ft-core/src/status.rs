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
    /// The machine under it restarted. The workspace is there; the agent is not.
    ///
    /// Not [`Failed`](Self::Failed), and the difference is four predicates
    /// rather than a choice of words. `Failed.is_finished()` is true, which
    /// tells the control plane a session holds nothing — and this one holds a
    /// worktree, a branch and whatever the agent had already written.
    /// `Db::live_session_ids_on` excludes `Failed`, so marking it that would
    /// drop the session from the watch list every reconnect asks about, and a
    /// session wrongly marked once is an agent nobody ever follows again. And
    /// typing into a `Failed` session already restarts it — see
    /// `api::conversation` — which for a machine that restarted under twelve
    /// agents would be twelve agents restarted by a keystroke.
    ///
    /// The only way out is a restart somebody asked for. That is held here, in
    /// the transition table, rather than in a comment asking people to
    /// remember: see [`can_transition_to`](Self::can_transition_to).
    Stranded,
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
    /// `Stranded` is not among them, and that is the point of it: a stranded
    /// session is still holding its workspace on a machine, which is why
    /// removing that machine or that repository has to keep saying no.
    pub fn is_finished(&self) -> bool {
        matches!(self, Self::Ended | Self::Failed)
    }

    pub fn needs_you(&self) -> bool {
        matches!(
            self,
            Self::NeedsYou | Self::HandedBack | Self::Failed | Self::Stranded
        )
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
            Self::Stranded => "Machine restarted",
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

            // A machine that restarted leaves by a restart somebody pressed,
            // or by being let go of. Nothing else, and deliberately above the
            // arm below rather than after it:
            //
            // - not `Working`, because a stranded session cannot start working
            //   again without passing through a start. That is what makes the
            //   consent structural, and it is what stops a stale pre-crash
            //   `StatusChanged { Working }` — replayed by the worker on its
            //   next reconnect — from quietly un-stranding one. `Db::write_event`
            //   holds the same rule in SQL, and holds one more that cannot be
            //   written here: `Starting` is the doorway out, so only the
            //   control plane itself may say it. This table knows which moves
            //   exist and not who is asking for one.
            // - not `Failed`, because a recovery that would not start has
            //   changed nothing: the worktree, the branch and the uncommitted
            //   edits are all still there. The reason goes in the note and the
            //   state stays where it is.
            (Stranded, Starting | Ended) => true,
            (Stranded, _) => false,

            // Anything can be ended or fail.
            (_, Ended) | (_, Failed) => true,

            // The floor went while something was running. Proof, not a guess:
            // the worker probed tmux and was told there is no session.
            (Starting | Working | NeedsYou, Stranded) => true,

            // Booting. A session with a first prompt goes straight to work;
            // one made without a task comes up idle instead — and a recovered
            // one reads its own history and may have nothing to answer, which
            // is `HandedBack`. Not `Ready`: that means "has never been asked
            // for anything", and this session has a conversation behind it.
            (Starting, Working | Ready | HandedBack) => true,
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
        for s in [
            Starting, Working, NeedsYou, HandedBack, Failed, Stranded, Ended,
        ] {
            assert_eq!(s.is_terminal(), s == Ended, "{s:?}");
        }
    }

    #[test]
    fn nothing_escapes_ended() {
        for s in [
            Starting, Working, NeedsYou, HandedBack, Failed, Stranded, Ended,
        ] {
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
        // A machine that restarted is nobody's move but yours: nothing will
        // happen to it until somebody presses.
        assert!(Stranded.needs_you());
        assert!(!Working.needs_you());
        assert!(!Starting.needs_you());
        assert!(!Ended.needs_you());
    }

    #[test]
    fn a_starting_session_cannot_skip_straight_to_being_asked() {
        assert!(!Starting.can_transition_to(NeedsYou));
        assert!(Starting.can_transition_to(Working));
    }

    /// An agent brought back after its machine restarted starts with no
    /// prompt — `relaunch` sends one deliberately empty — reads its own
    /// history, and may have nothing to answer. It stops there, and the
    /// honest resting state for that is `HandedBack`: `Ready` means "has
    /// never been asked for anything", which is false of a session with a
    /// conversation behind it.
    #[test]
    fn a_recovered_agent_may_come_back_with_nothing_to_say() {
        assert!(Starting.can_transition_to(HandedBack));
    }

    #[test]
    fn anything_can_fail_or_be_ended() {
        for s in [Starting, Working, NeedsYou, HandedBack, Failed] {
            assert!(s.can_transition_to(Failed), "{s:?} -> Failed");
            assert!(s.can_transition_to(Ended), "{s:?} -> Ended");
        }
        // Except a stranded one, which cannot fail. A restart that would not
        // take has changed nothing about the workspace, so the reason belongs
        // in the note and the state belongs where it is — otherwise one failed
        // attempt moves the session into a state that says it holds nothing
        // and that a keystroke may restart.
        assert!(!Stranded.can_transition_to(Failed));
        assert!(Stranded.can_transition_to(Ended));
    }

    /// The only entry, and the only way out.
    #[test]
    fn a_stranded_session_leaves_only_by_a_restart_somebody_asked_for() {
        for s in [Starting, Working, NeedsYou] {
            assert!(s.can_transition_to(Stranded), "{s:?} -> Stranded");
        }
        // Resting states are left where they are. A session that had already
        // handed back and whose machine then restarted still reads "handed it
        // back", which is true of the work — and stranding every resting
        // session on a machine the moment its worker reconnects would rewrite
        // weeks of finished conversations into an alarm.
        for s in [HandedBack, Ready, Failed, Ended] {
            assert!(!s.can_transition_to(Stranded), "{s:?} -> Stranded");
        }

        assert!(
            Stranded.can_transition_to(Starting),
            "the recovery, which is the one thing anybody can press"
        );
        assert!(
            !Stranded.can_transition_to(Working),
            "a replayed pre-crash event must not put it back to work"
        );
        assert!(!Stranded.can_transition_to(NeedsYou));
        assert!(!Stranded.can_transition_to(HandedBack));
        assert!(!Stranded.can_transition_to(Ready));
    }

    #[test]
    fn transition_reports_what_it_refused() {
        let err = Ended.transition_to(Working).unwrap_err();
        assert_eq!(err.from, Ended);
        assert_eq!(err.to, Working);
    }

    #[test]
    fn in_flight_and_needs_you_are_disjoint() {
        for s in [
            Starting, Working, NeedsYou, HandedBack, Failed, Stranded, Ended,
        ] {
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
            // The one that must never be folded into `Failed`. It is holding
            // a worktree, a branch and edits the agent had already written, so
            // the host and the repository under it cannot be removed.
            SessionStatus::Stranded,
        ] {
            assert!(!still_going.is_finished(), "{still_going:?}");
        }
    }
}
