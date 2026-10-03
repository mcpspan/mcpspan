//! Posting batches to the ingest API. It neither retries nor swallows.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::event::{Event, batch};

/// How long one delivery attempt may take.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(10);
/// The longest Retry-After followed: a server asking for longer is wrong or unwell.
pub(crate) const MAX_RETRY_AFTER: Duration = Duration::from_secs(300);

/// A delivery that did not succeed, and whether sending the same batch again could work.
#[derive(Debug, Clone)]
pub(crate) struct Failure {
    pub message: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub retry_after: Duration,
}

/// Something that delivers one batch; the HTTP client, or a stand-in in tests.
pub(crate) type Sender = Box<dyn Fn(&[Event]) -> Result<(), Failure> + Send + Sync>;

/// The sender that posts to the ingest API over HTTP.
pub(crate) fn http_sender(endpoint: &str, api_key: &str) -> Sender {
    let url = format!("{}/v1/events", endpoint.trim_end_matches('/'));
    let authorization = format!("Bearer {api_key}");
    // No redirects: a redirected POST delivers nothing while looking like it did.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();

    Box::new(move |events| {
        let response = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", &authorization)
            .header("User-Agent", concat!("mcpspan/", env!("CARGO_PKG_VERSION"), " (rust)"))
            .send(batch(events));

        let response = response.map_err(|error| Failure {
            // Unreachable, reset, timed out: the moment, not the batch.
            message: format!("failed to reach {url} ({error})"),
            status: None,
            retryable: true,
            retry_after: Duration::ZERO,
        })?;

        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map_or(Duration::ZERO, |value| retry_after(value, SystemTime::now()));
        Err(Failure {
            message: format!("ingest API answered {status}"),
            status: Some(status),
            retryable: status == 408 || status == 429 || status >= 500,
            retry_after,
        })
    })
}

/// Retry-After in either form, whole seconds or an HTTP date. Zero leaves the SDK's own backoff to decide.
pub(crate) fn retry_after(value: &str, now: SystemTime) -> Duration {
    let value = value.trim();
    let wait = if let Ok(seconds) = value.parse::<u64>() {
        Duration::from_secs(seconds)
    } else if let Some(at) = parse_http_date(value) {
        at.duration_since(now).unwrap_or(Duration::ZERO)
    } else {
        return Duration::ZERO;
    };
    wait.min(MAX_RETRY_AFTER)
}

/// An IMF-fixdate, `Sun, 06 Nov 1994 08:49:37 GMT`, the form HTTP servers send.
fn parse_http_date(value: &str) -> Option<SystemTime> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let [_, day, month, year, time, "GMT"] = parts.as_slice() else {
        return None;
    };
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| m == month)? as i64
        + 1;
    let (day, year): (i64, i64) = (day.parse().ok()?, year.parse().ok()?);
    let clock: Vec<i64> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [hours, minutes, seconds] = clock.as_slice() else {
        return None;
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
    u64::try_from(seconds).ok().map(|s| UNIX_EPOCH + Duration::from_secs(s))
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date of a count of days since 1970-01-01.
pub(crate) fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// A time as ISO 8601 in UTC, to the millisecond.
pub(crate) fn iso8601(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60,
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps_in_utc() {
        let at = UNIX_EPOCH + Duration::from_millis(1_790_431_997_672);
        assert_eq!(iso8601(at), "2026-09-26T14:13:17.672Z");
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn reads_retry_after_in_both_forms_and_caps_it() {
        let now = UNIX_EPOCH + Duration::from_secs(1_767_225_600); // 2026-01-01T00:00:00Z
        assert_eq!(retry_after("12", now), Duration::from_secs(12));
        assert_eq!(
            retry_after("Thu, 01 Jan 2026 00:00:30 GMT", now),
            Duration::from_secs(30)
        );
        assert_eq!(retry_after("99999", now), MAX_RETRY_AFTER);
        assert_eq!(retry_after("soon", now), Duration::ZERO);
    }
}
