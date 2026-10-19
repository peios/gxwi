use super::*;

// This very test program carries a name, as an app would.
crate::icon!(b"dev.peios.gxwi.test");

fn theme(dir: &Path, ids: &[&str]) {
    std::fs::create_dir_all(dir).unwrap();
    for id in ids {
        std::fs::write(dir.join(format!("{id}.svg")), "<svg/>").unwrap();
    }
}

#[test]
fn a_name_is_lowercase_and_plain() {
    assert!(is_id("dev.peios.gxwi.hello"));
    assert!(is_id("directory-node_modules"));
    assert!(is_id("file-.gitignore"));
    assert!(!is_id("Documents"));
    assert!(!is_id("my photos"));
    assert!(!is_id(""));
    assert!(!is_id("-x"));
    assert!(!is_id(&"a".repeat(MAX_ID_BYTES + 1)));
}

#[test]
fn a_media_type_names_itself_and_then_its_family() {
    assert_eq!(type_ids("text/x-python"), ["text-x-python", "text"]);
    assert_eq!(type_ids("image/svg+xml"), ["image-svg-xml", "image"]);
    assert_eq!(type_ids("inode/directory"), ["inode-directory", "inode"]);
}

#[test]
fn the_program_says_what_it_looks_like_and_the_owner_overrules_it() {
    let root = std::env::temp_dir().join(format!("gxwi-icons-{}", std::process::id()));
    let base = root.join("base");
    theme(
        &base,
        &[
            "generic",
            "dev.peios.gxwi.test",
            "application-x-executable",
            "text",
            "inode-directory",
            "directory-documents",
            "file-makefile",
            "file-.gitignore",
        ],
    );
    let themes = Themes::of(vec![base.clone()]);

    // The test binary itself, which carries a name in its section, by
    // its path and as a running program is reached.
    let me = std::env::current_exe().unwrap();
    assert_eq!(identify(&me, &themes), "dev.peios.gxwi.test");
    let name = me.file_name().unwrap().to_str().unwrap();
    assert_eq!(
        identify_named(Path::new("/proc/self/exe"), name, &themes),
        "dev.peios.gxwi.test"
    );
    // Without that icon in the chain, it is a program like any other.
    std::fs::remove_file(base.join("dev.peios.gxwi.test.svg")).unwrap();
    assert_eq!(identify(&me, &themes), "application-x-executable");

    // Files by name and by type, and a directory by name.
    std::fs::write(root.join("notes.py"), "").unwrap();
    assert_eq!(identify(&root.join("notes.py"), &themes), "text");
    std::fs::write(root.join("Makefile"), "").unwrap();
    assert_eq!(identify(&root.join("Makefile"), &themes), "file-makefile");
    std::fs::write(root.join(".gitignore"), "").unwrap();
    assert_eq!(
        identify(&root.join(".gitignore"), &themes),
        "file-.gitignore"
    );
    std::fs::create_dir(root.join("Documents")).unwrap();
    assert_eq!(
        identify(&root.join("Documents"), &themes),
        "directory-documents"
    );
    std::fs::create_dir(root.join("My Photos")).unwrap();
    assert_eq!(
        identify(&root.join("My Photos"), &themes),
        "inode-directory"
    );
    std::fs::write(root.join("thing.xyz"), "").unwrap();
    assert_eq!(identify(&root.join("thing.xyz"), &themes), "generic");
    assert_eq!(identify(&root.join("nowhere"), &themes), "generic");

    // The owner's word, where the filesystem keeps one.
    let cpath = std::ffi::CString::new(root.join("Documents").to_str().unwrap()).unwrap();
    let name = std::ffi::CString::new(XATTR).unwrap();
    let said = b"text";
    let set = unsafe {
        libc::setxattr(
            cpath.as_ptr(),
            name.as_ptr(),
            said.as_ptr().cast(),
            said.len(),
            0,
        )
    };
    if set == 0 {
        assert_eq!(identify(&root.join("Documents"), &themes), "text");
    }

    // A theme ahead of the base overrides it, and the base is still there.
    let dark = root.join("dark");
    theme(&dark, &["text"]);
    let chain = Themes::of(vec![dark.clone(), base.clone()]);
    assert_eq!(chain.find("text").unwrap(), dark.join("text.svg"));
    assert_eq!(chain.find("generic").unwrap(), base.join("generic.svg"));
    assert!(chain.find("../etc/passwd").is_none());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn elf_probe_rejects_an_opened_pipe_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let directory = std::env::temp_dir().join(format!("gxwi-icon-fifo-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("icon");
    let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: the NUL-terminated path is live and names a new file in our directory.
    assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
    assert!(elf::section(&path, SECTION).is_none());
    std::fs::remove_dir_all(directory).unwrap();
}
