//! Downloads that belong together.
//!
//! A game shipped as fifty 2 GB parts is one thing to the person waiting for it and fifty
//! things to the engine. This module owns the difference: a **batch** is a Sandwich-side
//! grouping of transfers aria2 knows nothing about, persisted in the same sidecar style as the
//! history and schedule stores.
//!
//! Two problems have to be solved separately, and conflating them is what makes other download
//! managers awkward here:
//!
//! * **Getting the links in.** Fifty copy-pastes, or one pattern. [`expand_pattern`] turns
//!   `part[01-50].bin` into fifty URLs, taking the zero-padding width from the pattern itself
//!   rather than asking for it in a separate field.
//! * **Managing them afterwards.** Without a group, fifty cards means fifty pauses to stop one
//!   download. [`BatchStore`] is what lets one card stand for the set.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many URLs one pattern may expand to.
///
/// A guard rail against a typo, not a judgement about real batches: `[1-99999]` is far more
/// likely to be a slip than an intention, and queueing it would take the app away from the user
/// for as long as it took aria2 to accept them all.
pub const MAX_EXPANSION: usize = 500;

/// How many links one submission may carry, pattern-expanded or pasted.
pub const MAX_BATCH_LINKS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "detail")]
pub enum PatternError {
    /// `[50-01]`. Counting down is never what was meant, and silently sorting it would hide a
    /// typo in the one place the user is least able to see it — the generated list.
    Reversed,
    /// More than [`MAX_EXPANSION`] URLs.
    TooMany(usize),
    /// Two ranges multiply rather than pair, so `a[1-9]b[1-9]` is 81 URLs and almost certainly
    /// not what was intended. Refusing is kinder than guessing which reading was meant.
    MultipleRanges,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Reversed => write!(f, "the range counts backwards — write it as [01-50]"),
            Self::TooMany(count) => write!(
                f,
                "that pattern makes {count} links; {MAX_EXPANSION} is the most in one go"
            ),
            Self::MultipleRanges => {
                write!(f, "only one [1-9] range per address")
            }
        }
    }
}

struct Found {
    at: std::ops::Range<usize>,
    from: u64,
    to: u64,
    width: usize,
}

/// Locates every `[digits-digits]` in the input.
///
/// Deliberately strict about what counts: an IPv6 host is written `http://[::1]/file`, and a
/// looser match would treat that as a range and mangle a perfectly good address.
fn find_ranges(input: &str) -> Vec<Found> {
    let bytes = input.as_bytes();
    let mut found = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'[' {
            index += 1;
            continue;
        }
        let Some(close) = bytes[index..].iter().position(|byte| *byte == b']') else {
            break;
        };
        let close = index + close;
        let inside = &input[index + 1..close];
        if let Some((start, end)) = inside.split_once('-') {
            let numeric = |value: &str| {
                !value.is_empty()
                    && value.len() <= 18
                    && value.bytes().all(|byte| byte.is_ascii_digit())
            };
            if numeric(start) && numeric(end) {
                if let (Ok(from), Ok(to)) = (start.parse::<u64>(), end.parse::<u64>()) {
                    found.push(Found {
                        at: index..close + 1,
                        from,
                        to,
                        // The pattern states its own padding: [01-50] is two digits wide,
                        // [1-50] is not padded. One field instead of the two every other
                        // download manager asks for.
                        width: start.len(),
                    });
                }
            }
        }
        index = close + 1;
    }
    found
}

/// Expands one address that may contain a `[01-50]` range into the addresses it stands for.
///
/// An address with no range expands to itself, so callers can run every line through this
/// without first asking whether it is a pattern.
pub fn expand_pattern(input: &str) -> Result<Vec<String>, PatternError> {
    let trimmed = input.trim();
    let ranges = find_ranges(trimmed);
    match ranges.len() {
        0 => return Ok(vec![trimmed.to_owned()]),
        1 => {}
        _ => return Err(PatternError::MultipleRanges),
    }
    let range = &ranges[0];
    if range.from > range.to {
        return Err(PatternError::Reversed);
    }
    let count = (range.to - range.from + 1) as usize;
    if count > MAX_EXPANSION {
        return Err(PatternError::TooMany(count));
    }
    let (before, after) = (&trimmed[..range.at.start], &trimmed[range.at.end..]);
    Ok((range.from..=range.to)
        .map(|value| format!("{before}{value:0width$}{after}", width = range.width))
        .collect())
}

/// Splits pasted text into candidate addresses.
///
/// Whitespace rather than newlines: a URL cannot contain an unescaped space, and text copied
/// out of a page arrives with every kind of separator in it.
pub fn split_links(input: &str) -> Vec<String> {
    input
        .split_whitespace()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Removes repeats while keeping the order the user pasted, and reports how many went.
///
/// Order matters: parts are pasted in sequence, and re-sorting them would make the queue
/// disagree with the list the user is checking against.
pub fn dedupe(links: Vec<String>) -> (Vec<String>, usize) {
    let mut seen = HashSet::new();
    let before = links.len();
    let unique: Vec<String> = links
        .into_iter()
        .filter(|link| seen.insert(link.clone()))
        .collect();
    let dropped = before - unique.len();
    (unique, dropped)
}

/// A name for the batch, taken from what the filenames have in common.
///
/// `Cyberpunk.part01.rar` … `Cyberpunk.part50.rar` becomes "Cyberpunk". Falling back to the
/// first filename is better than a generic label: a queue with three batches all called
/// "Batch" is no better than the fifty loose cards this replaces.
pub fn derive_name(filenames: &[String]) -> String {
    let Some(first) = filenames.first() else {
        return "Batch".to_owned();
    };
    let stem = || {
        Path::new(first)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("Batch")
            .to_owned()
    };
    // One file shares its prefix with nothing, so the prefix is the whole name — extension and
    // all. Its stem is the useful answer.
    if filenames.len() == 1 {
        return stem();
    }
    let mut common = first.as_str();
    for name in filenames.iter().skip(1) {
        let shared = common
            .char_indices()
            .zip(name.chars())
            .take_while(|((_, a), b)| a == b)
            .map(|((index, a), _)| index + a.len_utf8())
            .last()
            .unwrap_or(0);
        common = &common[..shared];
    }
    let trimmed = trim_sequence(common);
    if trimmed.chars().count() >= 2 {
        return trimmed.to_owned();
    }
    stem()
}

/// Strips what a numbered sequence leaves stuck to the end of a shared prefix.
///
/// `Cyberpunk.part01.rar` and its siblings share `Cyberpunk.part0` — the separator, the word
/// and the leading digit of the number all survive the common-prefix scan, and none of them are
/// part of the name a person would give the batch.
fn trim_sequence(value: &str) -> &str {
    let filler =
        |c: char| c.is_ascii_digit() || matches!(c, '.' | '-' | '_' | ' ' | '(' | '[' | '#');
    let mut out = value.trim_end_matches(filler);
    // Conservative list: each is a word that only ever precedes a number in a filename. A
    // longer list would start eating real names.
    for word in ["part", "disc", "disk", "volume", "vol", "cd"] {
        let Some(head) = out.len().checked_sub(word.len()) else {
            continue;
        };
        if !out.is_char_boundary(head) || !out[head..].eq_ignore_ascii_case(word) {
            continue;
        }
        let without = out[..head].trim_end_matches(filler);
        // Only if something is left. When the shared prefix *is* the word — every file called
        // disc-1, disc-2 — then "disc" is the best name available, not an empty string.
        if without.chars().count() >= 2 {
            out = without;
        }
        break;
    }
    out
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Batch {
    pub id: String,
    pub name: String,
    /// Members, in the order they were queued. Preserved so the expanded card lists part 1
    /// before part 2 regardless of which finishes first.
    pub gids: Vec<String>,
    pub created_at: u64,
}

/// Which transfers belong to which batch.
///
/// aria2 has no concept of a group, so this is the only place the relationship exists. Losing
/// the file costs the grouping and nothing else — the downloads themselves are the engine's,
/// and they carry on — so a corrupt or missing store is an empty one, never an error.
pub struct BatchStore {
    path: PathBuf,
    batches: Vec<Batch>,
}

impl BatchStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("batches.json");
        let batches = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, batches }
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_string(&self.batches) {
            if std::fs::write(&temp, raw).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
    }

    pub fn create(&mut self, name: &str, gids: Vec<String>) -> Batch {
        // Seconds are enough to order batches but not to distinguish two made in the same one,
        // so the id is only settled once it is known to be free.
        let stamp = now();
        let mut id = format!("batch-{stamp}");
        let mut suffix = 1;
        while self.batches.iter().any(|batch| batch.id == id) {
            id = format!("batch-{stamp}-{suffix}");
            suffix += 1;
        }
        let batch = Batch {
            id,
            name: name.to_owned(),
            gids,
            created_at: stamp,
        };
        self.batches.push(batch.clone());
        self.save();
        batch
    }

    pub fn batch_of(&self, gid: &str) -> Option<&Batch> {
        self.batches
            .iter()
            .find(|batch| batch.gids.iter().any(|member| member == gid))
    }

    pub fn get(&self, id: &str) -> Option<&Batch> {
        self.batches.iter().find(|batch| batch.id == id)
    }

    /// Swaps a member for its replacement, keeping its position.
    ///
    /// A retry is a new transfer with a new id. Without this the retried part would fall out of
    /// its batch and reappear as a loose card, which is exactly the mess batches exist to avoid.
    pub fn replace_gid(&mut self, old: &str, new: &str) {
        let mut changed = false;
        for batch in &mut self.batches {
            if let Some(slot) = batch.gids.iter_mut().find(|gid| *gid == old) {
                *slot = new.to_owned();
                changed = true;
            }
        }
        if changed {
            self.save();
        }
    }

    /// Drops the named members, and the batch itself once nothing is left in it.
    ///
    /// Returns the members that remain. A cancel that only half succeeded must leave the batch
    /// holding the survivors: forgetting it wholesale would leave a transfer still running with
    /// nothing recording that it belongs to anything.
    pub fn remove_members(&mut self, id: &str, gone: &HashSet<String>) -> Vec<String> {
        let Some(batch) = self.batches.iter_mut().find(|batch| batch.id == id) else {
            return Vec::new();
        };
        batch.gids.retain(|gid| !gone.contains(gid));
        let remaining = batch.gids.clone();
        if remaining.is_empty() {
            self.batches.retain(|batch| batch.id != id);
        }
        self.save();
        remaining
    }

    /// Drops members the engine no longer knows, and any batch left with none.
    pub fn retain_live(&mut self, live: &HashSet<String>) {
        let before = serde_json::to_string(&self.batches).unwrap_or_default();
        for batch in &mut self.batches {
            batch.gids.retain(|gid| live.contains(gid));
        }
        self.batches.retain(|batch| !batch.gids.is_empty());
        if serde_json::to_string(&self.batches).unwrap_or_default() != before {
            self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ── Pattern expansion ───────────────────────────────────────────────── */

    #[test]
    fn an_address_without_a_range_expands_to_itself() {
        assert_eq!(
            expand_pattern("https://example.com/game.iso").unwrap(),
            vec!["https://example.com/game.iso"]
        );
    }

    #[test]
    fn a_padded_range_keeps_its_width() {
        // The whole point of taking the width from the pattern: [01-03] is what the server has,
        // and asking for the digit count in a separate field is how IDM does it.
        let links = expand_pattern("https://example.com/part[01-03].bin").unwrap();
        assert_eq!(
            links,
            vec![
                "https://example.com/part01.bin",
                "https://example.com/part02.bin",
                "https://example.com/part03.bin",
            ]
        );
    }

    #[test]
    fn an_unpadded_range_stays_unpadded() {
        let links = expand_pattern("https://example.com/f[8-11].bin").unwrap();
        assert_eq!(links.first().unwrap(), "https://example.com/f8.bin");
        assert_eq!(links.last().unwrap(), "https://example.com/f11.bin");
        assert_eq!(links.len(), 4);
    }

    #[test]
    fn padding_survives_the_width_being_exceeded() {
        // [08-11] is two wide, and 11 is already two digits. Nothing should be truncated.
        let links = expand_pattern("https://example.com/f[08-11].bin").unwrap();
        assert_eq!(links.first().unwrap(), "https://example.com/f08.bin");
        assert_eq!(links.last().unwrap(), "https://example.com/f11.bin");
    }

    #[test]
    fn a_fifty_part_game_is_one_line() {
        let links = expand_pattern("https://cdn.example.com/game.part[01-50].rar").unwrap();
        assert_eq!(links.len(), 50);
        assert_eq!(
            links.last().unwrap(),
            "https://cdn.example.com/game.part50.rar"
        );
    }

    #[test]
    fn a_backwards_range_is_refused_rather_than_sorted() {
        assert_eq!(
            expand_pattern("https://example.com/f[50-01].bin"),
            Err(PatternError::Reversed)
        );
    }

    #[test]
    fn an_absurd_range_is_refused() {
        let error = expand_pattern("https://example.com/f[1-99999].bin").unwrap_err();
        assert!(matches!(error, PatternError::TooMany(99_999)));
        // The boundary itself is allowed.
        assert_eq!(
            expand_pattern(&format!("https://example.com/f[1-{MAX_EXPANSION}].bin"))
                .unwrap()
                .len(),
            MAX_EXPANSION
        );
    }

    #[test]
    fn two_ranges_are_refused_rather_than_multiplied() {
        assert_eq!(
            expand_pattern("https://example.com/[1-9]/part[1-9].bin"),
            Err(PatternError::MultipleRanges)
        );
    }

    #[test]
    fn an_ipv6_host_is_not_mistaken_for_a_range() {
        // http://[::1]/file is a legal address. A looser match would eat the host.
        let input = "http://[::1]:8080/game.iso";
        assert_eq!(expand_pattern(input).unwrap(), vec![input]);
    }

    #[test]
    fn brackets_that_are_not_ranges_are_left_alone() {
        for input in [
            "https://example.com/a[b-c].bin",
            "https://example.com/a[-1].bin",
            "https://example.com/a[1-].bin",
            "https://example.com/a[1_2].bin",
        ] {
            assert_eq!(expand_pattern(input).unwrap(), vec![input], "{input}");
        }
    }

    /* ── Reading a paste ─────────────────────────────────────────────────── */

    #[test]
    fn a_paste_splits_on_every_kind_of_whitespace() {
        let links =
            split_links("  https://a.com/1.bin\nhttps://a.com/2.bin\r\n\thttps://a.com/3.bin  ");
        assert_eq!(links.len(), 3);
        assert_eq!(links[0], "https://a.com/1.bin");
        assert_eq!(links[2], "https://a.com/3.bin");
    }

    #[test]
    fn repeats_are_dropped_without_reordering_the_rest() {
        let (links, dropped) = dedupe(vec![
            "https://a.com/2.bin".into(),
            "https://a.com/1.bin".into(),
            "https://a.com/2.bin".into(),
        ]);
        assert_eq!(dropped, 1);
        // Paste order is the order the parts go in; sorting would make the queue disagree with
        // the list the user is checking against.
        assert_eq!(links, vec!["https://a.com/2.bin", "https://a.com/1.bin"]);
    }

    /* ── Naming ──────────────────────────────────────────────────────────── */

    #[test]
    fn a_batch_is_named_after_what_its_parts_share() {
        let names: Vec<String> = (1..=3)
            .map(|index| format!("Cyberpunk.part{index:02}.rar"))
            .collect();
        assert_eq!(derive_name(&names), "Cyberpunk");
    }

    #[test]
    fn the_separator_and_sequence_are_trimmed_off_the_name() {
        assert_eq!(
            derive_name(&["game_01.bin".into(), "game_02.bin".into()]),
            "game"
        );
        assert_eq!(
            derive_name(&["disc-1.iso".into(), "disc-2.iso".into()]),
            "disc"
        );
    }

    #[test]
    fn unrelated_files_are_named_after_the_first_rather_than_something_generic() {
        let name = derive_name(&["holiday.mp4".into(), "invoice.pdf".into()]);
        assert_eq!(
            name, "holiday",
            "a generic label helps nobody with two batches"
        );
    }

    #[test]
    fn a_single_file_keeps_its_own_name() {
        assert_eq!(derive_name(&["ubuntu-24.04.iso".into()]), "ubuntu-24.04");
        assert_eq!(derive_name(&[]), "Batch");
    }

    /* ── The store ───────────────────────────────────────────────────────── */

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sandwich-batch-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_batch_survives_a_restart() {
        let dir = scratch("roundtrip");
        let mut store = BatchStore::load(&dir);
        let batch = store.create("Cyberpunk", vec!["g1".into(), "g2".into()]);

        let reloaded = BatchStore::load(&dir);
        assert_eq!(reloaded.get(&batch.id).unwrap().name, "Cyberpunk");
        assert_eq!(reloaded.batch_of("g2").unwrap().id, batch.id);
        assert!(reloaded.batch_of("nobody").is_none());
    }

    #[test]
    fn two_batches_made_in_the_same_second_still_get_their_own_ids() {
        let dir = scratch("ids");
        let mut store = BatchStore::load(&dir);
        let one = store.create("a", vec!["g1".into()]);
        let two = store.create("b", vec!["g2".into()]);
        assert_ne!(one.id, two.id);
    }

    #[test]
    fn a_retried_part_stays_in_its_batch() {
        // A retry is a new transfer with a new gid. Without the swap it would fall out of the
        // group and reappear as a loose card.
        let dir = scratch("replace");
        let mut store = BatchStore::load(&dir);
        let batch = store.create("game", vec!["g1".into(), "g2".into()]);
        store.replace_gid("g1", "g9");

        let reloaded = BatchStore::load(&dir);
        let members = &reloaded.get(&batch.id).unwrap().gids;
        assert_eq!(members, &vec!["g9".to_owned(), "g2".to_owned()]);
        assert_eq!(reloaded.batch_of("g9").unwrap().id, batch.id);
    }

    #[test]
    fn a_half_successful_cancel_leaves_the_batch_holding_the_survivors() {
        // If one cancel fails, that transfer carries on. Forgetting the whole batch would leave
        // it running with nothing recording what it belongs to.
        let dir = scratch("remove-members");
        let mut store = BatchStore::load(&dir);
        let batch = store.create("game", vec!["g1".into(), "g2".into(), "g3".into()]);

        let remaining = store.remove_members(&batch.id, &HashSet::from(["g1".to_owned()]));
        assert_eq!(remaining, vec!["g2".to_owned(), "g3".to_owned()]);
        assert!(store.batch_of("g2").is_some());
        assert!(store.batch_of("g1").is_none());

        // Only once the last one goes does the batch go with it.
        let empty = store.remove_members(
            &batch.id,
            &HashSet::from(["g2".to_owned(), "g3".to_owned()]),
        );
        assert!(empty.is_empty());
        assert!(store.get(&batch.id).is_none());
    }

    #[test]
    fn a_batch_whose_members_are_all_gone_goes_with_them() {
        let dir = scratch("retain");
        let mut store = BatchStore::load(&dir);
        let kept = store.create("kept", vec!["g1".into(), "g2".into()]);
        let gone = store.create("gone", vec!["g3".into()]);

        store.retain_live(&HashSet::from(["g1".to_owned()]));
        assert_eq!(store.get(&kept.id).unwrap().gids, vec!["g1".to_owned()]);
        assert!(
            store.get(&gone.id).is_none(),
            "an empty batch is not a batch"
        );
    }

    #[test]
    fn a_corrupt_file_is_an_empty_store() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join("batches.json"), "{ not json").unwrap();
        let store = BatchStore::load(&dir);
        assert!(store.batch_of("g1").is_none());
        assert!(store.get("batch-1").is_none());
    }
}
