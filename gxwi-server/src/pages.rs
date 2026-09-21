//! The logon pages. Plain HTML forms and no script at all: every page is served
//! under a policy that forbids script, so nothing injected into one can run.
//!
//! The pages render what the authority sends without understanding it. A
//! prompt's name is a label and its type says how to collect the answer;
//! nothing here knows what a password is for.

use libauthd::wire::{CredentialRequest, CredentialType, Denial, MessageSeverity};

pub const STYLESHEET: &str = include_str!("logon.css");

/// Field names in the forms these pages post.
pub const FIELD_USERNAME: &str = "username";
pub const FIELD_FORM_TOKEN: &str = "t";
pub fn field_for_prompt(credential_ref: u32) -> String {
    format!("c{credential_ref}")
}

pub fn username(error: Option<&str>) -> String {
    let mut body = String::new();
    if let Some(error) = error {
        body.push_str(&format!("<p class=\"message error\">{}</p>", escape(error)));
    }
    body.push_str(&format!(
        "<form method=\"post\" action=\"/logon\">\
         <label for=\"{FIELD_USERNAME}\">Username</label>\
         <input id=\"{FIELD_USERNAME}\" name=\"{FIELD_USERNAME}\" type=\"text\" \
         autocomplete=\"username\" autocapitalize=\"none\" spellcheck=\"false\" required autofocus>\
         <button type=\"submit\">Next</button>\
         </form>"
    ));
    page(&body)
}

/// One round of the conversation: the authority's messages, in order and
/// before its prompts, then a field for each prompt.
pub fn ask(username: &str, form_token: &str, request: &CredentialRequest) -> String {
    let mut body = String::new();
    for message in &request.messages {
        let class = match message.severity {
            MessageSeverity::Info => "info",
            MessageSeverity::Error => "error",
        };
        body.push_str(&format!("<p class=\"message {class}\">{}</p>", escape(&message.text)));
    }
    body.push_str("<form method=\"post\" action=\"/logon/answer\">");
    body.push_str(&format!(
        "<input type=\"hidden\" name=\"{FIELD_FORM_TOKEN}\" value=\"{}\">",
        escape(form_token)
    ));
    // Shown, and never read back: it is here so a password manager files the
    // password under the right name.
    body.push_str(&format!(
        "<label for=\"who\">Signing in as</label>\
         <input id=\"who\" class=\"who\" type=\"text\" value=\"{}\" autocomplete=\"username\" readonly>",
        escape(username)
    ));
    for (i, prompt) in request.prompts.iter().enumerate() {
        let field = field_for_prompt(prompt.credential_ref);
        let (kind, autocomplete) = match prompt.credential_type {
            // PGSS: a password is collected without echo.
            CredentialType::Password => ("password", "current-password"),
        };
        body.push_str(&format!(
            "<label for=\"{field}\">{}</label>\
             <input id=\"{field}\" name=\"{field}\" type=\"{kind}\" autocomplete=\"{autocomplete}\"{}>",
            escape(&prompt.credential_name),
            if i == 0 { " autofocus" } else { "" },
        ));
    }
    let button = if request.prompts.is_empty() { "Continue" } else { "Sign in" };
    body.push_str(&format!("<button type=\"submit\">{button}</button></form>"));
    body.push_str("<p class=\"aside\"><a href=\"/logon\">Not you?</a></p>");
    page(&body)
}

pub fn granted(name: &str) -> String {
    page(&format!(
        "<p class=\"message info\">Signed in as {}.</p>\
         <p class=\"aside\">GXWI has no session to show you yet.</p>\
         <p class=\"aside\"><a href=\"/logon\">Sign in again</a></p>",
        escape(name)
    ))
}

pub fn denied(denial: Denial, reason: &str) -> String {
    // The authority's reason is for the user to read, except where it could
    // only narrow what a failed authentication means.
    let text = match denial {
        Denial::AuthenticationFailed => "Incorrect username or password.",
        _ if !reason.is_empty() => reason,
        Denial::AccountRestricted => "That account cannot sign in here.",
        Denial::LogonTypeNotPermitted => "That account cannot sign in this way.",
        Denial::ConversationLimit => "Too many sign-in attempts, or too slow. Wait a minute and try again.",
        Denial::AuthorityUnavailable => "Sign-in is unavailable right now.",
        _ => "Sign-in failed.",
    };
    page(&format!(
        "<p class=\"message error\">{}</p><p class=\"aside\"><a href=\"/logon\">Try again</a></p>",
        escape(text)
    ))
}

pub fn unavailable(why: &str) -> String {
    page(&format!(
        "<p class=\"message error\">{}</p><p class=\"aside\"><a href=\"/logon\">Try again</a></p>",
        escape(why)
    ))
}

fn page(body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>Sign in</title><link rel=\"stylesheet\" href=\"/logon.css\"></head>\
         <body><main><h1>Sign in</h1>{body}</main></body></html>"
    )
}

/// Everything the authority or the user supplied goes through here on its way
/// into a page, attribute values included.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use libauthd::wire::{Message, Prompt};

    #[test]
    fn what_the_authority_says_cannot_become_markup() {
        let request = CredentialRequest {
            messages: vec![Message {
                severity: MessageSeverity::Info,
                text: "<script>alert(1)</script>".into(),
            }],
            prompts: vec![Prompt {
                credential_ref: 7,
                credential_type: CredentialType::Password,
                credential_name: "\"><img src=x>".into(),
            }],
        };
        let html = ask("al\"ice", "tok", &request);
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("value=\"al&quot;ice\""));
        assert!(html.contains("name=\"c7\" type=\"password\""));
    }

    #[test]
    fn a_failed_authentication_always_reads_the_same() {
        let a = denied(Denial::AuthenticationFailed, "");
        let b = denied(Denial::AuthenticationFailed, "no such user");
        assert_eq!(a, b);
    }

    #[test]
    fn a_round_with_no_prompts_offers_to_continue() {
        let request = CredentialRequest { messages: vec![], prompts: vec![] };
        assert!(ask("alice", "tok", &request).contains(">Continue<"));
    }
}
