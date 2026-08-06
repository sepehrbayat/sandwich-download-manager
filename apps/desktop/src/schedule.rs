//! When downloads are allowed to run.
//!
//! The model is one recurring window on the local clock — "download between 02:00 and 07:00",
//! optionally only on some weekdays — plus a cap on how many transfers run at once. That is
//! the shape every mainstream download manager settled on, and it is the one users already
//! know how to reason about.
//!
//! Two decisions are worth stating up front, because both are visible in behaviour:
//!
//! * **The weekday names the day the window *opens*.** A 22:00–06:00 window with Monday
//!   ticked runs Monday night into Tuesday morning. Reading it the other way would mean
//!   ticking Tuesday to download on Monday night, which nobody expects.
//! * **A schedule pause is not a user pause.** When the window closes Sandwich pauses the
//!   queue and *remembers what it paused* (the [`HeldStore`] below). Reopening resumes only
//!   those. Without that bookkeeping, a download the user paused by hand would silently
//!   restart itself at 2am — and one they resumed by hand would be paused again a minute
//!   later, with no way to override the schedule short of turning it off.
//!
//! All the window arithmetic here is pure: it takes the instant to judge as an argument
//! rather than reading the clock, so every boundary can be tested without waiting for 2am.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Upper bound on simultaneous transfers. Past a handful the connections compete for the same
/// pipe and every file slows down together, so the cap is a guard rail, not a preference to
/// max out. aria2's own default is 5.
pub const MAX_CONCURRENT_LIMIT: u32 = 16;
const MINUTES_PER_DAY: u16 = 24 * 60;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Schedule {
    /// Whether the time window restricts downloads at all. The concurrency cap below applies
    /// either way — "how many at once" is a useful setting on its own, and tying it to the
    /// window would mean you could not have one without the other.
    pub enabled: bool,
    /// Minutes since local midnight.
    pub start_minute: u16,
    pub end_minute: u16,
    /// Monday first, matching `Weekday::num_days_from_monday`.
    pub days: [bool; 7],
    pub max_concurrent: u32,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            enabled: false,
            // The overnight window people actually ask for, pre-filled so enabling the feature
            // is one click rather than a form.
            start_minute: 2 * 60,
            end_minute: 7 * 60,
            days: [true; 7],
            max_concurrent: 5,
        }
    }
}

/// Resolves a local wall-clock time to an instant.
///
/// Returns None inside a spring-forward gap, where the wall clock the user wrote down never
/// happens. Callers skip those candidates rather than inventing a time: a 02:30 window edge on
/// the one night 02:30 does not exist is genuinely absent, and the *other* edge still fires.
fn local_instant(naive: NaiveDateTime) -> Option<DateTime<Local>> {
    use chrono::offset::LocalResult;
    match naive.and_local_timezone(Local) {
        LocalResult::Single(instant) => Some(instant),
        // Autumn's repeated hour: the first pass is the one the user meant.
        LocalResult::Ambiguous(earliest, _) => Some(earliest),
        LocalResult::None => None,
    }
}

fn at_minute(date: NaiveDate, minute: u16) -> Option<NaiveDateTime> {
    NaiveTime::from_num_seconds_from_midnight_opt(u32::from(minute) * 60, 0)
        .map(|time| date.and_time(time))
}

impl Schedule {
    /// Clamps stored values into range. A hand-edited settings file is the realistic source of
    /// nonsense here, and a schedule that panics or never opens is worse than one that rounds.
    pub fn normalized(&self) -> Self {
        let mut copy = self.clone();
        copy.start_minute = copy.start_minute.min(MINUTES_PER_DAY - 1);
        copy.end_minute = copy.end_minute.min(MINUTES_PER_DAY - 1);
        copy.max_concurrent = copy.max_concurrent.clamp(1, MAX_CONCURRENT_LIMIT);
        copy
    }

    fn never_opens(&self) -> bool {
        self.days.iter().all(|day| !day)
    }

    fn always_open(&self) -> bool {
        // Equal edges describe a window with no end, which is the whole day.
        self.start_minute == self.end_minute && self.days.iter().all(|day| *day)
    }

    /// Whether transfers may run at the given instant.
    pub fn is_open_at(&self, now: DateTime<Local>) -> bool {
        if !self.enabled {
            return true;
        }
        let schedule = self.normalized();
        let weekday = now.weekday().num_days_from_monday() as usize;
        let minute = now.hour() as u16 * 60 + now.minute() as u16;
        schedule.is_open_on(weekday, minute)
    }

    fn is_open_on(&self, weekday: usize, minute: u16) -> bool {
        if self.never_opens() {
            return false;
        }
        if self.start_minute == self.end_minute {
            return self.days[weekday];
        }
        if self.start_minute < self.end_minute {
            return self.days[weekday] && minute >= self.start_minute && minute < self.end_minute;
        }
        // Crossing midnight: tonight's opening, or the tail of last night's.
        let yesterday = (weekday + 6) % 7;
        (self.days[weekday] && minute >= self.start_minute)
            || (self.days[yesterday] && minute < self.end_minute)
    }

    /// The next instant at which [`Schedule::is_open_at`] flips, if it ever does.
    ///
    /// Openness only changes at a window edge or at midnight (where the weekday changes), so
    /// the candidates are enumerable rather than needing a minute-by-minute scan. Nine days of
    /// lookahead covers the worst case — a single weekday ticked, judged just after it ends.
    pub fn next_change_at(&self, now: DateTime<Local>) -> Option<DateTime<Local>> {
        if !self.enabled {
            return None;
        }
        let schedule = self.normalized();
        if schedule.never_opens() || schedule.always_open() {
            return None;
        }
        let open_now = schedule.is_open_at(now);
        let today = now.date_naive();
        let mut candidates: Vec<DateTime<Local>> = Vec::with_capacity(27);
        for offset in 0..9 {
            let Some(date) = today.checked_add_signed(Duration::days(offset)) else {
                break;
            };
            // Midnight is included because a window that only runs on some days changes state
            // at the day boundary, not at either of its own edges.
            for minute in [0, schedule.start_minute, schedule.end_minute] {
                let Some(naive) = at_minute(date, minute) else {
                    continue;
                };
                if let Some(instant) = local_instant(naive) {
                    if instant > now {
                        candidates.push(instant);
                    }
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        candidates
            .into_iter()
            .find(|candidate| schedule.is_open_at(*candidate) != open_now)
    }
}

#[derive(Default, Serialize, Deserialize)]
struct HeldState {
    /// Paused by the schedule, and therefore ours to resume.
    #[serde(default)]
    held: HashSet<String>,
    /// Started by the user in spite of a closed window. The schedule must leave these alone
    /// until the window next opens, or "resume" would be undone within seconds and the button
    /// would look broken.
    #[serde(default)]
    allowed: HashSet<String>,
}

/// Who paused what, so the schedule can undo its own decisions and nobody else's.
///
/// Persisted for the same reason the history sidecar is: aria2 records that a download is
/// paused but not *why*, so a restart during a closed window would otherwise leave Sandwich
/// unable to tell a scheduled pause from a deliberate one — and the safe reading of an unknown
/// pause is "leave it alone", which would strand the queue permanently.
pub struct HeldStore {
    path: PathBuf,
    state: HeldState,
}

impl HeldStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("scheduled.json");
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, state }
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_string(&self.state) {
            if std::fs::write(&temp, raw).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
    }

    /// Records that the schedule paused this transfer.
    pub fn hold(&mut self, gid: &str) {
        if self.state.held.insert(gid.to_owned()) {
            self.save();
        }
    }

    /// The schedule has resumed it; the hold is discharged.
    pub fn release(&mut self, gid: &str) {
        if self.state.held.remove(gid) {
            self.save();
        }
    }

    pub fn holds(&self, gid: &str) -> bool {
        self.state.held.contains(gid)
    }

    /// The user started this one anyway. Survives a restart deliberately: an override is a
    /// decision about a download, not about a session, and quietly re-pausing it after a
    /// self-update would be indistinguishable from a bug.
    pub fn allow(&mut self, gid: &str) {
        self.state.held.remove(gid);
        if self.state.allowed.insert(gid.to_owned()) {
            self.save();
        }
    }

    pub fn allows(&self, gid: &str) -> bool {
        self.state.allowed.contains(gid)
    }

    /// Drops every claim on a transfer. Used when the user pauses, cancels or retries by hand:
    /// after that the schedule has no opinion left to act on.
    pub fn forget(&mut self, gid: &str) {
        let changed = self.state.held.remove(gid) | self.state.allowed.remove(gid);
        if changed {
            self.save();
        }
    }

    pub fn count(&self) -> usize {
        self.state.held.len()
    }

    /// Called when the window opens. The overrides have served their purpose — the queue is
    /// running for everyone now — and keeping them would exempt those downloads from the *next*
    /// close, which is not what "start this one now" asked for.
    pub fn clear_overrides(&mut self) {
        if !self.state.allowed.is_empty() {
            self.state.allowed.clear();
            self.save();
        }
    }

    /// Forgets transfers the engine no longer knows about, so the file tracks the queue rather
    /// than growing forever.
    pub fn retain_live(&mut self, live: &HashSet<String>) {
        let before = self.state.held.len() + self.state.allowed.len();
        self.state.held.retain(|gid| live.contains(gid));
        self.state.allowed.retain(|gid| live.contains(gid));
        if self.state.held.len() + self.state.allowed.len() != before {
            self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 2026-08-03 is a Monday, which keeps the weekday arithmetic in these tests readable.
    fn at(day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(2026, 8, day, hour, minute, 0)
            .single()
            .expect("test instants avoid DST transitions")
    }

    fn overnight() -> Schedule {
        Schedule {
            enabled: true,
            start_minute: 2 * 60,
            end_minute: 7 * 60,
            days: [true; 7],
            max_concurrent: 5,
        }
    }

    #[test]
    fn a_disabled_schedule_never_closes_the_window() {
        let schedule = Schedule {
            enabled: false,
            ..overnight()
        };
        assert!(schedule.is_open_at(at(3, 13, 0)));
        assert!(schedule.next_change_at(at(3, 13, 0)).is_none());
    }

    #[test]
    fn an_overnight_window_is_open_inside_and_closed_outside() {
        let schedule = overnight();
        assert!(schedule.is_open_at(at(3, 3, 30)));
        assert!(!schedule.is_open_at(at(3, 13, 0)));
        assert!(!schedule.is_open_at(at(3, 23, 59)));
    }

    #[test]
    fn the_window_opens_on_its_start_minute_and_closes_on_its_end_minute() {
        // Half-open by design: 02:00–07:00 twice in a row must not overlap itself at 07:00.
        let schedule = overnight();
        assert!(schedule.is_open_at(at(3, 2, 0)));
        assert!(schedule.is_open_at(at(3, 6, 59)));
        assert!(!schedule.is_open_at(at(3, 7, 0)));
        assert!(!schedule.is_open_at(at(3, 1, 59)));
    }

    #[test]
    fn a_daytime_window_does_not_leak_into_the_night() {
        let schedule = Schedule {
            start_minute: 9 * 60,
            end_minute: 17 * 60,
            ..overnight()
        };
        assert!(schedule.is_open_at(at(3, 12, 0)));
        assert!(!schedule.is_open_at(at(3, 3, 0)));
        assert!(!schedule.is_open_at(at(3, 20, 0)));
    }

    #[test]
    fn a_window_crossing_midnight_belongs_to_the_day_it_opens() {
        // 22:00 Monday to 06:00 Tuesday, with only Monday ticked. Ticking Tuesday to get a
        // Monday-night download is the reading users do not have, so it must not be ours.
        let mut schedule = overnight();
        schedule.start_minute = 22 * 60;
        schedule.end_minute = 6 * 60;
        schedule.days = [true, false, false, false, false, false, false];

        assert!(schedule.is_open_at(at(3, 23, 0)), "Monday night is inside");
        assert!(
            schedule.is_open_at(at(4, 5, 59)),
            "Tuesday dawn is the tail"
        );
        assert!(!schedule.is_open_at(at(4, 6, 0)), "and it ends at 06:00");
        assert!(
            !schedule.is_open_at(at(4, 23, 0)),
            "Tuesday night is not ticked"
        );
    }

    #[test]
    fn an_unticked_day_stays_closed_all_day() {
        let mut schedule = overnight();
        // Weekdays only.
        schedule.days = [true, true, true, true, true, false, false];
        assert!(schedule.is_open_at(at(7, 3, 0)), "Friday is ticked");
        assert!(!schedule.is_open_at(at(8, 3, 0)), "Saturday is not");
        assert!(!schedule.is_open_at(at(9, 3, 0)), "nor Sunday");
    }

    #[test]
    fn no_days_ticked_means_the_window_never_opens() {
        let mut schedule = overnight();
        schedule.days = [false; 7];
        assert!(!schedule.is_open_at(at(3, 3, 0)));
        assert!(!schedule.is_open_at(at(3, 13, 0)));
        // Nothing will ever change, so there is no next change to promise the user.
        assert!(schedule.next_change_at(at(3, 3, 0)).is_none());
    }

    #[test]
    fn equal_edges_mean_all_day_on_the_ticked_days() {
        let mut schedule = overnight();
        schedule.start_minute = 0;
        schedule.end_minute = 0;
        schedule.days = [true, false, false, false, false, false, false];
        assert!(schedule.is_open_at(at(3, 3, 0)));
        assert!(schedule.is_open_at(at(3, 22, 0)));
        assert!(!schedule.is_open_at(at(4, 3, 0)));
        // It closes at Tuesday's midnight, not at either edge.
        assert_eq!(schedule.next_change_at(at(3, 22, 0)), Some(at(4, 0, 0)));
    }

    #[test]
    fn the_next_change_from_inside_is_the_closing_time() {
        assert_eq!(overnight().next_change_at(at(3, 3, 0)), Some(at(3, 7, 0)));
    }

    #[test]
    fn the_next_change_from_outside_is_the_opening_time() {
        // Monday lunchtime: the next opening is Tuesday at 02:00, not today's already-past one.
        assert_eq!(overnight().next_change_at(at(3, 13, 0)), Some(at(4, 2, 0)));
    }

    #[test]
    fn the_next_change_skips_days_that_are_not_ticked() {
        let mut schedule = overnight();
        // Weekends only: Saturday the 8th and Sunday the 9th.
        schedule.days = [false, false, false, false, false, true, true];
        assert_eq!(schedule.next_change_at(at(3, 13, 0)), Some(at(8, 2, 0)));
    }

    #[test]
    fn the_next_change_is_never_in_the_past() {
        let schedule = overnight();
        for hour in 0..24 {
            let now = at(3, hour, 30);
            let next = schedule
                .next_change_at(now)
                .expect("this window always flips");
            assert!(next > now, "next change at {hour}:30 went backwards");
            assert_ne!(
                schedule.is_open_at(next),
                schedule.is_open_at(now),
                "the next change at {hour}:30 did not actually change anything"
            );
        }
    }

    #[test]
    fn nonsense_values_are_clamped_rather_than_trusted() {
        let schedule = Schedule {
            enabled: true,
            start_minute: 9_999,
            end_minute: 5_000,
            days: [true; 7],
            max_concurrent: 500,
        }
        .normalized();
        assert!(schedule.start_minute < MINUTES_PER_DAY);
        assert!(schedule.end_minute < MINUTES_PER_DAY);
        assert_eq!(schedule.max_concurrent, MAX_CONCURRENT_LIMIT);

        let floor = Schedule {
            max_concurrent: 0,
            ..Schedule::default()
        }
        .normalized();
        assert_eq!(floor.max_concurrent, 1, "zero at once is a stopped queue");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sandwich-held-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn held_transfers_survive_a_restart() {
        let dir = scratch("roundtrip");
        let mut store = HeldStore::load(&dir);
        store.hold("g1");
        store.hold("g2");

        // A restart during a closed window must still know which pauses were its own.
        let reloaded = HeldStore::load(&dir);
        assert!(reloaded.holds("g1"));
        assert!(reloaded.holds("g2"));
        assert_eq!(reloaded.count(), 2);
    }

    #[test]
    fn releasing_a_hold_is_permanent() {
        let dir = scratch("release");
        let mut store = HeldStore::load(&dir);
        store.hold("g1");
        store.release("g1");
        assert!(!HeldStore::load(&dir).holds("g1"));
    }

    #[test]
    fn a_user_override_takes_the_transfer_out_of_the_schedules_hands() {
        // Resuming during a closed window has to stick. If the next tick could re-pause it,
        // the button would appear to do nothing.
        let dir = scratch("override");
        let mut store = HeldStore::load(&dir);
        store.hold("g1");
        store.allow("g1");
        assert!(!store.holds("g1"));
        assert!(store.allows("g1"));

        let reloaded = HeldStore::load(&dir);
        assert!(reloaded.allows("g1"), "an override outlives a restart");
    }

    #[test]
    fn overrides_expire_when_the_window_next_opens() {
        let dir = scratch("clear-overrides");
        let mut store = HeldStore::load(&dir);
        store.allow("g1");
        store.clear_overrides();
        assert!(
            !store.allows("g1"),
            "'start this one now' must not exempt it from every future close"
        );
    }

    #[test]
    fn acting_by_hand_drops_every_claim() {
        let dir = scratch("forget");
        let mut store = HeldStore::load(&dir);
        store.hold("g1");
        store.allow("g2");
        store.forget("g1");
        store.forget("g2");
        assert!(!store.holds("g1"));
        assert!(!store.allows("g2"));
    }

    #[test]
    fn a_corrupt_file_is_an_empty_store() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join("scheduled.json"), "{ not json").unwrap();
        assert!(!HeldStore::load(&dir).holds("anything"));
    }

    #[test]
    fn holds_are_dropped_for_transfers_the_engine_forgot() {
        let dir = scratch("retain");
        let mut store = HeldStore::load(&dir);
        store.hold("keep");
        store.hold("gone");
        store.allow("allowed-gone");
        store.retain_live(&HashSet::from(["keep".to_owned()]));
        assert!(store.holds("keep"));
        assert!(!store.holds("gone"));
        assert!(!store.allows("allowed-gone"));
    }
}
