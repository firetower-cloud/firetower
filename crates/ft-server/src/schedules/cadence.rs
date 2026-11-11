//! The clock arithmetic: a cadence, the expression it compiles to, and when it
//! next wants a run.
//!
//! **One cron implementation in the product.** No client parses an
//! expression — the server compiles the cadence, writes the plain-English
//! read-back and computes the next three fire times, and the row renders what
//! it is told. Two implementations would disagree about daylight saving in
//! March, and the one on the client would be the one nobody tested.
//!
//! A named zone throughout, never an offset. "07:00, Europe/Paris" is a
//! wall-clock instruction, and an offset is wrong twice a year.

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use ft_core::schedule::{Cadence, MonthlyOn, Weekday};
use std::str::FromStr;

/// The closest two runs of one schedule may be.
///
/// `* * * * *` is otherwise one agent a minute on one machine, each cutting a
/// worktree and running a repository's setup script, and nothing else in the
/// product would stop it. A constant and a validator rather than a column: a
/// per-schedule floor is a thing somebody would raise for themselves, which
/// is not a floor.
///
/// It wants to move in step with the five-minute fence on a stale claim in
/// [`super::ORPHAN_AFTER`] if either ever moves.
pub const MIN_INTERVAL: chrono::TimeDelta = chrono::TimeDelta::minutes(15);

/// How many occurrences to step over when advancing a clock across a gap.
///
/// Nothing is ever run late, so this is not a catch-up window — the work did
/// not go away with catch-up, it stopped having anything to show for itself.
/// What is left is that `next_fire_at` still has to be moved from where it was
/// to now, and that is a loop over occurrences: a fifteen-minute schedule left
/// alone for a year is thirty-five thousand of them. Above the cap, the clock
/// jumps straight to the next future occurrence and one row names the period
/// instead.
pub const ADVANCE_CAP: usize = 1000;

/// How many occurrences to inspect when checking the floor.
///
/// Enough to see the shortest gap a pattern repeats on. `0,5 * * * *` has a
/// five-minute gap and a fifty-five-minute one, so a check that looked at one
/// interval would pass it.
const FLOOR_SAMPLE: usize = 24;

/// A compiled cadence, in its own zone.
pub struct Clock {
    cron: Cron,
    tz: Tz,
    expr: String,
}

/// Why a cadence was refused, in the words the form shows.
#[derive(Debug)]
pub struct Refused(pub String);

impl Clock {
    /// Compile a cadence, or say why not.
    ///
    /// The floor is checked here rather than at the handler, so every way in —
    /// the form, the API, an agent's proposal — is refused by the same code
    /// with the same sentence.
    pub fn of(cadence: &Cadence, timezone: &str) -> Result<Self, Refused> {
        let tz: Tz = timezone.parse().map_err(|_| {
            Refused(format!(
                "{timezone} is not a time zone Firetower knows. Use an IANA name, like \
                 Europe/Paris."
            ))
        })?;
        let expr = expression(cadence)?;
        let cron = Cron::from_str(&expr).map_err(|e| match cadence {
            // Their own words back, because the thing to correct is the thing
            // they typed. A generated expression failing here is ours.
            Cadence::Custom { expr } => Refused(format!("{expr} is not a cron expression: {e}")),
            _ => Refused(format!("that cadence does not make a schedule: {e}")),
        })?;

        let clock = Self { cron, tz, expr };
        clock.not_too_often()?;
        Ok(clock)
    }

    /// The fifteen-minute floor, measured rather than pattern-matched.
    ///
    /// Asking the compiled pattern when it would actually fire catches every
    /// way of writing it too often — `*/5`, `0,5,10`, a list of minutes — where
    /// a check against the text would catch the first and miss the others.
    fn not_too_often(&self) -> Result<(), Refused> {
        let fires = self.next_fires(Utc::now(), FLOOR_SAMPLE);
        let closest = fires
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .min()
            .unwrap_or(MIN_INTERVAL);
        if closest >= MIN_INTERVAL {
            return Ok(());
        }
        // The cost, not just the rule: a person who wrote `*/5` was thinking
        // about how often they want it, and the sentence has to be about that.
        let every = match closest.num_minutes() {
            0 => "less than a minute".to_string(),
            1 => "1 minute".to_string(),
            n => format!("{n} minutes"),
        };
        Err(Refused(format!(
            "Runs cannot be closer together than 15 minutes. This one would start a run every \
             {every}. Each run cuts a new worktree and runs the repository's setup script, so a \
             schedule this frequent fills a machine rather than keeping up with it."
        )))
    }

    /// The compiled expression, for somebody who wants to see it.
    pub fn expr(&self) -> &str {
        &self.expr
    }

    /// What it means, in words.
    pub fn reads(&self) -> String {
        self.cron.describe()
    }

    /// The next `n` occurrences strictly after `after`.
    pub fn next_fires(&self, after: DateTime<Utc>, n: usize) -> Vec<DateTime<Utc>> {
        self.cron
            .iter_after(after.with_timezone(&self.tz))
            .take(n)
            .map(|at| at.with_timezone(&Utc))
            .collect()
    }

    /// The next occurrence strictly after `after`.
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.next_fires(after, 1).into_iter().next()
    }

    /// The last occurrence strictly before `before`.
    ///
    /// What a trigger's `next_fire_at` held a moment ago, for anything that has
    /// to reason about an occurrence that has just passed.
    pub fn previous_before(&self, before: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.cron
            .iter_before(before.with_timezone(&self.tz))
            .next()
            .map(|at| at.with_timezone(&Utc))
    }

    /// Every occurrence in `(after, until]`, and where the clock lands.
    ///
    /// The second element is the next occurrence after `until`, which is what
    /// `next_fire_at` becomes. `true` means the cap was reached and the
    /// occurrences returned are not all of them — the caller writes one row
    /// naming the period rather than one per occurrence.
    pub fn between(
        &self,
        after: DateTime<Utc>,
        until: DateTime<Utc>,
    ) -> (Vec<DateTime<Utc>>, Option<DateTime<Utc>>, bool) {
        let mut passed = Vec::new();
        let mut cursor = after;
        let mut capped = false;
        loop {
            let Some(next) = self.next_after(cursor) else {
                return (passed, None, capped);
            };
            if next > until {
                return (passed, Some(next), capped);
            }
            if passed.len() >= ADVANCE_CAP {
                capped = true;
                // Straight to the first occurrence after the gap. Asking for
                // the next one after `until` rather than walking the rest.
                return (passed, self.next_after(until), capped);
            }
            passed.push(next);
            cursor = next;
        }
    }

    /// What the local wall clock reads for an instant, for a row that has to
    /// say "01:00 your time".
    pub fn local(&self, at: DateTime<Utc>) -> DateTime<Tz> {
        self.tz.from_utc_datetime(&at.naive_utc())
    }
}

/// A cadence as a five-field cron expression.
///
/// Five fields, which is the form everybody writes and the form the custom
/// control accepts. The generated ones are deliberately the plainest
/// expression that says the thing, so somebody reading the stored row
/// recognises it.
fn expression(cadence: &Cadence) -> Result<String, Refused> {
    let (h, m) = match cadence {
        Cadence::Daily { at }
        | Cadence::Weekdays { at }
        | Cadence::Weekly { at, .. }
        | Cadence::Monthly { at, .. } => time_of_day(at)?,
        Cadence::Custom { expr } => {
            let expr = expr.trim();
            if expr.is_empty() {
                return Err(Refused("a custom cadence needs a cron expression".into()));
            }
            return Ok(expr.to_string());
        }
    };
    Ok(match cadence {
        Cadence::Daily { .. } => format!("{m} {h} * * *"),
        Cadence::Weekdays { .. } => format!("{m} {h} * * 1-5"),
        Cadence::Weekly { day, .. } => format!("{m} {h} * * {}", day.cron()),
        Cadence::Monthly {
            on: MonthlyOn::Day { day },
            ..
        } => {
            if !(1..=31).contains(day) {
                return Err(Refused(format!("there is no {day}th of the month")));
            }
            format!("{m} {h} {day} * *")
        }
        // `MON#1` — croner's nth-weekday form, which is how "the first Monday"
        // is said at all. A day-of-month range anded with a weekday is not it:
        // cron ors those two fields, so `1-7 * 1` means "the first week *or*
        // any Monday", which is every Monday.
        Cadence::Monthly {
            on: MonthlyOn::Nth { nth, day },
            ..
        } => {
            if !(1..=5).contains(nth) {
                return Err(Refused(format!(
                    "a month has no {nth}th of any weekday worth scheduling"
                )));
            }
            format!("{m} {h} * * {}#{nth}", weekday_name(*day))
        }
        Cadence::Custom { .. } => unreachable!("returned above"),
    })
}

fn weekday_name(day: Weekday) -> &'static str {
    match day {
        Weekday::Monday => "MON",
        Weekday::Tuesday => "TUE",
        Weekday::Wednesday => "WED",
        Weekday::Thursday => "THU",
        Weekday::Friday => "FRI",
        Weekday::Saturday => "SAT",
        Weekday::Sunday => "SUN",
    }
}

/// `HH:MM`, as the control sends it.
fn time_of_day(at: &str) -> Result<(u32, u32), Refused> {
    let bad = || Refused(format!("{at} is not a time of day. Use HH:MM, like 07:00."));
    let (h, m) = at.trim().split_once(':').ok_or_else(bad)?;
    let h: u32 = h.trim().parse().map_err(|_| bad())?;
    let m: u32 = m.trim().parse().map_err(|_| bad())?;
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok((h, m))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn clock(cadence: Cadence) -> Clock {
        Clock::of(&cadence, "Europe/Paris").expect("a cadence the form can produce")
    }

    #[test]
    fn the_five_cadences_compile_to_the_plainest_expression_that_says_it() {
        assert_eq!(
            clock(Cadence::Daily { at: "09:00".into() }).expr(),
            "0 9 * * *"
        );
        assert_eq!(
            clock(Cadence::Weekdays { at: "08:30".into() }).expr(),
            "30 8 * * 1-5"
        );
        assert_eq!(
            clock(Cadence::Weekly {
                at: "07:00".into(),
                day: Weekday::Monday
            })
            .expr(),
            "0 7 * * 1"
        );
        assert_eq!(
            clock(Cadence::Monthly {
                at: "09:00".into(),
                on: MonthlyOn::Day { day: 1 }
            })
            .expr(),
            "0 9 1 * *"
        );
        assert_eq!(
            clock(Cadence::Custom {
                expr: " 0 7 * * 1-5 ".into()
            })
            .expr(),
            "0 7 * * 1-5"
        );
    }

    /// **The first Monday is a weekday-of-month, not a date range.**
    ///
    /// Cron *ors* day-of-month against day-of-week, so `0 9 1-7 * 1` is "the
    /// first week of the month, or any Monday" — which is every Monday. It is
    /// the obvious expression and it is wrong, which is why the nth form is
    /// used instead.
    #[test]
    fn the_first_monday_of_the_month_is_one_day_a_month() {
        let c = clock(Cadence::Monthly {
            at: "09:00".into(),
            on: MonthlyOn::Nth {
                nth: 1,
                day: Weekday::Monday,
            },
        });
        assert_eq!(c.expr(), "0 9 * * MON#1");

        let fires = c.next_fires(at(2026, 11, 11, 10, 0), 3);
        let days: Vec<String> = fires
            .iter()
            .map(|f| c.local(*f).format("%Y-%m-%d %H:%M").to_string())
            .collect();
        assert_eq!(
            days,
            vec![
                "2026-12-07 09:00".to_string(),
                "2027-01-04 09:00".to_string(),
                "2027-02-01 09:00".to_string(),
            ],
            "one a month, each the first Monday"
        );
    }

    /// Criterion 12, on the write path rather than on the form.
    #[test]
    fn a_cadence_more_often_than_every_fifteen_minutes_is_refused() {
        for expr in ["*/5 * * * *", "* * * * *", "0,5,10 * * * *", "*/14 * * * *"] {
            let refused = Clock::of(
                &Cadence::Custom {
                    expr: expr.to_string(),
                },
                "Europe/Paris",
            )
            .err()
            .unwrap_or_else(|| panic!("{expr} fires too often to allow"));
            assert!(
                refused.0.contains("closer together than 15 minutes"),
                "{expr}: {}",
                refused.0
            );
            assert!(
                refused.0.contains("setup script"),
                "the refusal says what it would cost: {}",
                refused.0
            );
        }
    }

    /// Exactly fifteen is allowed. A floor refuses what is below it.
    #[test]
    fn every_fifteen_minutes_is_the_closest_allowed() {
        assert!(Clock::of(
            &Cadence::Custom {
                expr: "*/15 * * * *".into()
            },
            "Europe/Paris"
        )
        .is_ok());
        assert!(Clock::of(
            &Cadence::Custom {
                expr: "0,30 * * * *".into()
            },
            "Europe/Paris"
        )
        .is_ok());
    }

    #[test]
    fn a_zone_that_is_not_a_zone_is_refused_by_name() {
        let refused = Clock::of(&Cadence::Daily { at: "09:00".into() }, "Mars/Olympus")
            .err()
            .expect("there is no such zone");
        assert!(refused.0.contains("Mars/Olympus"));
        assert!(refused.0.contains("IANA"));
    }

    #[test]
    fn a_time_of_day_that_is_not_one_says_the_shape_it_wants() {
        for bad in ["9am", "25:00", "09:60", "nine", ""] {
            let refused = Clock::of(
                &Cadence::Daily {
                    at: bad.to_string(),
                },
                "Europe/Paris",
            )
            .err()
            .unwrap_or_else(|| panic!("{bad} is not a time of day"));
            assert!(refused.0.contains("HH:MM"), "{bad}: {}", refused.0);
        }
    }

    /// **The read-back, which is the server's to write.**
    ///
    /// Asserted loosely — the exact phrasing belongs to the library, and
    /// pinning it here would make a dependency bump a test failure for no
    /// reason. What matters is that there is a sentence and that it carries the
    /// time and the days.
    #[test]
    fn a_cadence_reads_back_in_words() {
        let reads = clock(Cadence::Weekdays { at: "07:00".into() }).reads();
        assert!(reads.contains("07:00"), "{reads}");
        assert!(reads.contains("Monday") && reads.contains("Friday"), "{reads}");
    }

    /// The wall clock is kept, not the offset. Paris is +01:00 in January and
    /// +02:00 in July, and 07:00 local is the instruction either way.
    #[test]
    fn a_schedule_keeps_its_wall_clock_through_daylight_saving() {
        let c = clock(Cadence::Daily { at: "07:00".into() });
        let winter = c.next_after(at(2026, 1, 10, 12, 0)).unwrap();
        let summer = c.next_after(at(2026, 7, 10, 12, 0)).unwrap();
        assert_eq!(c.local(winter).format("%H:%M").to_string(), "07:00");
        assert_eq!(c.local(summer).format("%H:%M").to_string(), "07:00");
        // And the instants differ by the hour the offset moved.
        assert_eq!(winter.format("%H:%M").to_string(), "06:00");
        assert_eq!(summer.format("%H:%M").to_string(), "05:00");
    }

    /// Criterion 24: a long gap produces one row, not one per occurrence.
    #[test]
    fn a_gap_longer_than_the_cap_stops_counting_and_jumps_the_clock() {
        let c = clock(Cadence::Custom {
            expr: "*/15 * * * *".into(),
        });
        let from = at(2025, 1, 1, 0, 0);
        let until = at(2026, 1, 1, 0, 0);
        let (passed, next, capped) = c.between(from, until);

        assert!(capped, "a year of quarter-hours is past the cap");
        assert_eq!(passed.len(), ADVANCE_CAP);
        let next = next.expect("the clock still lands somewhere");
        assert!(next > until, "and it lands after the gap, not inside it");
    }

    /// The ordinary case: a handful of occurrences passed, every one of them
    /// named, and the clock lands on the next.
    #[test]
    fn a_short_gap_names_every_occurrence_it_passed() {
        let c = clock(Cadence::Daily { at: "07:00".into() });
        let (passed, next, capped) = c.between(at(2026, 11, 8, 12, 0), at(2026, 11, 11, 12, 0));
        assert!(!capped);
        assert_eq!(passed.len(), 3, "the 9th, 10th and 11th");
        assert_eq!(next, Some(at(2026, 11, 12, 6, 0)));
    }
}
