//! The logon pages. Plain HTML forms that need no script. Every page is served
//! under a policy that runs one script, named by hash, and nothing else, so
//! nothing injected into a page can run; what that script adds is a nicety.
//!
//! The pages render what the authority sends without understanding it. A
//! prompt's name is a label and its type says how to collect the answer;
//! nothing here knows what a password is for.

use libauthd::wire::{CredentialRequest, CredentialType, Denial, MessageSeverity};

pub const STYLESHEET: &str = include_str!("logon.css");
/// Inlined into the pages that want it, and the one script their policy lets
/// run: the policy names it by the hash of these bytes.
pub const SCRIPT: &str = include_str!("logon.js");
/// Latin subsets, under the licences beside them. Served from here because a
/// logon page may fetch from nowhere else, and a server may have no route out.
pub const FONT_TEXT: &[u8] = include_bytes!("fonts/manrope.woff2");
pub const FONT_DISPLAY: &[u8] = include_bytes!("fonts/schibsted-grotesk.woff2");

/// Field names in the forms these pages post.
pub const FIELD_USERNAME: &str = "username";
pub const FIELD_FORM_TOKEN: &str = "t";
/// How lpsd, the local account store, opens the message naming who is logging on.
const WHO_PREFIX: &str = "Logging in as ";

pub fn field_for_prompt(credential_ref: u32) -> String {
    format!("c{credential_ref}")
}

pub fn username(error: Option<&str>) -> String {
    let mut body = String::new();
    if let Some(error) = error {
        body.push_str(&message("error", error));
    }
    body.push_str(&format!(
        "<form method=\"post\">\
         <label for=\"{FIELD_USERNAME}\">Username</label>\
         <input id=\"{FIELD_USERNAME}\" name=\"{FIELD_USERNAME}\" type=\"text\" \
         autocomplete=\"username\" autocapitalize=\"none\" spellcheck=\"false\" required autofocus>\
         <button class=\"primary\" type=\"submit\">Next</button>\
         </form>"
    ));
    page("Sign in", &card(&body))
}

/// One round of the conversation: the authority's messages, in order and
/// before its prompts, then a field for each prompt.
pub fn ask(username: &str, form_token: &str, request: &CredentialRequest) -> String {
    // An authority that says who is logging on says it in the pill, so the name
    // there is the authority's rendering of it rather than what was typed.
    // This reads a message's text, which PGSS Logon tells a client not to do
    // (client obligation 11). It stands until the protocol can say who is
    // logging on in a field of its own, and anything else is shown as sent.
    let named = request.messages.iter().position(|m| {
        m.severity == MessageSeverity::Info && m.text.strip_prefix(WHO_PREFIX).is_some_and(|name| !name.is_empty())
    });
    let who = named.map_or(username, |i| &request.messages[i].text[WHO_PREFIX.len()..]);

    let mut body = String::new();
    for (i, m) in request.messages.iter().enumerate() {
        if Some(i) == named {
            continue;
        }
        let class = match m.severity {
            MessageSeverity::Info => "info",
            MessageSeverity::Error => "error",
        };
        body.push_str(&message(class, &m.text));
    }
    body.push_str("<form method=\"post\">");
    body.push_str(&format!(
        "<input type=\"hidden\" name=\"{FIELD_FORM_TOKEN}\" value=\"{}\">",
        escape(form_token)
    ));
    // Shown, and never read back: it is here so a password manager files the
    // password under the right name. The initial is of a name given before
    // anything was checked, so it says nothing about whether the account exists.
    let initial: String = who.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    body.push_str(&format!(
        "<label for=\"who\">Logging on as</label>\
         <div class=\"who\"><span class=\"initial\" aria-hidden=\"true\">{}</span>\
         <input id=\"who\" type=\"text\" value=\"{}\" autocomplete=\"username\" readonly>\
         <a href=\"\">Not you?</a></div>",
        escape(&initial),
        escape(who)
    ));
    for (i, prompt) in request.prompts.iter().enumerate() {
        let field = field_for_prompt(prompt.credential_ref);
        let (kind, autocomplete) = match prompt.credential_type {
            // PGSS: a password is collected without echo.
            CredentialType::Password => ("password", "current-password"),
        };
        // The button to show what was typed stays hidden unless the script
        // runs, since without the script it would do nothing.
        let name = escape(&prompt.credential_name);
        body.push_str(&format!(
            "<label for=\"{field}\">{name}</label>\
             <div class=\"secret\">\
             <input id=\"{field}\" name=\"{field}\" type=\"{kind}\" autocomplete=\"{autocomplete}\"{}>\
             <button class=\"reveal\" type=\"button\" aria-label=\"Show {name}\" aria-pressed=\"false\" hidden>\
             {ICON_EYE}</button></div>",
            if i == 0 { " autofocus" } else { "" },
        ));
    }
    let button = if request.prompts.is_empty() { "Continue" } else { "Sign in" };
    body.push_str(&format!("<button class=\"primary\" type=\"submit\">{button}</button></form>"));
    if !request.prompts.is_empty() {
        body.push_str(&format!("<script>{SCRIPT}</script>"));
    }
    page("Sign in", &card(&body))
}

pub fn granted(name: &str) -> String {
    let body = format!(
        "<div class=\"done\"><div class=\"mark\">{ICON_CHECK}</div>\
         <h2>Signed in as {}.</h2>\
         <p>Your session could not be started, so there is nothing to show you.</p>\
         <a class=\"secondary\" href=\"\">Sign in again</a></div>",
        escape(name)
    );
    page("Signed in", &card(&body))
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
    unavailable(text)
}

pub fn unavailable(why: &str) -> String {
    let body = format!("{}<a class=\"primary\" href=\"\">Try again</a>", message("error", why));
    page("Cannot sign in", &card(&body))
}

const ICON_MARK: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\">\
    <rect x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" rx=\"5.5\" stroke=\"currentColor\" stroke-width=\"2\"/>\
    <path d=\"M8.5 8h7.5v5h-4v3.5H8.5z\" fill=\"currentColor\"/></svg>";
const ICON_ALERT: &str = "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" \
    stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\">\
    <circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 4.75v3.5M8 11v.25\"/></svg>";
const ICON_EYE: &str = "<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" \
    stroke-width=\"1.25\" stroke-linejoin=\"round\" aria-hidden=\"true\">\
    <path d=\"M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z\"/>\
    <circle cx=\"8\" cy=\"8\" r=\"2\"/></svg>";
const ICON_CHECK: &str ="<svg viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" \
    stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">\
    <path d=\"M3.5 8.5l3 3 6-6.5\"/></svg>";

fn message(class: &str, text: &str) -> String {
    let icon = if class == "error" { ICON_ALERT } else { "" };
    format!("<p class=\"message {class}\">{icon}<span>{}</span></p>", escape(text))
}

fn card(body: &str) -> String {
    format!("<section class=\"card\">{body}</section>")
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}</title><link rel=\"stylesheet\" href=\"/.gxwi/logon.css\"></head>\
         <body><main><div class=\"brand\">{ICON_MARK}<span>Peios</span></div>\
         <h1>{title}</h1>{body}</main></body></html>"
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
        // The page's own script is the only one in it.
        assert_eq!(html.matches("<script").count(), 1);
        assert!(html.contains(&format!("<script>{SCRIPT}</script>")));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("value=\"al&quot;ice\""));
        assert!(html.contains("name=\"c7\" type=\"password\""));
    }

    #[test]
    fn the_authoritys_naming_of_the_user_goes_in_the_pill() {
        let say = |text: &str| CredentialRequest {
            messages: vec![Message { severity: MessageSeverity::Info, text: text.into() }],
            prompts: vec![],
        };
        let html = ask("alice", "tok", &say("Logging in as alice@corp"));
        assert!(html.contains("value=\"alice@corp\""));
        assert!(!html.contains("class=\"message"));

        // Anything else is shown as it was sent, beside what was typed.
        for other in ["Logging in as ", "You are logging in as alice", "Password expires soon"] {
            let html = ask("alice", "tok", &say(other));
            assert!(html.contains("value=\"alice\""));
            assert!(html.contains("class=\"message info\""));
        }
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
