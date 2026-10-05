//! Resource reads and prompt gets (contract, 3.5).
//!
//! rmcp keeps no registry of its own for these: a server answers `resources/read` and `prompts/get` in its own
//! `ServerHandler`, and lists what it has through the same trait. Before a read or a get runs, the wrapper asks the
//! server for those lists, through the methods it would answer a client's listing with, and names the call from
//! them: a resource at a fixed address by that address, one read through a template by the template (never the
//! address the client sent), an address the server lists nothing for by its scheme alone, a prompt by its name.

use rmcp::model::{
    ErrorCode, GetPromptRequestParams, GetPromptResponse, JsonObject, PaginatedRequestParams,
    ReadResourceRequestParams, ReadResourceResponse,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::{Map, Value};

use crate::collector::{self, Call, Outcome};
use crate::instrument::{CatchUnwind, Instrumented, from_panic};
use crate::text;

/// Lists are followed this many pages at most, so a server with a vast catalogue costs a read a bounded lookup.
const MAX_LIST_PAGES: usize = 20;

/// How rmcp's prompt router words arguments it could not deserialize, before the prompt runs.
const PROMPT_ARGUMENTS_REFUSED: [&str; 2] = ["Failed to parse parameters:", "Missing required parameters:"];

/// The scheme of an address, which is all of an unknown one that may be kept: `db://`.
pub(crate) fn scheme_of(uri: &str) -> String {
    let scheme = uri.split_once(':').map(|(scheme, _)| scheme).unwrap_or_default();
    let valid = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if valid {
        format!("{scheme}://")
    } else {
        "unknown://".into()
    }
}

/// The variables of a URI template (RFC 6570) the address matches, or None. Covers simple, reserved (`{+var}`)
/// and fragment expansions and a query (`{?a,b}`), which is what servers declare; a template this cannot read
/// matches nothing, and the read is named by its scheme instead.
pub(crate) fn template_match(template: &str, uri: &str) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut rest = uri;
    let mut remaining = template;

    while !remaining.is_empty() {
        match remaining.find('{') {
            Some(0) => {
                let end = remaining.find('}')?;
                let expression = &remaining[1..end];
                remaining = &remaining[end + 1..];
                let (operator, variables) = match expression.chars().next() {
                    Some(c @ ('+' | '#' | '?' | '&' | '/' | '.' | ';')) => (Some(c), &expression[1..]),
                    _ => (None, expression),
                };
                let variables: Vec<String> = variables
                    .split(',')
                    .map(|name| {
                        name.split(':')
                            .next()
                            .unwrap_or_default()
                            .trim_end_matches('*')
                            .to_owned()
                    })
                    .filter(|name| !name.is_empty())
                    .collect();
                if operator == Some('?') || operator == Some('&') {
                    // A query is optional, and runs to the end or the next literal.
                    let stop = remaining
                        .chars()
                        .next()
                        .and_then(|c| rest.find(c))
                        .unwrap_or(rest.len());
                    rest = &rest[stop..];
                    names.extend(variables);
                    continue;
                }
                let stop_at = remaining.find('{').map_or(remaining, |i| &remaining[..i]);
                let allow_slash = matches!(operator, Some('+' | '#' | '/'));
                let value_end = if stop_at.is_empty() {
                    if allow_slash {
                        rest.len()
                    } else {
                        rest.find('/').unwrap_or(rest.len())
                    }
                } else {
                    let found = rest.find(stop_at)?;
                    if !allow_slash && rest[..found].contains('/') {
                        return None;
                    }
                    found
                };
                if value_end == 0 {
                    return None;
                }
                rest = &rest[value_end..];
                names.extend(variables);
            }
            found => {
                let literal_end = found.unwrap_or(remaining.len());
                let literal = &remaining[..literal_end];
                rest = rest.strip_prefix(literal)?;
                remaining = &remaining[literal_end..];
            }
        }
    }

    rest.is_empty().then_some(names)
}

impl<S: ServerHandler> Instrumented<S> {
    /// Calls the server's own `read_resource`, and records how it went.
    pub(crate) async fn measure_read(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if !collector::collecting() {
            return self.inner.read_resource(request, context).await;
        }
        let (name, exists, variables) = self.name_resource(&request.uri, &context).await;
        let call = self.begin_primitive("resource", &name, variables.as_ref(), &context);
        let answer = CatchUnwind(Box::pin(self.inner.read_resource(request, context))).await;
        match answer {
            Ok(result) => {
                if let Some(call) = call {
                    let outcome = match &result {
                        Ok(ReadResourceResponse::InputRequired(_)) => None,
                        Ok(_) => Some(Outcome::Success),
                        Err(_) if !exists => Some(Outcome::Unknown("unknown_resource")),
                        Err(error) => Some(exception(error)),
                    };
                    if let Some(outcome) = outcome {
                        let size = match &result {
                            Ok(ReadResourceResponse::Complete(answer)) => collector::response_bytes(answer),
                            _ => None,
                        };
                        collector::record_answered(call, outcome, size);
                    }
                }
                result
            }
            Err(panic) => {
                if let Some(call) = call {
                    collector::record(call, from_panic(&*panic));
                }
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// Calls the server's own `get_prompt`, and records how it went.
    pub(crate) async fn measure_prompt(
        &self,
        request: GetPromptRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        if !collector::collecting() {
            return self.inner.get_prompt(request, context).await;
        }
        let exists = self.has_prompt(&request.name, &context).await;
        let call = self.begin_primitive("prompt", &request.name, request.arguments.as_ref(), &context);
        let answer = CatchUnwind(Box::pin(self.inner.get_prompt(request, context))).await;
        match answer {
            Ok(result) => {
                if let Some(call) = call {
                    let outcome = match &result {
                        Ok(GetPromptResponse::InputRequired(_)) => None,
                        Ok(_) => Some(Outcome::Success),
                        Err(_) if !exists => Some(Outcome::Unknown("unknown_prompt")),
                        Err(error)
                            if error.code == ErrorCode::INVALID_PARAMS
                                && PROMPT_ARGUMENTS_REFUSED
                                    .iter()
                                    .any(|prefix| error.message.starts_with(prefix)) =>
                        {
                            Some(Outcome::Arguments)
                        }
                        Err(error) => Some(exception(error)),
                    };
                    if let Some(outcome) = outcome {
                        let size = match &result {
                            Ok(GetPromptResponse::Complete(answer)) => collector::response_bytes(answer),
                            _ => None,
                        };
                        collector::record_answered(call, outcome, size);
                    }
                }
                result
            }
            Err(panic) => {
                if let Some(call) = call {
                    collector::record(call, from_panic(&*panic));
                }
                std::panic::resume_unwind(panic)
            }
        }
    }

    fn begin_primitive(
        &self,
        kind: &'static str,
        name: &str,
        arguments: Option<&JsonObject>,
        context: &RequestContext<RoleServer>,
    ) -> Option<Call> {
        let mut call = self.begin(name, arguments, context)?;
        call.kind = Some(kind);
        Some(call)
    }

    async fn name_resource(
        &self,
        uri: &str,
        context: &RequestContext<RoleServer>,
    ) -> (String, bool, Option<JsonObject>) {
        let mut cursor = None;
        for _ in 0..MAX_LIST_PAGES {
            let Ok(list) = self.inner.list_resources(page(cursor.take()), context.clone()).await else {
                break;
            };
            if list.resources.iter().any(|resource| resource.uri == uri) {
                return (uri.to_owned(), true, None);
            }
            match list.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        let mut cursor = None;
        for _ in 0..MAX_LIST_PAGES {
            let Ok(list) = self
                .inner
                .list_resource_templates(page(cursor.take()), context.clone())
                .await
            else {
                break;
            };
            for template in &list.resource_templates {
                if let Some(names) = template_match(&template.uri_template, uri) {
                    // Names only, each a string: the values are what the client sent.
                    let variables: Map<String, Value> = names
                        .into_iter()
                        .map(|name| (name, Value::String(String::new())))
                        .collect();
                    return (template.uri_template.clone(), true, Some(variables));
                }
            }
            match list.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }

        (scheme_of(uri), false, None)
    }

    async fn has_prompt(&self, name: &str, context: &RequestContext<RoleServer>) -> bool {
        let mut cursor = None;
        for _ in 0..MAX_LIST_PAGES {
            let Ok(list) = self.inner.list_prompts(page(cursor.take()), context.clone()).await else {
                return false;
            };
            if list.prompts.iter().any(|prompt| prompt.name == name) {
                return true;
            }
            match list.next_cursor {
                Some(next) => cursor = Some(next),
                None => return false,
            }
        }
        false
    }
}

fn page(cursor: Option<String>) -> Option<PaginatedRequestParams> {
    cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)))
}

fn exception(error: &ErrorData) -> Outcome {
    Outcome::Exception {
        error_type: crate::instrument::error_type(error.code),
        message: text::truncate(&error.message, text::MAX_EXCEPTION_MESSAGE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_nothing_of_an_address_past_its_scheme() {
        assert_eq!(scheme_of("db://customers/4412"), "db://");
        assert_eq!(scheme_of("file:///home/ada/cv.pdf"), "file://");
        assert_eq!(scheme_of("customers/4412"), "unknown://");
        assert_eq!(scheme_of("4412:secret"), "unknown://");
    }

    #[test]
    fn matches_a_template_and_names_its_variables() {
        assert_eq!(
            template_match("trips://{id}", "trips://42"),
            Some(vec!["id".to_owned()])
        );
        assert_eq!(
            template_match("users://{user}/pages/{+page}", "users://ada/pages/a/b"),
            Some(vec!["user".to_owned(), "page".to_owned()])
        );
        assert_eq!(
            template_match("search://q{?term,page}", "search://q?term=x"),
            Some(vec!["term".to_owned(), "page".to_owned()])
        );
        assert_eq!(template_match("config://app", "config://app"), Some(vec![]));
    }

    #[test]
    fn matches_nothing_it_should_not() {
        assert_eq!(template_match("trips://{id}", "trips://42/extra"), None);
        assert_eq!(template_match("trips://{id}", "trips://"), None);
        assert_eq!(template_match("trips://{id}", "hotels://42"), None);
        assert_eq!(template_match("trips://{id", "trips://42"), None);
    }
}
