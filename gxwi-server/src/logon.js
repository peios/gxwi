// The only script the logon pages run, and they work without it. The policy
// they are served under names these exact bytes by hash; change one and the
// test beside the hash says what it has become.
for (const button of document.querySelectorAll("button.reveal")) {
    const field = button.previousElementSibling;
    const show = (on) => {
        field.type = on ? "text" : "password";
        button.setAttribute("aria-pressed", String(on));
    };
    button.hidden = false;
    button.addEventListener("click", () => {
        show(field.type === "password");
        field.focus();
    });
    // A browser remembers what is typed into text fields. Not this.
    field.form.addEventListener("submit", () => show(false));
}
