use super::*;

const EXPLORER: &str = "title = \"File Explorer\"\ndescription = \"Browse the files on this system\"\nprogram = \"/usr/bin/gxwi-file-explorer\"\nopens = [\"inode/directory\", \"Text/*\"]\n";

#[test]
fn a_declaration_says_what_it_says_and_the_rest_is_defaulted() {
    let app = Application::parse("dev.peios.gxwi-file-explorer", EXPLORER).unwrap();
    assert_eq!(app.title, "File Explorer");
    assert_eq!(
        app.description.as_deref(),
        Some("Browse the files on this system")
    );
    assert_eq!(app.program, Path::new("/usr/bin/gxwi-file-explorer"));
    assert_eq!(app.icon, "dev.peios.gxwi-file-explorer");
    assert!(app.arguments.is_empty());
    assert!(app.listed);
    assert!(app.opens("inode/directory"));
    assert!(app.opens("text/x-python"));
    assert!(!app.opens("image/png"));
    assert_eq!(
        app.command(Some(Path::new("/home/alice"))).unwrap(),
        (
            PathBuf::from("/usr/bin/gxwi-file-explorer"),
            vec!["/home/alice".to_string()]
        )
    );
}

#[test]
fn what_is_declared_is_taken_and_what_is_unknown_is_ignored() {
    let text = "title = \"Hello\"\nprogram = \"/usr/bin/hello\"\narguments = [\"--wave\"]\nicon = \"dev.peios.gxwi.hello-alt\"\nlisted = false\ncolour = \"blue\"\n";
    let app = Application::parse("dev.peios.gxwi.hello", text).unwrap();
    assert_eq!(app.arguments, ["--wave"]);
    assert_eq!(app.icon, "dev.peios.gxwi.hello-alt");
    assert!(!app.listed);
    assert_eq!(
        app.command(None).unwrap(),
        (PathBuf::from("/usr/bin/hello"), vec!["--wave".to_string()])
    );
}

#[test]
fn what_makes_a_declaration_unusable() {
    assert!(Application::parse("Not An Id", EXPLORER).is_err());
    assert!(
        Application::parse(
            "dev.peios.gxwi-file-explorer",
            "program = \"/usr/bin/gxwi-file-explorer\"\n"
        )
        .is_err()
    );
    assert!(
        Application::parse(
            "dev.peios.gxwi-file-explorer",
            "title = \" \"\nprogram = \"/usr/bin/gxwi-file-explorer\"\n"
        )
        .is_err()
    );
    assert!(
        Application::parse(
            "dev.peios.gxwi-file-explorer",
            "title = \"Two\\nlines\"\nprogram = \"/usr/bin/gxwi-file-explorer\"\n"
        )
        .is_err()
    );
    assert!(
        Application::parse(
            "dev.peios.gxwi-file-explorer",
            "title = \"File Explorer\"\nprogram = \"gxwi-file-explorer\"\n"
        )
        .is_err()
    );
    assert!(
        Application::parse(
            "dev.peios.gxwi-file-explorer",
            "title = \"File Explorer\"\nprogram = \"/usr/bin/gxwi-file-explorer\"\nbroken\n"
        )
        .is_err()
    );
    // What is merely odd is set right instead.
    let odd = Application::parse("dev.peios.gxwi-file-explorer", "title = \"File Explorer\"\nprogram = \"/usr/bin/gxwi-file-explorer\"\nicon = \"Not/An/Id\"\nopens = [\"directory\", \"inode/*\"]\n").unwrap();
    assert_eq!(odd.icon, "dev.peios.gxwi-file-explorer");
    assert_eq!(odd.opens, ["inode/*"]);
}

#[test]
fn a_launcher_lists_by_title_and_id_and_leaves_out_the_unlisted() {
    let declare = |id: &str, title: &str, listed: bool| {
        Application::parse(
            id,
            &format!("title = {title:?}\nprogram = \"/usr/bin/x\"\nlisted = {listed}\n"),
        )
        .unwrap()
    };
    let apps = [
        declare("dev.peios.gxwi-file-explorer", "File Explorer", true),
        declare("dev.peios.gxwi.hello", "Hello", true),
        declare("dev.peios.viewer", "Image viewer", false),
        declare("org.example.hex", "Hex editor", true),
    ];
    let titles = |query: &str| {
        matching(&apps, query)
            .iter()
            .map(|app| app.title.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(titles(""), ["File Explorer", "Hello", "Hex editor"]);
    assert_eq!(titles("he"), ["Hello", "Hex editor"]);
    assert_eq!(titles("EX"), ["File Explorer", "Hex editor"]);
    assert_eq!(titles("gxwi.hello"), ["Hello"]);
    assert!(titles("viewer").is_empty());
}

#[test]
fn the_catalogue_is_the_directory() {
    let dir = std::env::temp_dir().join(format!("gxwi-apps-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = dir.join("program");
    std::fs::write(&program, b"#!/bin/sh\n").unwrap();
    let declare =
        |id: &str, text: String| std::fs::write(dir.join(format!("{id}.toml")), text).unwrap();
    declare(
        "dev.peios.b",
        format!("title = \"B\"\nprogram = {:?}\n", program.display()),
    );
    declare(
        "dev.peios.a",
        format!(
            "title = \"A\"\nprogram = {:?}\nlisted = false\n",
            program.display()
        ),
    );
    declare(
        "dev.peios.gone",
        "title = \"Gone\"\nprogram = \"/nowhere/at/all\"\n".into(),
    );
    declare("dev.peios.broken", "title = 3\n".into());
    std::fs::write(dir.join("notes.txt"), "not a declaration").unwrap();
    let catalogue = Catalogue::at(&dir);
    let read = catalogue.read();
    assert_eq!(
        read.iter().map(|app| app.id.as_str()).collect::<Vec<_>>(),
        ["dev.peios.a", "dev.peios.b"]
    );
    assert_eq!(
        catalogue.get("dev.peios.b").map(|app| app.title),
        Some("B".into())
    );
    assert!(catalogue.get("dev.peios.gone").is_none());
    assert!(catalogue.get("../notes").is_none());
    assert_eq!(
        catalogue.for_program(&program).map(|app| app.id),
        Some("dev.peios.a".into())
    );
    assert!(catalogue.for_program(&dir.join("notes.txt")).is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_type_is_named_as_people_read_it() {
    assert_eq!(type_name("application/x-shellscript"), "Shell script");
    assert_eq!(type_name("inode/directory"), "Folder");
    assert_eq!(type_name("text/*"), "Every text file");
    assert_eq!(type_name("image/*"), "Every image");
    assert_eq!(type_name("text/x-diff"), "Diff text file");
    assert_eq!(type_name("application/vnd.oasis+zip"), "Vnd file");
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("gxwi-{name}-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn native_paths_cannot_alias_literal_replacement_characters_in_commands() {
    use std::os::unix::ffi::OsStringExt;
    let app = Application::parse(
        "dev.peios.editor",
        "title = \"Editor\"\nprogram = \"/usr/bin/editor\"\narguments = [\"--existing\"]\n",
    )
    .unwrap();
    let native = PathBuf::from(std::ffi::OsString::from_vec(b"/tmp/name-\xff".to_vec()));
    let literal = Path::new("/tmp/name-�");
    assert_eq!(native.to_string_lossy(), literal.to_string_lossy());
    assert!(app.command(Some(&native)).unwrap_err().contains("UTF-8"));
    assert_eq!(
        app.command(Some(literal)).unwrap().1,
        ["--existing", "/tmp/name-�"]
    );
    assert_eq!(app.command(None).unwrap().1, ["--existing"]);
}

#[test]
fn catalogue_accepts_exact_limit_and_rejects_one_extra_byte() {
    let directory = TestDirectory::new("declaration-boundary");
    let program = directory.0.join("program");
    std::fs::write(&program, "program").unwrap();
    let mut declaration = format!("title = \"Viewer\"\nprogram = {:?}\n", program);
    declaration.push_str(&" ".repeat(MAX_DECLARATION_BYTES as usize - declaration.len()));
    let path = directory.0.join("dev.peios.viewer.toml");
    let catalogue = Catalogue::at(&directory.0);
    std::fs::write(&path, &declaration).unwrap();
    assert!(catalogue.get("dev.peios.viewer").is_some());
    declaration.push(' ');
    std::fs::write(&path, declaration).unwrap();
    assert!(catalogue.get("dev.peios.viewer").is_none());
}

#[test]
fn catalogue_rejects_named_pipes_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let directory = TestDirectory::new("declaration-fifo");
    let path = directory.0.join("dev.peios.pipe.toml");
    let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: the NUL-terminated path is live and names a new file in our directory.
    assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
    assert!(Catalogue::at(&directory.0).get("dev.peios.pipe").is_none());
}
