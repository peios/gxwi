//! How often a logon may be attempted.
//!
//! The authority has no throttle of its own, so this is the only brake on
//! guessing passwords through GXWI. It lives here rather than in gxwi-server
//! because a compromised server would skip its own.
//!
//! The budget is kept per remote address, as gxwi-server claims it, and never
//! per username: a counter that behaves differently for a name that exists is
//! the account-existence oracle PGSS forbids. The address is only a claim, so
//! a budget for the whole machine stands behind it. That one lets a flood of
//! attempts lock everyone out for a while; the alternative is no brake at all
//! on a server that lies about addresses.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
const PER_ADDRESS: usize = 10;
const WHOLE_MACHINE: usize = 120;
/// Addresses remembered at once. Past this, strangers share one budget, so a
/// server inventing addresses cannot grow the table without bound.
const MAX_ADDRESSES: usize = 1024;
const EVERYONE_ELSE: &str = "";

#[derive(Default)]
pub struct Throttle(Mutex<Attempts>);

#[derive(Default)]
struct Attempts {
    by_address: HashMap<String, VecDeque<Instant>>,
    all: VecDeque<Instant>,
}

impl Throttle {
    /// Whether a logon from `claimed_address` may start now. Saying yes counts
    /// it against both budgets.
    pub fn admit(&self, claimed_address: Option<&str>, now: Instant) -> bool {
        let mut attempts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let attempts = &mut *attempts;

        expire(&mut attempts.all, now);
        attempts.by_address.retain(|_, starts| {
            expire(starts, now);
            !starts.is_empty()
        });
        if attempts.all.len() >= WHOLE_MACHINE {
            return false;
        }

        let mut key = claimed_address.unwrap_or(EVERYONE_ELSE);
        if !attempts.by_address.contains_key(key) && attempts.by_address.len() >= MAX_ADDRESSES {
            key = EVERYONE_ELSE;
        }
        let starts = attempts.by_address.entry(key.to_string()).or_default();
        if starts.len() >= PER_ADDRESS {
            return false;
        }
        starts.push_back(now);
        attempts.all.push_back(now);
        true
    }
}

fn expire(starts: &mut VecDeque<Instant>, now: Instant) {
    while starts
        .front()
        .is_some_and(|&t| now.duration_since(t) >= WINDOW)
    {
        starts.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_address_runs_out_without_touching_another() {
        let throttle = Throttle::default();
        let now = Instant::now();
        for _ in 0..PER_ADDRESS {
            assert!(throttle.admit(Some("203.0.113.7"), now));
        }
        assert!(!throttle.admit(Some("203.0.113.7"), now));
        assert!(throttle.admit(Some("203.0.113.8"), now));
    }

    #[test]
    fn a_budget_comes_back_after_the_window() {
        let throttle = Throttle::default();
        let now = Instant::now();
        for _ in 0..PER_ADDRESS {
            throttle.admit(Some("203.0.113.7"), now);
        }
        assert!(!throttle.admit(Some("203.0.113.7"), now + WINDOW - Duration::from_secs(1)));
        assert!(throttle.admit(Some("203.0.113.7"), now + WINDOW));
    }

    #[test]
    fn invented_addresses_run_into_the_machines_budget() {
        let throttle = Throttle::default();
        let now = Instant::now();
        let admitted = (0..WHOLE_MACHINE * 2)
            .filter(|i| throttle.admit(Some(&format!("198.51.100.{i}")), now))
            .count();
        assert_eq!(admitted, WHOLE_MACHINE);
    }

    #[test]
    fn a_refusal_is_not_counted() {
        let throttle = Throttle::default();
        let now = Instant::now();
        for _ in 0..PER_ADDRESS * 3 {
            throttle.admit(Some("203.0.113.7"), now);
        }
        let attempts = throttle.0.lock().unwrap();
        assert_eq!(attempts.all.len(), PER_ADDRESS);
    }
}
